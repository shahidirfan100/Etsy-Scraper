import { PlaywrightCrawler } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import { launchOptions } from 'camoufox-js';
import * as cheerio from 'cheerio';
import { firefox } from 'playwright';

await Actor.init();

const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
const MAX_PAGES_CAP = 50;
const DEFAULT_REQUEST_DELAY_MS = 400;
const MIN_EXPECTED_PRODUCTS_PER_FULL_PAGE = 12;
const TARGET_PRODUCTS_PER_PAGE = 48;

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

function extractListingFromCard($, element) {
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
        source: 'etsy_listingcards_intercept',
    });
}

function extractProductsFromHtml(html) {
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
        const product = extractListingFromCard($, element);
        if (!product) return;
        if (localSeen.has(product.listingId)) return;
        localSeen.add(product.listingId);
        products.push(product);
    });

    return products;
}

function extractProductsFromInterceptPayloads(payloads) {
    const products = [];
    const seen = new Set();

    for (const payload of payloads) {
        const html = payload?.output?.listingCards;
        if (!html) continue;
        const items = extractProductsFromHtml(html);
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

function calculateSetOverlapRatio(setA, setB) {
    if (!setA?.size || !setB?.size) return 0;
    let shared = 0;
    for (const value of setA) {
        if (setB.has(value)) shared++;
    }
    return shared / Math.min(setA.size, setB.size);
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
            const products = extractProductsFromHtml(html);
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

try {
    const input = (await Actor.getInput()) || {};

    const resultsWanted = Number.isInteger(input.results_wanted) ? input.results_wanted : 20;
    const maxPages = clamp(Number(input.maxPages) || 2, 1, MAX_PAGES_CAP);
    const requestDelayMs = DEFAULT_REQUEST_DELAY_MS;

    if (resultsWanted < 0) throw new Error('`results_wanted` must be >= 0');

    const baseSearchUrl = buildSearchUrl(input);
    const startUrl = buildPageUrl(baseSearchUrl, 1);
    const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);

    let totalProductsScraped = 0;
    let pagesProcessed = 0;
    let interceptHits = 0;
    let htmlFallbackHits = 0;
    const globalSeen = new Set();
    const startedAt = Date.now();

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: 1,
        maxRequestRetries: 4,
        navigationTimeoutSecs: 120,
        requestHandlerTimeoutSecs: 240,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 25,
            sessionOptions: {
                maxUsageCount: 8,
                maxErrorScore: 2,
            },
        },

        launchContext: {
            launcher: firefox,
            launchOptions: await launchOptions({ headless: true }),
        },

        browserPoolOptions: {
            useFingerprints: false,
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

                const responseListener = async (response) => {
                    try {
                        const url = response.url();
                        if (!url.includes('/api/v3/ajax/bespoke/member/neu/specs/listingCards')) return;
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
                    const reqUrl = route.request().url();
                    const type = route.request().resourceType();
                    if (
                        ['font', 'media', 'stylesheet'].includes(type)
                        || reqUrl.includes('google-analytics')
                        || reqUrl.includes('googletagmanager')
                        || reqUrl.includes('doubleclick')
                    ) {
                        return route.abort();
                    }
                    return route.continue();
                });
            },
        ],

        requestHandler: async ({ page, request }) => {
            let currentPage = Number(request.userData.page || 1);
            let payloadCursor = 0;
            let previousPageSignature = null;
            let previousPageIds = new Set();
            try {
                while (currentPage <= maxPages && (resultsWanted === 0 || totalProductsScraped < resultsWanted)) {
                    pagesProcessed++;
                    log.info(`Processing page ${currentPage}: ${page.url()}`);

                    // Adaptive load-until-stable loop to avoid partial-page extraction.
                    let bestMergedCount = 0;
                    let stableRounds = 0;
                    for (let attempt = 0; attempt < 8; attempt++) {
                        await page.waitForTimeout(1200);
                        await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 0.9))).catch(() => {});

                        const htmlSnapshot = await getStablePageContent(page);
                        const htmlCount = extractProductsFromHtml(htmlSnapshot).length;
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
                    const payloadProducts = extractProductsFromInterceptPayloads(pagePayloads);
                    const title = await page.title();
                    const html = await getStablePageContent(page);
                    const htmlProducts = extractProductsFromHtml(html);
                    const products = htmlProducts.length > 0
                        ? mergeProductSets(htmlProducts, payloadProducts)
                        : payloadProducts;
                    const pageIds = new Set(products.map((p) => p.listingId).filter(Boolean));
                    const renderedPage = detectRenderedPageNumber(html);
                    const pageSignature = products.slice(0, 40).map((p) => p.listingId).filter(Boolean).join(',');
                    const blockedByChallenge = (
                        title === 'etsy.com'
                        || title === '429'
                        || title.toLowerCase().includes('access denied')
                        || html.includes('captcha-delivery.com')
                        || html.includes('Please enable JS and disable any ad blocker')
                        || html.includes('Verification')
                        || html.includes('Too Many Requests')
                        || html.includes('Request blocked')
                    );

                    if (payloadProducts.length > 0) interceptHits++;
                    if (htmlProducts.length > 0) htmlFallbackHits++;

                    if (products.length === 0) {
                        log.warning(`No products found on page ${currentPage}`, {
                            title,
                            blockedByChallenge,
                            payloadCount: pagePayloads.length,
                            renderedPage,
                        });
                        if (blockedByChallenge) {
                            throw new Error(`Blocked by challenge page at page ${currentPage}`);
                        }
                    } else {
                        log.debug(`Page ${currentPage} product source counts`, {
                            mergedCount: products.length,
                            htmlCount: htmlProducts.length,
                            payloadCount: payloadProducts.length,
                            renderedPage,
                        });
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

                    const toSave = [];
                    for (const product of products) {
                        if (!product?.listingId) continue;
                        if (globalSeen.has(product.listingId)) continue;
                        globalSeen.add(product.listingId);
                        toSave.push(product);

                        if (resultsWanted > 0 && (totalProductsScraped + toSave.length) >= resultsWanted) {
                            break;
                        }
                    }

                    if (currentPage > 1 && toSave.length === 0 && products.length > 0
                        && (resultsWanted === 0 || totalProductsScraped < resultsWanted)) {
                        throw new Error(`Pagination returned duplicate-only results on page ${currentPage}`);
                    }

                    if (toSave.length > 0) {
                        await Actor.pushData(toSave);
                        totalProductsScraped += toSave.length;
                        log.info(`Saved ${toSave.length} products. Total: ${totalProductsScraped}`);
                    } else {
                        log.info(`No new products saved on page ${currentPage}.`);
                    }
                    previousPageSignature = pageSignature;
                    previousPageIds = pageIds;

                    if (resultsWanted > 0 && totalProductsScraped >= resultsWanted) break;
                    if (currentPage >= maxPages) break;

                    const nextPage = currentPage + 1;
                    await sleep(requestDelayMs);
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

    if (resultsWanted > 0 && totalProductsScraped < resultsWanted) {
        log.warning(`Requested ${resultsWanted} results but scraped ${totalProductsScraped}. Etsy blocked or repeated pages likely affected pagination.`);
    }

    const durationSecs = Math.round((Date.now() - startedAt) / 1000);
    const statistics = {
        totalProductsScraped,
        pagesProcessed,
        interceptHits,
        htmlFallbackHits,
        duration: `${durationSecs} seconds`,
        mode: 'playwright_intercept',
    };

    await Actor.setValue('statistics', statistics);
    log.info('Actor completed successfully', statistics);
} catch (error) {
    log.exception(error, 'Actor failed');
    throw error;
} finally {
    await Actor.exit();
}
