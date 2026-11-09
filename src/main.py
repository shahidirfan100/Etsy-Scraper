"""Etsy search scraper.

Python port of the original Node.js/CamoFox actor. Requests go through Scrapling's
stealth browser session (Patchright Chromium), which is the transport layer; extraction
and the dataset contract are unchanged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import pathlib
import random
import re
import secrets
import time
from contextlib import suppress
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs, parse_qsl, unquote, urlencode, urlsplit, urlunsplit

from apify import Actor
from scrapling.fetchers import AsyncStealthySession
from scrapling.parser import Selector

# Scrapling logs every fetch and Cloudflare probe at INFO; report attempts ourselves.
logging.getLogger('scrapling').setLevel(logging.CRITICAL)

MAX_PAGES_CAP = 50
INTERNAL_REQUEST_DELAY_MS = 350
INTERNAL_MAX_REQUEST_RETRIES = 1
INTERNAL_MAX_SESSION_ROTATIONS = 3
INTERNAL_FETCH_TIMEOUT_MS = 60000
MIN_EXPECTED_PRODUCTS_PER_FULL_PAGE = 12
TARGET_PRODUCTS_PER_PAGE = 48

LISTING_READY_SELECTOR = 'a[href*="/listing/"], div[data-listing-id], li[data-listing-id]'
LISTING_CARDS_API_MARKER = '/api/v3/ajax/bespoke/member/neu/specs/listingCards'

CHALLENGE_MARKERS = (
    'captcha-delivery.com',
    'please enable js and disable any ad blocker',
    'verification',
    'too many requests',
    'request blocked',
    'access denied',
    'are you human',
    'cf-challenge',
    'pardon our interruption',
    'unusual traffic',
    'security issue',
)

CARD_SELECTORS = (
    'div[data-appears-component-name="search2_organic_listings_group"] div[data-listing-id]',
    'li.wt-list-unstyled div[data-listing-id]',
    '.v2-listing-card[data-listing-id]',
    'div[data-listing-id], li[data-listing-id]',
)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def clean_text(value: Any) -> str:
    return re.sub(r'\s+', ' ', str(value or '')).strip()


def parse_compact_number(raw: Any) -> int | None:
    if not raw:
        return None
    text = str(raw).strip().lower().replace(',', '')
    match = re.search(r'(\d+(?:\.\d+)?)([km])?', text, re.I)
    if not match:
        return None
    base = float(match.group(1))
    suffix = (match.group(2) or '').lower()
    if suffix == 'k':
        return round(base * 1000)
    if suffix == 'm':
        return round(base * 1000000)
    return round(base)


def js_number(value: Any) -> int | float | None:
    """Return the value as a JS Number would, or None where JS would produce NaN."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float('inf'), float('-inf')):
        return None
    return int(number) if number.is_integer() else number


def _first(nodes) -> Any:
    return nodes[0] if len(nodes) else None


def _first_attr(nodes, name: str) -> str:
    node = _first(nodes)
    if node is None:
        return ''
    return node.attrib.get(name) or ''


def _first_text(nodes) -> str:
    node = _first(nodes)
    if node is None:
        return ''
    return node.get_all_text(separator=' ', strip=True)


def _selector_text(root, selector: str) -> str:
    return clean_text(_first_text(root.css(selector)))


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


# ---------------------------------------------------------------------------
# URL handling
# ---------------------------------------------------------------------------


def build_search_url(actor_input: dict) -> str:
    search_url = clean_text(actor_input.get('searchUrl'))
    if search_url:
        return search_url

    search_query = clean_text(actor_input.get('searchQuery'))
    if not search_query:
        raise RuntimeError('Please provide either `searchQuery` or `searchUrl`.')

    return f'https://www.etsy.com/search?{urlencode({"q": search_query})}'


def build_page_url(base_url: str, page_number: int) -> str:
    parts = urlsplit(base_url)
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key != 'page']
    if page_number > 1:
        query.append(('page', str(page_number)))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def normalize_pagination_base_url(url_string: str | None, fallback_base_url: str) -> str:
    if not url_string:
        return fallback_base_url
    try:
        parts = urlsplit(url_string)
        params = parse_qs(parts.query, keep_blank_values=True)
        query = (params.get('q') or [''])[0]

        if ('vintage_rewrite' in params or parts.path.startswith('/search/vintage')) and query:
            return urlunsplit((parts.scheme, parts.netloc, '/search/vintage', urlencode({'q': query}), ''))
    except ValueError:
        pass

    return fallback_base_url


# ---------------------------------------------------------------------------
# Card extraction
# ---------------------------------------------------------------------------


def parse_rating_info(card) -> dict[str, int | float | None]:
    label = _first_attr(card.css('[aria-label*="star rating"], [aria-label*="out of 5 stars"]'), 'aria-label')
    rating_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:out of\s*5\s*)?stars?', label, re.I)
    review_match = re.search(r'([\d.,]+[km]?)\s*reviews?', label, re.I)

    return {
        'rating': js_number(rating_match.group(1)) if rating_match else None,
        'reviewCount': parse_compact_number(review_match.group(1)) if review_match else None,
    }


def parse_price_value(text: str) -> int | float | None:
    """Parse a localized currency number (Etsy renders per proxy geo)."""
    cleaned = re.sub(r'[^0-9.,]', '', text or '')
    if not cleaned:
        # Mirrors `Number('') === 0` in the original actor.
        return 0

    last_dot = cleaned.rfind('.')
    last_comma = cleaned.rfind(',')
    decimal_sep = None
    if last_dot >= 0 and last_comma >= 0:
        decimal_sep = '.' if last_dot > last_comma else ','
    elif last_comma >= 0:
        if cleaned.count(',') == 1 and len(cleaned) - last_comma - 1 in (1, 2):
            decimal_sep = ','
    elif last_dot >= 0:
        if cleaned.count('.') == 1 and len(cleaned) - last_dot - 1 in (1, 2):
            decimal_sep = '.'

    if decimal_sep:
        thousands_sep = ',' if decimal_sep == '.' else '.'
        cleaned = cleaned.replace(thousands_sep, '').replace(decimal_sep, '.')
    else:
        cleaned = cleaned.replace('.', '').replace(',', '')

    return js_number(cleaned)


def extract_price(card) -> dict[str, Any]:
    value_text = _selector_text(card, 'span.currency-value')
    symbol_text = _selector_text(card, 'span.currency-symbol')

    price = parse_price_value(value_text)

    return {
        'price': price,
        'currency': symbol_text or None,
        'priceFormatted': f'{symbol_text} {price}' if price is not None and symbol_text else None,
    }


def extract_seller(card) -> str | None:
    shop_link = card.css('a[href*="/shop/"]')
    href = _first_attr(shop_link, 'href')
    if href:
        match = re.search(r'/shop/([^/?#]+)', href, re.I)
        if match and match.group(1):
            return unquote(match.group(1)).strip()

    seller_raw = clean_text(_first_text(card.css('p[class*="shop"], span[class*="shop"], div[class*="shop"]')))
    if not seller_raw:
        return None

    cleaned = re.sub(r'^\d+(?:\.\d+)?\s*\([^)]+\)\s*', '', seller_raw, count=1, flags=re.I)
    cleaned = re.sub(r'\s+(?:Ad\s+)?from shop.*$', '', cleaned, count=1, flags=re.I).strip()

    ad_by = re.search(r'Ad\s*[\u00b7\u2022]\s*By\s+(.+)$', cleaned, re.I)
    if ad_by and ad_by.group(1):
        return ad_by.group(1).strip()

    by = re.search(r'\bBy\s+(.+)$', cleaned, re.I)
    if by and by.group(1):
        return by.group(1).strip()

    return cleaned or None


def extract_shop_url(card) -> str | None:
    link = _first_attr(card.css('a[href*="/shop/"]'), 'href')
    if not link:
        return None
    return link if link.startswith('http') else f'https://www.etsy.com{link}'


def infer_listing_type(title: str | None, card_text: str | None) -> str | None:
    hay = f'{title or ""} {card_text or ""}'.lower()
    if 'digital download' in hay or 'instant download' in hay or 'printable' in hay:
        return 'download'
    return None


def sanitize_product(product: dict) -> dict:
    clean = {}
    for key, value in product.items():
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        if isinstance(value, (list, tuple)) and not value:
            continue
        clean[key] = value
    return clean


def extract_listing_from_card(card, source: str = 'etsy_listingcards_intercept') -> dict | None:
    link = card.css('a[href*="/listing/"]')
    href = _first_attr(link, 'href')
    normalized_url = href if href.startswith('http') else f'https://www.etsy.com{href}'
    first_link = _first(link)
    listing_id_attr = card.attrib.get('data-listing-id') or (
        first_link.attrib.get('data-listing-id') if first_link is not None else None
    )
    listing_id_match = re.search(r'/listing/(\d+)', normalized_url, re.I)
    listing_id = listing_id_attr or (listing_id_match.group(1) if listing_id_match else None)

    if not listing_id or not normalized_url:
        return None

    images = card.css('img')
    image_url = _first_attr(images, 'src') or _first_attr(images, 'data-src') or None
    title = clean_text(
        _first_attr(link, 'aria-label') or _first_attr(images, 'alt') or _first_text(card.css('h3'))
    ) or None

    price_info = extract_price(card)
    rating_info = parse_rating_info(card)
    seller = extract_seller(card)
    shop_url = extract_shop_url(card)
    shop_id_raw = card.attrib.get('data-shop-id') or None
    shop_id = js_number(shop_id_raw)
    card_text = clean_text(card.get_all_text(separator=' ', strip=True))

    return sanitize_product({
        'listingId': js_number(listing_id),
        'title': title,
        'url': normalized_url,
        'price': price_info['price'],
        'currency': price_info['currency'],
        'priceFormatted': price_info['priceFormatted'],
        'image': image_url,
        'imageUrls': [image_url] if image_url else [],
        'seller': seller,
        'shopId': shop_id,
        'shopName': seller,
        'shopUrl': shop_url,
        'rating': rating_info['rating'],
        'reviewCount': rating_info['reviewCount'],
        'freeShipping': bool(re.search('free shipping', card_text, re.I)),
        'listingType': infer_listing_type(title, card_text),
        'hasVariations': bool(re.search(r'variant|variations?', card_text, re.I)),
        'scrapedAt': _iso_now(),
        'source': source,
    })


def extract_products_from_html(html: Any, source: str = 'etsy_listingcards_intercept') -> list[dict]:
    if not html or not isinstance(html, str):
        return []

    root = Selector(html)
    candidates = None
    for selector in CARD_SELECTORS:
        found = root.css(selector)
        if len(found) > 0:
            candidates = found
            break

    products: list[dict] = []
    local_seen: set = set()
    for card in candidates or []:
        product = extract_listing_from_card(card, source)
        if not product:
            continue
        listing_id = product.get('listingId')
        if listing_id in local_seen:
            continue
        local_seen.add(listing_id)
        products.append(product)

    return products


def normalize_json_ld_records(raw: Any) -> list:
    if not raw:
        return []
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        graph = raw.get('@graph')
        if isinstance(graph, list):
            return graph
        return [raw]
    return []


def parse_json_ld_products(html: Any) -> list[dict]:
    if not html or not isinstance(html, str):
        return []

    root = Selector(html)
    products: list[dict] = []
    seen: set = set()

    for raw_text in root.css('script[type="application/ld+json"]::text').getall():
        if not raw_text or not raw_text.strip():
            continue
        try:
            parsed = json.loads(raw_text)
        except (TypeError, ValueError):
            continue

        for record in normalize_json_ld_records(parsed):
            if not isinstance(record, dict):
                continue

            raw_type = record.get('@type')
            if isinstance(raw_type, list):
                record_type = ','.join(str(item) for item in raw_type).lower()
            else:
                record_type = str(raw_type or '').lower()
            if record_type and record_type != 'product':
                continue

            url = str(record.get('url') or '')
            listing_id_match = re.search(r'/listing/(\d+)', url, re.I)
            if not listing_id_match:
                continue

            listing_id = js_number(listing_id_match.group(1))
            if listing_id is None or listing_id in seen:
                continue
            seen.add(listing_id)

            images = record.get('image')
            if isinstance(images, list):
                image_value = images[0] if images else None
            else:
                image_value = images
            offers = record.get('offers')
            if isinstance(offers, list):
                offers = offers[0] if offers else None
            offers = offers if isinstance(offers, dict) else {}
            aggregate = record.get('aggregateRating') if isinstance(record.get('aggregateRating'), dict) else {}
            seller_obj = offers.get('seller') if isinstance(offers.get('seller'), dict) else {}
            brand = record.get('brand') if isinstance(record.get('brand'), dict) else {}
            seller = seller_obj.get('name') or brand.get('name') or None
            price = js_number(offers.get('price'))
            currency = clean_text(offers.get('priceCurrency')) or None

            image_urls = [img for img in images if isinstance(img, str)] if isinstance(images, list) else []
            if not image_urls and isinstance(image_value, str):
                image_urls.append(image_value)

            review_count = js_number(aggregate.get('reviewCount'))
            if review_count is None:
                review_count = js_number(aggregate.get('ratingCount'))

            description = clean_text(record.get('description'))
            name = clean_text(record.get('name'))

            products.append(sanitize_product({
                'listingId': listing_id,
                'title': name or None,
                'url': url,
                'price': price,
                'currency': currency,
                'priceFormatted': f'{currency} {price}' if price is not None and currency else None,
                'image': image_value if isinstance(image_value, str) else None,
                'imageUrls': image_urls,
                'seller': clean_text(seller) or None,
                'shopName': clean_text(seller) or None,
                'rating': js_number(aggregate.get('ratingValue')),
                'reviewCount': review_count,
                'freeShipping': bool(re.search('free shipping', description, re.I)),
                'listingType': infer_listing_type(name, description),
                'hasVariations': False,
                'scrapedAt': _iso_now(),
                'source': 'etsy_jsonld_intercept',
            }))

    return products


def merge_product_sets(primary: list[dict] | None, secondary: list[dict] | None) -> list[dict]:
    merged: dict = {}
    for item in [*(primary or []), *(secondary or [])]:
        if not item or not item.get('listingId'):
            continue
        listing_id = item['listingId']
        existing = merged.get(listing_id)
        if existing is None or len(item) > len(existing):
            merged[listing_id] = item
    return list(merged.values())


def extract_products_from_intercept_payloads(payloads: list[dict]) -> list[dict]:
    products: list[dict] = []
    seen: set = set()

    for payload in payloads:
        output = payload.get('output') if isinstance(payload, dict) else None
        html = output.get('listingCards') if isinstance(output, dict) else None
        if not html:
            continue
        for item in extract_products_from_html(html, 'etsy_listingcards_api_via_browser'):
            listing_id = item.get('listingId')
            if listing_id in seen:
                continue
            seen.add(listing_id)
            products.append(item)

    return products


def detect_rendered_page_number(html: Any) -> int | None:
    if not html:
        return None
    root = Selector(html)
    raw = ''
    with suppress(Exception):
        raw = _selector_text(root, 'nav[aria-label*="Pagination" i] [aria-current="page"]')
    if not raw:
        raw = _selector_text(root, '[aria-current="page"]')
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def calculate_set_overlap_ratio(set_a: set, set_b: set) -> float:
    if not set_a or not set_b:
        return 0.0
    shared = sum(1 for value in set_a if value in set_b)
    return shared / min(len(set_a), len(set_b))


def is_challenge_response(status_code: int | None, html: Any) -> bool:
    if status_code in (403, 429, 503):
        return True
    lower = str(html or '').lower()
    return any(marker in lower for marker in CHALLENGE_MARKERS)


def response_html(response) -> str:
    with suppress(Exception):
        return str(response.html_content)
    body = getattr(response, 'body', b'') or b''
    return body.decode('utf-8', 'replace') if isinstance(body, bytes) else str(body)


def response_title(response) -> str:
    return clean_text(_first_text(response.css('title::text')))


def looks_blocked(status_code: int | None, title: str, html: str) -> bool:
    if is_challenge_response(status_code, html):
        return True
    lower_title = (title or '').lower()
    return title in ('etsy.com', '429') or 'access denied' in lower_title


def apply_save_limit(products: list[dict], global_seen: set, remaining_wanted: int) -> list[dict]:
    to_save: list[dict] = []
    for product in products:
        listing_id = product.get('listingId')
        if not listing_id or listing_id in global_seen:
            continue
        global_seen.add(listing_id)
        to_save.append(product)
        if remaining_wanted > 0 and len(to_save) >= remaining_wanted:
            break
    return to_save


# ---------------------------------------------------------------------------
# Browser transport
# ---------------------------------------------------------------------------


async def _scroll_page(page) -> None:
    """Scroll until the listing grid stops growing, mirroring the Node actor."""
    stable_rounds = 0
    last_count = 0
    for _ in range(7):
        await page.wait_for_timeout(900)
        with suppress(Exception):
            await page.evaluate('window.scrollBy(0, Math.max(900, window.innerHeight * 0.9))')
        count = 0
        with suppress(Exception):
            count = await page.locator('[data-listing-id]').count()

        if count >= TARGET_PRODUCTS_PER_PAGE:
            break
        if count == last_count and count >= MIN_EXPECTED_PRODUCTS_PER_FULL_PAGE:
            stable_rounds += 1
            if stable_rounds >= 2:
                break
        else:
            stable_rounds = 0
        last_count = count


class EtsyBrowser:
    """One stealth browser session pinned to one proxy exit."""

    def __init__(self, proxy_configuration) -> None:
        self._proxy_configuration = proxy_configuration
        self._session: AsyncStealthySession | None = None
        self._needs_solve = True
        self._last_record_id = 0

    async def start(self) -> None:
        proxy_url = None
        if self._proxy_configuration is not None:
            proxy_url = await self._proxy_configuration.new_url(f'etsy_{secrets.token_hex(6)}')

        # Headful real Chrome first, then bundled Chromium, then headless.
        # A missing display or channel must not fail the run.
        modes = ((True, False), (False, False), (False, True))
        last_error: Exception | None = None
        for index, (real_chrome, headless) in enumerate(modes):
            session = AsyncStealthySession(
                headless=headless,
                real_chrome=real_chrome,
                solve_cloudflare=True,
                hide_canvas=True,
                block_webrtc=True,
                block_ads=True,
                locale='en-US',
                timeout=INTERNAL_FETCH_TIMEOUT_MS,
                retries=INTERNAL_MAX_REQUEST_RETRIES + 1,
                max_pages=1,
                record_requests=True,
                max_recorded_requests=400,
                proxy=proxy_url,
            )
            try:
                await session.start()
            except Exception as exc:
                last_error = exc
                with suppress(Exception):
                    await session.close()
                if index < len(modes) - 1:
                    Actor.log.debug(f'Stealth browser mode {(real_chrome, headless)} unavailable: {exc}')
                continue

            self._session = session
            self._needs_solve = True
            self._last_record_id = 0
            return

        raise RuntimeError(f'Could not start a stealth browser: {last_error}')

    async def close(self) -> None:
        if self._session is None:
            return
        with suppress(Exception):
            await self._session.close()
        self._session = None

    async def restart(self) -> None:
        await self.close()
        await self.start()

    async def fetch(self, url: str):
        if self._session is None:
            raise RuntimeError('Stealth browser session is not running')

        response = await self._session.fetch(
            url,
            load_dom=True,
            network_idle=False,
            wait=800,
            page_action=_scroll_page,
            wait_selector=LISTING_READY_SELECTOR,
            wait_selector_state='attached',
            solve_cloudflare=self._needs_solve,
        )

        if not looks_blocked(response.status, response_title(response), response_html(response)):
            self._needs_solve = False
        return response

    def collect_listing_cards(self) -> list[dict]:
        """Return JSON payloads of listingCards XHRs seen since the previous call."""
        if self._session is None:
            return []

        payloads: list[dict] = []
        records = self._session.network.search(
            url_pattern=re.escape(LISTING_CARDS_API_MARKER),
            after_id=self._last_record_id,
            limit=None,
        )
        for record in records:
            self._last_record_id = max(self._last_record_id, record.meta.get('network_id', 0))
            if record.status >= 400:
                continue
            try:
                payload = record.json()
            except Exception:
                continue
            if isinstance(payload, dict):
                payloads.append(payload)

        return payloads


async def fetch_with_rotation(browser: EtsyBrowser, url: str, state: dict) -> Any:
    response = await browser.fetch(url)
    for rotation in range(INTERNAL_MAX_SESSION_ROTATIONS):
        if not looks_blocked(response.status, response_title(response), response_html(response)):
            return response

        Actor.log.warning(
            f'Etsy challenge detected; rotating browser session ({rotation + 1}/{INTERNAL_MAX_SESSION_ROTATIONS})'
        )
        await browser.restart()
        response = await browser.fetch(url)
        if not looks_blocked(response.status, response_title(response), response_html(response)):
            state['challengeRecoveries'] += 1

    return response


# ---------------------------------------------------------------------------
# Actor lifecycle
# ---------------------------------------------------------------------------


async def load_input_with_fallback() -> dict:
    runtime_input = await Actor.get_input() or {}
    if runtime_input:
        return runtime_input

    input_path = pathlib.Path(__file__).resolve().parent.parent / 'INPUT.json'
    try:
        parsed = json.loads(input_path.read_text(encoding='utf-8'))
        if isinstance(parsed, dict) and parsed:
            Actor.log.info('Runtime input is empty. Falling back to INPUT.json values.')
            return parsed
    except Exception as exc:
        Actor.log.warning(f'Runtime input is empty and INPUT.json fallback failed: {exc}')

    return runtime_input


def _coerce_int(value: Any, default: int) -> int:
    number = js_number(value)
    if number is None or not isinstance(number, int):
        return default
    return number


async def run() -> None:
    actor_input = await load_input_with_fallback()

    results_wanted = _coerce_int(actor_input.get('results_wanted'), 20)
    max_pages = min(max(_coerce_int(actor_input.get('maxPages'), 2), 1), MAX_PAGES_CAP)

    if results_wanted < 0:
        raise RuntimeError('`results_wanted` must be >= 0')

    base_search_url = build_search_url(actor_input)
    current_url = build_page_url(base_search_url, 1)

    proxy_input = actor_input.get('proxyConfiguration')
    if proxy_input is None:
        proxy_input = {'useApifyProxy': True, 'apifyProxyGroups': ['RESIDENTIAL']}
    proxy_configuration = await Actor.create_proxy_configuration(actor_proxy_input=proxy_input) if proxy_input else None

    state = {
        'totalProductsScraped': 0,
        'pagesProcessed': 0,
        'interceptHits': 0,
        'htmlFallbackHits': 0,
        'apiDirectHits': 0,
        'challengeRecoveries': 0,
        'challengeFailures': 0,
    }
    global_seen: set = set()
    started_at = time.monotonic()

    browser = EtsyBrowser(proxy_configuration)
    await browser.start()

    try:
        current_page = 1
        previous_page_signature: str | None = None
        previous_page_ids: set = set()

        while current_page <= max_pages and (
            results_wanted == 0 or state['totalProductsScraped'] < results_wanted
        ):
            state['pagesProcessed'] += 1

            response = await fetch_with_rotation(browser, current_url, state)
            html = response_html(response)
            title = response_title(response)
            page_payloads = browser.collect_listing_cards()
            # Etsy rewrites /search into /search/vintage; later pages must use the
            # URL the browser actually landed on.
            current_url = str(getattr(response, 'url', '') or current_url)

            payload_products = extract_products_from_intercept_payloads(page_payloads)
            html_products = merge_product_sets(
                extract_products_from_html(html, 'etsy_listingcards_intercept'),
                parse_json_ld_products(html),
            )
            products = (
                merge_product_sets(html_products, payload_products) if html_products else payload_products
            )

            rendered_page = detect_rendered_page_number(html)
            still_blocked = looks_blocked(response.status, title, html)

            if payload_products:
                state['interceptHits'] += 1
            if html_products:
                state['htmlFallbackHits'] += 1

            if not products and still_blocked:
                Actor.log.warning(
                    f'No products found on page {current_page} '
                    f'(title={title!r}, blockedByChallenge={still_blocked}, '
                    f'payloadCount={len(page_payloads)}, renderedPage={rendered_page})'
                )
                state['challengeFailures'] += 1
                if state['totalProductsScraped'] > 0:
                    Actor.log.warning(
                        f'Stopping after Etsy challenge on page {current_page} because dataset already '
                        f'contains {state["totalProductsScraped"]} products.'
                    )
                    break
                raise RuntimeError(f'Blocked by Etsy challenge page at page {current_page}')

            if not products:
                Actor.log.warning(
                    f'No products found on page {current_page} '
                    f'(title={title!r}, blockedByChallenge={still_blocked}, '
                    f'payloadCount={len(page_payloads)}, renderedPage={rendered_page})'
                )

            if current_page > 1 and rendered_page is not None and rendered_page != current_page:
                if state['totalProductsScraped'] > 0:
                    Actor.log.warning(
                        f'Stopping after pagination mismatch on page {current_page}; '
                        f'keeping {state["totalProductsScraped"]} saved products.'
                    )
                    break
                raise RuntimeError(
                    f'Pagination mismatch: requested page {current_page}, rendered page {rendered_page}'
                )

            page_ids = {product['listingId'] for product in products if product.get('listingId')}
            page_signature = ','.join(
                str(product['listingId']) for product in products[:40] if product.get('listingId')
            )

            if current_page > 1 and previous_page_signature and page_signature and page_signature == previous_page_signature:
                if state['totalProductsScraped'] > 0:
                    Actor.log.warning(
                        f'Stopping after pagination stalled on page {current_page}; '
                        f'keeping {state["totalProductsScraped"]} saved products.'
                    )
                    break
                raise RuntimeError(
                    f'Pagination stuck: page {current_page} returned same listing signature as previous page'
                )

            if (
                current_page > 1
                and len(previous_page_ids) >= MIN_EXPECTED_PRODUCTS_PER_FULL_PAGE
                and len(page_ids) >= MIN_EXPECTED_PRODUCTS_PER_FULL_PAGE
            ):
                overlap_ratio = calculate_set_overlap_ratio(previous_page_ids, page_ids)
                if overlap_ratio >= 0.9:
                    if state['totalProductsScraped'] > 0:
                        Actor.log.warning(
                            f'Stopping after pagination overlap on page {current_page}; '
                            f'keeping {state["totalProductsScraped"]} saved products.'
                        )
                        break
                    raise RuntimeError(
                        f'Pagination overlap detected on page {current_page} (overlap {overlap_ratio:.2f})'
                    )

            remaining_wanted = results_wanted - state['totalProductsScraped'] if results_wanted > 0 else 0
            to_save = apply_save_limit(products, global_seen, remaining_wanted)

            if (
                current_page > 1
                and not to_save
                and products
                and (results_wanted == 0 or state['totalProductsScraped'] < results_wanted)
            ):
                if state['totalProductsScraped'] > 0:
                    Actor.log.warning(
                        f'Stopping after duplicate-only page {current_page}; '
                        f'keeping {state["totalProductsScraped"]} saved products.'
                    )
                    break
                raise RuntimeError(f'Pagination returned duplicate-only results on page {current_page}')

            if to_save:
                await Actor.push_data(to_save)
                state['totalProductsScraped'] += len(to_save)
                Actor.log.info(
                    f'Page {current_page}: saved {len(to_save)} products. Total: {state["totalProductsScraped"]}'
                )

            previous_page_signature = page_signature
            previous_page_ids = page_ids

            if results_wanted > 0 and state['totalProductsScraped'] >= results_wanted:
                break
            if current_page >= max_pages:
                break

            next_page = current_page + 1
            await asyncio.sleep(INTERNAL_REQUEST_DELAY_MS / 1000 + random.uniform(0, 0.2))
            pagination_base = normalize_pagination_base_url(current_url, base_search_url)
            current_url = build_page_url(pagination_base, next_page)
            current_page = next_page
    finally:
        await browser.close()

    if results_wanted > 0 and state['totalProductsScraped'] < results_wanted:
        Actor.log.warning(
            f'Requested {results_wanted} results but scraped {state["totalProductsScraped"]}. '
            'Blocking or repeated pages likely affected extraction.'
        )

    duration_secs = round(time.monotonic() - started_at)
    statistics = {
        'totalProductsScraped': state['totalProductsScraped'],
        'pagesProcessed': state['pagesProcessed'],
        'interceptHits': state['interceptHits'],
        'htmlFallbackHits': state['htmlFallbackHits'],
        'apiDirectHits': state['apiDirectHits'],
        'challengeRecoveries': state['challengeRecoveries'],
        'challengeFailures': state['challengeFailures'],
        'duration': f'{duration_secs} seconds',
        'mode': 'scrapling_stealthy_api_intercept',
    }

    await Actor.set_value('statistics', statistics)
    Actor.log.info(f'Actor completed successfully: {statistics}')


async def main() -> None:
    async with Actor:
        await run()
