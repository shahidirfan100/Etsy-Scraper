import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlaywrightCrawler, SessionError } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import * as cheerio from 'cheerio';
import { firefox } from 'playwright';

await Actor.init();

const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

const MAX_PAGES_CAP = 50;
const INTERNAL_REQUEST_DELAY_MS = 350;
const INTERNAL_MAX_REQUEST_RETRIES = 2;
const INTERNAL_MAX_SESSION_ROTATIONS = 6;
const INTERNAL_NAVIGATION_TIMEOUT_SECS = 60;
const INTERNAL_REQUEST_HANDLER_TIMEOUT_SECS = 120;
const INTERNAL_CHALLENGE_RELOADS = 2;
const MIN_EXPECTED_PRODUCTS_PER_FULL_PAGE = 12;
const TARGET_PRODUCTS_PER_PAGE = 48;

const CHALLENGE_MARKERS = [
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
];

function cleanText(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
}

function parseCompactNumber(raw) {
    if (!raw) return null;
    const text = String(raw).trim().toLowerCase().replace(/,/g, '');
    const match = text.match(/(\d+(?:\.\d+)?)([km])?/i);
    if (!match) return null;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return null;
    const suffix = (match[2] || '').toLowerCase();
    if (suffix === 'k') return Math.round(base * 1000);
    if (suffix === 'm') return Math.round(base * 1000000);
    return Math.round(base);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function buildSearchUrl(input) {
    if (input.searchUrl?.trim()) {
        return input.searchUrl.trim();
    }

    if (!input.searchQuery?.trim()) {
        throw new Error('Please provide either `searchQuery` or `searchUrl`.');
    }

    const url = new URL('https://www.etsy.com/search');
    url.searchParams.set('q', input.searchQuery.trim());
    return url.toString();
}

function buildPageUrl(baseUrl, pageNumber) {
    const url = new URL(baseUrl);
    if (pageNumber <= 1) {
        url.searchParams.delete('page');
    } else {
        url.searchParams.set('page', String(pageNumber));
    }
    return url.toString();
}

function parseRatingInfo(card$) {
    const ratingLabel = card$.find('[aria-label*="star rating"], [aria-label*="out of 5 stars"]').first().attr('aria-label') || '';
    const ratingMatch = ratingLabel.match(/(\d+(?:\.\d+)?)\s*star/i);
    const reviewMatch = ratingLabel.match(/(\d+(?:\.\d+)?[km]?)\s*reviews?/i);

    return {
        rating: ratingMatch ? Number(ratingMatch[1]) : null,
        reviewCount: reviewMatch ? parseCompactNumber(reviewMatch[1]) : null,
    };
}

function extractPrice(card$) {
    const valueText = cleanText(card$.find('span.currency-value').first().text());
    const symbolText = cleanText(card$.find('span.currency-symbol').first().text());
    const value = Number(valueText.replace(/[^0-9.]/g, ''));
    const price = Number.isFinite(value) ? value : null;

    return {
        price,
        currency: symbolText || null,
        priceFormatted: price !== null && symbolText ? `${symbolText} ${price}` : null,
    };
}

function extractSeller(card$) {
    const shopLink = card$.find('a[href*="/shop/"]').first();
    const linkHref = shopLink.attr('href') || '';
    if (linkHref) {
        const match = linkHref.match(/\/shop\/([^/?#]+)/i);
        if (match?.[1]) return decodeURIComponent(match[1]).trim();
    }

    const sellerRaw = cleanText(
        card$.find('p[class*="shop"], span[class*="shop"], div[class*="shop"]').first().text(),
    );
    if (!sellerRaw) return null;

    const cleaned = sellerRaw
        .replace(/^\d+(?:\.\d+)?\s*\([^)]+\)\s*/i, '')
        .replace(/\s+Ad from shop.*$/i, '')
        .trim();

    const adBy = cleaned.match(/Ad\s*[·•]\s*By\s+(.+)$/i);
    if (adBy?.[1]) return adBy[1].trim();

    const by = cleaned.match(/\bBy\s+(.+)$/i);
    if (by?.[1]) return by[1].trim();

    return cleaned || null;
}

function extractShopUrl(card$) {
    const link = card$.find('a[href*="/shop/"]').first().attr('href') || '';
    if (!link) return null;
    return link.startsWith('http') ? link : `https://www.etsy.com${link}`;
}

function inferListingType(title, cardText) {
    const hay = `${title || ''} ${cardText || ''}`.toLowerCase();
    if (hay.includes('digital download') || hay.includes('instant download') || hay.includes('printable')) {
        return 'download';
    }
    return null;
}

function sanitizeProduct(product) {
    const clean = {};
    for (const [key, value] of Object.entries(product)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && !value.trim()) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        clean[key] = value;
    }
    return clean;
}

function extractListingFromCard($, element, source = 'etsy_listingcards_intercept') {
    const card$ = $(element);
    const link$ = card$.find('a[href*="/listing/"]').first();
    const href = link$.attr('href') || '';
    const normalizedUrl = href.startsWith('http') ? href : `https://www.etsy.com${href}`;
    const listingIdAttr = card$.attr('data-listing-id') || link$.attr('data-listing-id');
    const listingIdMatch = normalizedUrl.match(/\/listing\/(\d+)/i);
    const listingId = listingIdAttr || listingIdMatch?.[1] || null;

    if (!listingId || !normalizedUrl) return null;

    const image$ = card$.find('img').first();
    const imageUrl = image$.attr('src') || image$.attr('data-src') || null;
    const title = cleanText(
        link$.attr('aria-label')
        || image$.attr('alt')
        || card$.find('h3').first().text(),
    ) || null;

    const { price, currency, priceFormatted } = extractPrice(card$);
    const { rating, reviewCount } = parseRatingInfo(card$);
    const seller = extractSeller(card$);
    const shopUrl = extractShopUrl(card$);
    const shopIdRaw = card$.attr('data-shop-id') || null;
    const shopId = shopIdRaw ? Number(shopIdRaw) : null;
    const cardText = cleanText(card$.text());

    return sanitizeProduct({
        listingId: Number(listingId),
        title,
        url: normalizedUrl,
        price,
        currency,
        priceFormatted,
        image: imageUrl,
        imageUrls: imageUrl ? [imageUrl] : [],
        seller,
        shopId: Number.isFinite(shopId) ? shopId : null,
        shopName: seller,
        shopUrl,
        rating,
        reviewCount,
        freeShipping: /free shipping/i.test(cardText),
        listingType: inferListingType(title, cardText),
        hasVariations: /variant|variations?/i.test(cardText),
        scrapedAt: new Date().toISOString(),
        source,
    });
}

function extractProductsFromHtml(html, source = 'etsy_listingcards_intercept') {
    if (!html || typeof html !== 'string') return [];
    const $ = cheerio.load(html);

    const selectors = [
        'div[data-appears-component-name="search2_organic_listings_group"] div[data-listing-id]',
        'li.wt-list-unstyled div[data-listing-id]',
        '.v2-listing-card[data-listing-id]',
        'div[data-listing-id], li[data-listing-id]',
    ];
    let candidates = $();
    for (const selector of selectors) {
        const found = $(selector);
        if (found.length > 0) {
            candidates = found;
            break;
        }
    }

    const products = [];
    const localSeen = new Set();

    candidates.each((_, element) => {
        const product = extractListingFromCard($, element, source);
        if (!product) return;
        if (localSeen.has(product.listingId)) return;
        localSeen.add(product.listingId);
        products.push(product);
    });

    return products;
}

function normalizeJsonLdRecords(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') {
        if (Array.isArray(raw['@graph'])) return raw['@graph'];
        return [raw];
    }
    return [];
}

function parseJsonLdProducts(html) {
    if (!html || typeof html !== 'string') return [];
    const $ = cheerio.load(html);
    const products = [];
    const seen = new Set();

    $('script[type="application/ld+json"]').each((_, element) => {
        const rawText = $(element).text();
        if (!rawText || !rawText.trim()) return;

        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            return;
        }

        for (const record of normalizeJsonLdRecords(parsed)) {
            if (!record || typeof record !== 'object') continue;
            const type = String(record['@type'] || '').toLowerCase();
            const url = String(record.url || '');
            const listingIdMatch = url.match(/\/listing\/(\d+)/i);
            if (!listingIdMatch) continue;
            if (type && type !== 'product') continue;

            const listingId = Number(listingIdMatch[1]);
            if (!Number.isFinite(listingId) || seen.has(listingId)) continue;
            seen.add(listingId);

            const imageValue = Array.isArray(record.image) ? record.image[0] : record.image;
            const offers = Array.isArray(record.offers) ? record.offers[0] : record.offers;
            const aggregate = record.aggregateRating || {};
            const seller = offers?.seller?.name || record.brand?.name || null;
            const priceRaw = offers?.price;
            const price = Number(priceRaw);
            const imageUrls = Array.isArray(record.image)
                ? record.image.filter((img) => typeof img === 'string')
                : [];

            if (imageUrls.length === 0 && typeof imageValue === 'string') {
                imageUrls.push(imageValue);
            }

            let reviewCount = null;
            const aggregateReviewCount = Number(aggregate.reviewCount);
            if (Number.isFinite(aggregateReviewCount)) {
                reviewCount = aggregateReviewCount;
            } else {
                const aggregateRatingCount = Number(aggregate.ratingCount);
                if (Number.isFinite(aggregateRatingCount)) {
                    reviewCount = aggregateRatingCount;
                }
            }

            products.push(sanitizeProduct({
                listingId,
                title: cleanText(record.name || '') || null,
                url,
                price: Number.isFinite(price) ? price : null,
                currency: cleanText(offers?.priceCurrency || '') || null,
                priceFormatted: Number.isFinite(price) && offers?.priceCurrency ? `${offers.priceCurrency} ${price}` : null,
                image: typeof imageValue === 'string' ? imageValue : null,
                imageUrls,
                seller: cleanText(seller || '') || null,
                shopName: cleanText(seller || '') || null,
                rating: Number.isFinite(Number(aggregate.ratingValue)) ? Number(aggregate.ratingValue) : null,
                reviewCount,
                freeShipping: /free shipping/i.test(cleanText(record.description || '')),
                listingType: inferListingType(cleanText(record.name || ''), cleanText(record.description || '')),
                hasVariations: false,
                scrapedAt: new Date().toISOString(),
                source: 'etsy_jsonld_intercept',
            }));
        }
    });

    return products;
}

function scoreProductCompleteness(product) {
    return Object.keys(product || {}).length;
}

function mergeProductSets(primaryProducts, secondaryProducts) {
    const merged = new Map();

    for (const item of [...(primaryProducts || []), ...(secondaryProducts || [])]) {
        if (!item?.listingId) continue;
        const existing = merged.get(item.listingId);
        if (!existing || scoreProductCompleteness(item) > scoreProductCompleteness(existing)) {
            merged.set(item.listingId, item);
        }
    }

    return [...merged.values()];
}

function extractProductsFromInterceptPayloads(payloads) {
    const products = [];
    const seen = new Set();

    for (const payload of payloads) {
        const html = payload?.output?.listingCards;
        if (!html) continue;
        const items = extractProductsFromHtml(html, 'etsy_listingcards_api_via_browser');
        for (const item of items) {
            if (seen.has(item.listingId)) continue;
            seen.add(item.listingId);
            products.push(item);
        }
    }

    return products;
}

function detectRenderedPageNumber(html) {
    if (!html) return null;
    const $ = cheerio.load(html);
    const raw = cleanText(
        $('nav[aria-label*="Pagination" i] [aria-current="page"]').first().text()
        || $('[aria-current="page"]').first().text(),
    );
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
}

function detectUrlPageNumber(urlString) {
    if (!urlString) return null;
    try {
        const page = Number.parseInt(new URL(urlString).searchParams.get('page') || '', 10);
        return Number.isFinite(page) ? page : null;
    } catch {
        return null;
    }
}

function normalizePaginationBaseUrl(urlString, fallbackBaseUrl) {
    try {
        const url = new URL(urlString);
        const q = url.searchParams.get('q');

        if (url.searchParams.has('vintage_rewrite') && q) {
            const normalized = new URL('/search/vintage', url.origin);
            normalized.searchParams.set('q', q);
            return normalized.toString();
        }

        if (url.pathname.startsWith('/search/vintage') && q) {
            const normalized = new URL('/search/vintage', url.origin);
            normalized.searchParams.set('q', q);
            return normalized.toString();
        }
    } catch {
        // Fall back to default base URL.
    }

    return fallbackBaseUrl;
}

function calculateSetOverlapRatio(setA, setB) {
    if (!setA?.size || !setB?.size) return 0;
    let shared = 0;
    for (const value of setA) {
        if (setB.has(value)) shared++;
    }
    return shared / Math.min(setA.size, setB.size);
}

function isChallengeResponse(statusCode, html) {
    if ([403, 429, 503].includes(statusCode)) return true;
    const lower = String(html || '').toLowerCase();
    return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

async function buildCamoufoxLaunchOptions(proxyUrl) {
    return camoufoxLaunchOptions({
        headless: true,
        os: ['windows'],
        humanize: true,
        block_webrtc: true,
        geoip: Boolean(proxyUrl),
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });
}

async function getStablePageContent(page, maxAttempts = 6) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await page.content();
        } catch (error) {
            const message = error?.message || '';
            const isTransientNav = message.includes('page is navigating')
                || message.includes('Execution context was destroyed');
            if (!isTransientNav) throw error;
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(500);
        }
    }

    return await page.content();
}

async function moveToNextPage(page, baseSearchUrl, nextPageNumber, currentPageSignature) {
    const previousUrl = page.url();
    const normalizedBaseUrl = normalizePaginationBaseUrl(previousUrl, baseSearchUrl);
    const candidateSet = new Set([
        buildPageUrl(baseSearchUrl, nextPageNumber),
        buildPageUrl(normalizedBaseUrl, nextPageNumber),
        buildPageUrl(previousUrl, nextPageNumber),
    ]);

    try {
        const adjusted = new URL(previousUrl);
        adjusted.searchParams.delete('original_query');
        if (nextPageNumber <= 1) adjusted.searchParams.delete('page');
        else adjusted.searchParams.set('page', String(nextPageNumber));
        candidateSet.add(adjusted.toString());
    } catch {
        // Ignore malformed URL edge-cases and continue.
    }

    const candidates = [...candidateSet].filter(Boolean);

    for (const nextUrl of candidates) {
        if (nextUrl === previousUrl) continue;

        await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await page.waitForSelector('a[href*="/listing/"], div[data-listing-id], li[data-listing-id]', { timeout: 30000 }).catch(() => {});

        for (let attempt = 0; attempt < 8; attempt++) {
            await page.waitForTimeout(900);
            const html = await getStablePageContent(page);
            const renderedPage = detectRenderedPageNumber(html);
            const urlPage = detectUrlPageNumber(page.url());
            const products = extractProductsFromHtml(html, 'etsy_listingcards_intercept');
            const signature = products
                .slice(0, 30)
                .map((item) => item.listingId)
                .filter(Boolean)
                .join(',');

            const explicitPageMatch = renderedPage === nextPageNumber || urlPage === nextPageNumber;
            const signatureChanged = signature && signature !== currentPageSignature && products.length >= MIN_EXPECTED_PRODUCTS_PER_FULL_PAGE;

            if (explicitPageMatch || signatureChanged) {
                return true;
            }

            await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 0.8))).catch(() => {});
        }
    }

    log.warning(`Pagination navigation failed to validate page ${nextPageNumber}.`);
    return false;
}

async function loadInputWithFallback() {
    const runtimeInput = (await Actor.getInput()) || {};
    if (Object.keys(runtimeInput).length > 0) {
        return runtimeInput;
    }

    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const inputPath = path.join(projectRoot, 'INPUT.json');

    try {
        const raw = await readFile(inputPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            log.info('Runtime input is empty. Falling back to INPUT.json values.');
            return parsed;
        }
    } catch (error) {
        log.warning(`Runtime input is empty and INPUT.json fallback failed: ${error.message}`);
    }

    return runtimeInput;
}

async function fetchListingCardsViaPlaywrightApi(page, apiUrl) {
    if (!apiUrl) return null;
    try {
        const response = await page.request.get(apiUrl, {
            failOnStatusCode: false,
            timeout: 25000,
            headers: {
                accept: 'application/json, text/plain, */*',
                'x-requested-with': 'XMLHttpRequest',
            },
        });

        if (!response.ok()) return null;

        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('application/json')) return null;

        return await response.json();
    } catch (error) {
        log.debug(`Direct Playwright API fetch failed: ${error.message}`);
        return null;
    }
}

function applySaveLimit(products, globalSeen, remainingWanted) {
    const toSave = [];

    for (const product of products) {
        if (!product?.listingId) continue;
        if (globalSeen.has(product.listingId)) continue;
        globalSeen.add(product.listingId);
        toSave.push(product);

        if (remainingWanted > 0 && toSave.length >= remainingWanted) {
            break;
        }
    }

    return toSave;
}

async function recoverFromChallenge(page, currentPage) {
    for (let attempt = 1; attempt <= INTERNAL_CHALLENGE_RELOADS; attempt++) {
        log.warning(`Challenge recovery attempt ${attempt}/${INTERNAL_CHALLENGE_RELOADS} on page ${currentPage}`);
        await page.waitForTimeout(1800 + (attempt * 1400));

        const htmlBeforeReload = await getStablePageContent(page).catch(() => '');
        if (!isChallengeResponse(200, htmlBeforeReload)) {
            return { recovered: true, html: htmlBeforeReload };
        }

        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        const html = await getStablePageContent(page).catch(() => '');
        if (!isChallengeResponse(200, html)) {
            return { recovered: true, html };
        }
    }

    return {
        recovered: false,
        html: await getStablePageContent(page).catch(() => ''),
    };
}

try {
    const input = await loadInputWithFallback();

    const resultsWanted = Number.isInteger(input.results_wanted) ? input.results_wanted : 20;
    const maxPages = clamp(Number(input.maxPages) || 2, 1, MAX_PAGES_CAP);

    if (resultsWanted < 0) throw new Error('`results_wanted` must be >= 0');

    const baseSearchUrl = buildSearchUrl(input);
    const startUrl = buildPageUrl(baseSearchUrl, 1);
    const proxyConfigurationInput = input.proxyConfiguration ?? {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
    };
    const proxyConfiguration = proxyConfigurationInput
        ? await Actor.createProxyConfiguration(proxyConfigurationInput)
        : undefined;

    const state = {
        totalProductsScraped: 0,
        pagesProcessed: 0,
        interceptHits: 0,
        htmlFallbackHits: 0,
        apiDirectHits: 0,
        challengeRecoveries: 0,
        challengeFailures: 0,
    };

    const globalSeen = new Set();
    const startedAt = Date.now();

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: 1,
        maxRequestRetries: INTERNAL_MAX_REQUEST_RETRIES,
        maxSessionRotations: INTERNAL_MAX_SESSION_ROTATIONS,
        navigationTimeoutSecs: INTERNAL_NAVIGATION_TIMEOUT_SECS,
        requestHandlerTimeoutSecs: INTERNAL_REQUEST_HANDLER_TIMEOUT_SECS,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 25,
            sessionOptions: {
                maxUsageCount: 4,
                maxErrorScore: 1,
            },
        },
        launchContext: {
            launcher: firefox,
            launchOptions: await buildCamoufoxLaunchOptions(),
        },
        browserPoolOptions: {
            useFingerprints: false,
            retireBrowserAfterPageCount: 1,
            preLaunchHooks: [
                async (_pageId, launchContext) => {
                    Reflect.set(launchContext, 'browserPerProxy', true);
                    Reflect.set(launchContext, 'launchOptions', {
                        ...launchContext.launchOptions,
                        ...await buildCamoufoxLaunchOptions(launchContext.proxyUrl),
                    });
                },
            ],
        },

        postNavigationHooks: [
            async ({ handleCloudflareChallenge, page }) => {
                await handleCloudflareChallenge();
                await page.waitForTimeout(1500);
            },
        ],

        preNavigationHooks: [
            async ({ page, request }) => {
                request.userData.interceptPayloads = [];
                request.userData.lastListingCardsApiUrl = null;

                const responseListener = async (response) => {
                    try {
                        const url = response.url();
                        if (!url.includes('/api/v3/ajax/bespoke/member/neu/specs/listingCards')) return;
                        request.userData.lastListingCardsApiUrl = url;
                        if (response.status() >= 400) return;

                        const contentType = response.headers()['content-type'] || '';
                        if (!contentType.includes('application/json')) return;

                        const text = await response.text();
                        const parsed = JSON.parse(text);
                        request.userData.interceptPayloads.push(parsed);
                    } catch (error) {
                        log.debug(`Intercept parse failed: ${error.message}`);
                    }
                };

                request.userData.responseListener = responseListener;
                page.on('response', responseListener);

                await page.route('**/*', (route) => {
                    const type = route.request().resourceType();
                    if (['font', 'media'].includes(type)) {
                        return route.abort();
                    }
                    return route.continue();
                });
            },
        ],

        requestHandler: async ({ page, request, session }) => {
            let currentPage = Number(request.userData.page || 1);
            let payloadCursor = 0;
            let previousPageSignature = null;
            let previousPageIds = new Set();

            try {
                while (currentPage <= maxPages && (resultsWanted === 0 || state.totalProductsScraped < resultsWanted)) {
                    state.pagesProcessed++;
                    log.info(`Processing page ${currentPage}: ${page.url()}`);

                    let bestMergedCount = 0;
                    let stableRounds = 0;
                    for (let attempt = 0; attempt < 7; attempt++) {
                        await page.waitForTimeout(900);
                        await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 0.9))).catch(() => {});

                        const htmlSnapshot = await getStablePageContent(page);
                        const htmlCount = extractProductsFromHtml(htmlSnapshot, 'etsy_listingcards_intercept').length;
                        const payloadCount = extractProductsFromInterceptPayloads(
                            (request.userData.interceptPayloads || []).slice(payloadCursor),
                        ).length;
                        const mergedCount = Math.max(htmlCount, payloadCount);

                        if (mergedCount > bestMergedCount) {
                            bestMergedCount = mergedCount;
                            stableRounds = 0;
                        } else {
                            stableRounds++;
                        }

                        const reachedTarget = mergedCount >= TARGET_PRODUCTS_PER_PAGE;
                        const sufficientlyStable = stableRounds >= 2 && mergedCount >= MIN_EXPECTED_PRODUCTS_PER_FULL_PAGE;
                        if (reachedTarget || sufficientlyStable) break;
                    }

                    const allPayloads = request.userData.interceptPayloads || [];
                    const pagePayloads = allPayloads.slice(payloadCursor);
                    payloadCursor = allPayloads.length;

                    let payloadProducts = extractProductsFromInterceptPayloads(pagePayloads);
                    if (payloadProducts.length === 0 && request.userData.lastListingCardsApiUrl) {
                        const apiPayload = await fetchListingCardsViaPlaywrightApi(page, request.userData.lastListingCardsApiUrl);
                        if (apiPayload) {
                            payloadProducts = extractProductsFromInterceptPayloads([apiPayload]);
                            if (payloadProducts.length > 0) {
                                state.apiDirectHits++;
                            }
                        }
                    }

                    let html = await getStablePageContent(page);
                    let title = await page.title();
                    let htmlProducts = mergeProductSets(
                        extractProductsFromHtml(html, 'etsy_listingcards_intercept'),
                        parseJsonLdProducts(html),
                    );

                    let products = htmlProducts.length > 0
                        ? mergeProductSets(htmlProducts, payloadProducts)
                        : payloadProducts;

                    const renderedPage = detectRenderedPageNumber(html);
                    const blockedByChallenge = (
                        title === 'etsy.com'
                        || title === '429'
                        || title.toLowerCase().includes('access denied')
                        || isChallengeResponse(200, html)
                    );

                    if (payloadProducts.length > 0) state.interceptHits++;
                    if (htmlProducts.length > 0) state.htmlFallbackHits++;

                    if (products.length === 0 && blockedByChallenge) {
                        const recovered = await recoverFromChallenge(page, currentPage);
                        if (recovered.recovered) {
                            state.challengeRecoveries++;
                            html = recovered.html;
                            title = await page.title().catch(() => title);
                            htmlProducts = mergeProductSets(
                                extractProductsFromHtml(html, 'etsy_listingcards_intercept'),
                                parseJsonLdProducts(html),
                            );

                            let recoveredPayloadProducts = payloadProducts;
                            if (recoveredPayloadProducts.length === 0 && request.userData.lastListingCardsApiUrl) {
                                const apiPayload = await fetchListingCardsViaPlaywrightApi(page, request.userData.lastListingCardsApiUrl);
                                if (apiPayload) {
                                    recoveredPayloadProducts = extractProductsFromInterceptPayloads([apiPayload]);
                                    if (recoveredPayloadProducts.length > 0) {
                                        state.apiDirectHits++;
                                    }
                                }
                            }

                            products = htmlProducts.length > 0
                                ? mergeProductSets(htmlProducts, recoveredPayloadProducts)
                                : recoveredPayloadProducts;
                        }
                    }

                    const stillBlockedByChallenge = (
                        title === 'etsy.com'
                        || title === '429'
                        || title.toLowerCase().includes('access denied')
                        || isChallengeResponse(200, html)
                    );

                    const pageIds = new Set(products.map((p) => p.listingId).filter(Boolean));
                    const pageSignature = products.slice(0, 40).map((p) => p.listingId).filter(Boolean).join(',');

                    if (products.length === 0) {
                        log.warning(`No products found on page ${currentPage}`, {
                            title,
                            blockedByChallenge: stillBlockedByChallenge,
                            payloadCount: pagePayloads.length,
                            renderedPage,
                        });
                        if (stillBlockedByChallenge) {
                            state.challengeFailures++;
                            session?.retire();
                            throw new SessionError(`Blocked by Etsy challenge page at page ${currentPage}`);
                        }
                    }

                    if (currentPage > 1 && renderedPage !== null && renderedPage !== currentPage) {
                        throw new Error(`Pagination mismatch: requested page ${currentPage}, rendered page ${renderedPage}`);
                    }
                    if (currentPage > 1 && previousPageSignature && pageSignature && pageSignature === previousPageSignature) {
                        throw new Error(`Pagination stuck: page ${currentPage} returned same listing signature as previous page`);
                    }
                    if (currentPage > 1 && previousPageIds.size >= MIN_EXPECTED_PRODUCTS_PER_FULL_PAGE && pageIds.size >= MIN_EXPECTED_PRODUCTS_PER_FULL_PAGE) {
                        const overlapRatio = calculateSetOverlapRatio(previousPageIds, pageIds);
                        if (overlapRatio >= 0.9) {
                            throw new Error(`Pagination overlap detected on page ${currentPage} (overlap ${overlapRatio.toFixed(2)})`);
                        }
                    }

                    const remainingWanted = resultsWanted > 0 ? (resultsWanted - state.totalProductsScraped) : 0;
                    const toSave = applySaveLimit(products, globalSeen, remainingWanted);

                    if (currentPage > 1 && toSave.length === 0 && products.length > 0
                        && (resultsWanted === 0 || state.totalProductsScraped < resultsWanted)) {
                        throw new Error(`Pagination returned duplicate-only results on page ${currentPage}`);
                    }

                    if (toSave.length > 0) {
                        await Actor.pushData(toSave);
                        state.totalProductsScraped += toSave.length;
                        log.info(`Saved ${toSave.length} products. Total: ${state.totalProductsScraped}`);
                    }

                    previousPageSignature = pageSignature;
                    previousPageIds = pageIds;

                    if (resultsWanted > 0 && state.totalProductsScraped >= resultsWanted) break;
                    if (currentPage >= maxPages) break;

                    const nextPage = currentPage + 1;
                    await sleep(INTERNAL_REQUEST_DELAY_MS);
                    const moved = await moveToNextPage(page, baseSearchUrl, nextPage, pageSignature);
                    if (!moved) {
                        throw new Error(`Unable to navigate to page ${nextPage}`);
                    }
                    currentPage = nextPage;
                }
            } finally {
                if (request.userData.responseListener) {
                    page.off('response', request.userData.responseListener);
                }
            }
        },

        failedRequestHandler: async ({ request }, error) => {
            log.error(`Failed request: ${request.url} - ${error.message}`);
        },
    });

    await crawler.run([{ url: startUrl, userData: { page: 1 }, uniqueKey: 'page-1' }]);

    if (resultsWanted > 0 && state.totalProductsScraped < resultsWanted) {
        log.warning(`Requested ${resultsWanted} results but scraped ${state.totalProductsScraped}. Blocking or repeated pages likely affected extraction.`);
    }

    const durationSecs = Math.round((Date.now() - startedAt) / 1000);
    const statistics = {
        totalProductsScraped: state.totalProductsScraped,
        pagesProcessed: state.pagesProcessed,
        interceptHits: state.interceptHits,
        htmlFallbackHits: state.htmlFallbackHits,
        apiDirectHits: state.apiDirectHits,
        challengeRecoveries: state.challengeRecoveries,
        challengeFailures: state.challengeFailures,
        duration: `${durationSecs} seconds`,
        mode: 'playwright_camoufox_api_intercept',
    };

    await Actor.setValue('statistics', statistics);
    log.info('Actor completed successfully', statistics);
} catch (error) {
    log.exception(error, 'Actor failed');
    throw error;
} finally {
    await Actor.exit();
}
