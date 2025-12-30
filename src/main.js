/**
 * Etsy Products Scraper - Production-ready Apify Actor
 * Uses PlaywrightCrawler with Camoufox + handleCloudflareChallenge
 * Based on official Crawlee documentation patterns
 */

import { PlaywrightCrawler } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import * as cheerio from 'cheerio';

// Initialize the Apify SDK
await Actor.init();

/**
 * Simulate human browsing behavior
 */
async function simulateHumanBehavior(page) {
    try {
        // Random delay before any action
        await page.waitForTimeout(1000 + Math.random() * 2000);

        // Random scroll
        const scrollAmount = 300 + Math.floor(Math.random() * 500);
        await page.evaluate((amount) => {
            window.scrollBy({ top: amount, behavior: 'smooth' });
        }, scrollAmount);

        await page.waitForTimeout(500 + Math.random() * 1000);

        // Random mouse movements
        const viewport = page.viewportSize();
        if (viewport) {
            for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
                const x = 100 + Math.random() * (viewport.width - 200);
                const y = 100 + Math.random() * (viewport.height - 200);
                await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
                await page.waitForTimeout(50 + Math.random() * 150);
            }
        }
    } catch (error) {
        log.debug(`Human behavior simulation failed: ${error.message}`);
    }
}

/**
 * Extract product detail from individual product page
 */
async function extractProductDetail(page) {
    const html = await page.content();
    const $ = cheerio.load(html);

    // Description
    const descriptionSelectors = [
        '[data-product-details-description]',
        '#wt-content-toggle-product-details-read-more',
        '.wt-content-toggle__body',
        'p[data-product-details-description-text-content]',
        '.wt-text-body-01',
    ];
    let description = '';
    for (const sel of descriptionSelectors) {
        const descEl = $(sel).first();
        if (descEl.length && descEl.text().trim()) {
            description = descEl.text().trim().substring(0, 2000);
            break;
        }
    }

    // Materials
    const materials = [];
    $('[data-materials] li, #materials li').each((_, el) => {
        const text = $(el).text().trim();
        if (text) materials.push(text);
    });

    // Tags
    const tags = [];
    $('[data-tag], .wt-badge').each((_, el) => {
        const text = $(el).text().trim();
        if (text && !tags.includes(text)) tags.push(text);
    });

    // Shop info
    const shopUrl = $('a[href*="/shop/"]').first().attr('href') || '';
    const shopLocation = $('[data-shop-location]').first().text().trim();

    // Additional images
    const images = [];
    $('img[src*="i.etsystatic.com"]').each((_, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src') || '';
        if (src && !images.includes(src) && images.length < 10) {
            images.push(src.replace(/(_\d+x\d+)/, '_fullxfull'));
        }
    });

    return {
        description: description || null,
        materials: materials.length ? materials : null,
        tags: tags.length ? tags.slice(0, 10) : null,
        shopUrl: shopUrl || null,
        shopLocation: shopLocation || null,
        additionalImages: images.length > 1 ? images : null,
    };
}

/**
 * Enrich products with detail page data - FAST with BATCH PUSH
 * Pushes data every 10 products so data is saved incrementally
 */
async function enrichProductsWithDetails(products, page, maxEnrich = 15) {
    if (products.length === 0) return { enriched: 0, total: 0 };

    const productsToEnrich = products.slice(0, maxEnrich);
    const totalCount = productsToEnrich.length;
    log.info(`Fast enriching ${totalCount} products with batch push...`);

    const BATCH_SIZE = 10;
    let batchBuffer = [];
    let totalPushed = 0;
    const startTime = Date.now();

    for (let i = 0; i < totalCount; i++) {
        const product = productsToEnrich[i];

        if (!product.url) {
            batchBuffer.push(product);
        } else {
            try {
                // Fast navigation
                await page.goto(product.url, {
                    waitUntil: 'commit',
                    timeout: 15000
                });

                await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });

                const details = await extractProductDetail(page);
                batchBuffer.push({ ...product, ...details });

            } catch (error) {
                log.debug(`Skip enrichment: ${error.message}`);
                batchBuffer.push(product);
            }
        }

        // Push batch every BATCH_SIZE products
        if (batchBuffer.length >= BATCH_SIZE) {
            await Actor.pushData(batchBuffer);
            totalPushed += batchBuffer.length;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            log.info(`📤 Pushed batch: ${totalPushed}/${totalCount} products (${elapsed}s)`);
            batchBuffer = [];
        }
    }

    // Push remaining products in buffer
    if (batchBuffer.length > 0) {
        await Actor.pushData(batchBuffer);
        totalPushed += batchBuffer.length;
        log.info(`📤 Pushed final batch: ${totalPushed}/${totalCount} products`);
    }

    // Push remaining non-enriched products
    if (maxEnrich < products.length) {
        const remaining = products.slice(maxEnrich);
        await Actor.pushData(remaining);
        totalPushed += remaining.length;
        log.info(`📤 Pushed ${remaining.length} non-enriched products`);
    }

    const totalTime = Math.round((Date.now() - startTime) / 1000);
    log.info(`✓ Enriched and pushed ${totalPushed} products in ${totalTime}s`);

    return { enriched: Math.min(totalCount, totalPushed), total: totalPushed };
}

/**
 * Extract products via HTML parsing
 */
async function extractProductDataViaHTML(page) {
    log.info('Extracting product data via HTML parsing');

    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const products = [];

        const productSelectors = [
            'div.wt-grid li.wt-grid__item-xs-6',
            'li[data-listing-id]',
            '[data-appears-component-name*="search_results"] li',
        ];

        let productElements = $([]);

        for (const selector of productSelectors) {
            const elements = $(selector);
            if (elements.length > 0) {
                log.info(`Found ${elements.length} products with: ${selector}`);
                productElements = elements;
                break;
            }
        }

        if (productElements.length === 0) {
            log.warning('No product elements found');
            return [];
        }

        productElements.each((_, element) => {
            const product = extractProductFromElement($, $(element));
            if (product) products.push(product);
        });

        log.info(`Extracted ${products.length} products`);
        return products;

    } catch (error) {
        log.warning(`HTML parsing failed: ${error.message}`);
        return [];
    }
}

/**
 * Extract product from DOM element
 */
function extractProductFromElement($, $el) {
    try {
        const linkEl = $el.find('a[href*="/listing/"]').first();
        let url = linkEl.attr('href') || '';
        if (url && !url.startsWith('http')) {
            url = `https://www.etsy.com${url}`;
        }

        const listingId = $el.attr('data-listing-id') ||
            (url.match(/\/listing\/(\d+)/) || [])[1] || '';

        // Title
        let title = '';
        const titleEl = $el.find('h3').first();
        if (titleEl.length) title = titleEl.text().trim();

        // Price
        let price = '';
        let currency = 'USD';
        const priceEl = $el.find('span[class*="currency-value"]').first();
        if (priceEl.length) {
            const priceText = priceEl.text().trim();
            price = priceText.replace(/[^0-9.,]/g, '').trim();
        }

        // Image
        let image = '';
        const imgEl = $el.find('img[src*="i.etsystatic.com"]').first();
        if (imgEl.length) {
            image = imgEl.attr('data-src') || imgEl.attr('src') || '';
            if (image) image = image.replace(/(_\d+x\d+)/, '_fullxfull');
        }

        // Seller
        let seller = '';
        const sellerEl = $el.find('p[class*="shop"]').first();
        if (sellerEl.length) seller = sellerEl.text().trim();

        // Rating
        let rating = null;
        const ratingEl = $el.find('[aria-label*="out of 5 stars"]').first();
        if (ratingEl.length) {
            const ariaLabel = ratingEl.attr('aria-label') || '';
            const ratingMatch = ariaLabel.match(/(\d+(?:\.\d+)?)\s*out of/i);
            if (ratingMatch) rating = parseFloat(ratingMatch[1]);
        }

        // Review Count
        let reviewCount = null;
        const reviewEl = $el.find('span.wt-text-caption').first();
        if (reviewEl.length) {
            const text = reviewEl.text().trim();
            const reviewMatch = text.match(/\(?([0-9,]+)\)?/);
            if (reviewMatch) reviewCount = parseInt(reviewMatch[1].replace(/,/g, ''));
        }

        const freeShipping = $el.find('[class*="free-shipping"]').length > 0;

        if (title || url) {
            return {
                listingId,
                title: title || 'Unknown Title',
                price,
                currency,
                image,
                url,
                seller,
                rating,
                reviewCount,
                freeShipping,
                scrapedAt: new Date().toISOString()
            };
        }
        return null;
    } catch (err) {
        return null;
    }
}

/**
 * Build Etsy search URL
 * Priority: searchUrl > searchQuery
 */
function buildSearchUrl(input) {
    // 1. Use direct URL if provided
    if (input.searchUrl?.trim()) {
        log.info('Using provided search URL');
        return input.searchUrl.trim();
    }

    const baseUrl = 'https://www.etsy.com';

    // 2. Use searchQuery with /search endpoint
    if (input.searchQuery?.trim()) {
        const url = new URL(`${baseUrl}/search`);
        url.searchParams.append('q', input.searchQuery.trim());
        url.searchParams.append('ref', 'search_bar');
        if (input.minPrice) url.searchParams.append('min_price', input.minPrice.toString());
        if (input.maxPrice) url.searchParams.append('max_price', input.maxPrice.toString());
        log.info(`Using search query: "${input.searchQuery}"`);
        return url.toString();
    }

    // 3. Fallback error - require either searchUrl or searchQuery
    throw new Error('Please provide either "searchUrl" or "searchQuery"');
}

/**
 * Save debug info
 */
async function saveDebugInfo(page, reason) {
    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const title = $('title').text();

        log.warning(`DEBUG (${reason}): ${title}`, {
            divCount: $('div').length,
            hasVerification: html.includes('Verification') || html.includes('captcha'),
        });

        await Actor.setValue('DEBUG_PAGE_HTML', html, { contentType: 'text/html' });
    } catch (error) {
        log.warning(`Debug save failed: ${error.message}`);
    }
}

// ============================================================================
// MAIN ACTOR EXECUTION
// ============================================================================

try {
    const input = await Actor.getInput() || {};

    log.info('Starting Etsy Scraper with Camoufox + handleCloudflareChallenge', {
        searchQuery: input.searchQuery,
        category: input.category,
        maxProducts: input.maxProducts,
    });

    if (!input.searchUrl?.trim() && !input.searchQuery?.trim()) {
        throw new Error('Please provide either "searchUrl" or "searchQuery"');
    }

    const maxProducts = input.maxProducts ?? 50;
    const enrichDetails = input.enrichDetails === true; // Default OFF
    const maxEnrich = Math.min(maxProducts, 15);

    const searchUrl = buildSearchUrl(input);
    log.info(`Search URL: ${searchUrl}`);

    // Residential proxy configuration
    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
    });

    let totalProductsScraped = 0;
    let pagesProcessed = 0;
    const startTime = Date.now();
    const seenProductIds = new Set();

    // Official Crawlee pattern for Camoufox with handleCloudflareChallenge
    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: 100,
        maxConcurrency: 1, // Single concurrency for stealth
        navigationTimeoutSecs: 120,
        requestHandlerTimeoutSecs: 300,
        maxRequestRetries: 3,

        // CRITICAL: Use handleCloudflareChallenge in postNavigationHooks
        postNavigationHooks: [
            async ({ handleCloudflareChallenge }) => {
                // This handles Cloudflare Turnstile and similar challenges
                await handleCloudflareChallenge();
            }
        ],

        // CRITICAL: Disable Crawlee fingerprinting to avoid conflicts with Camoufox
        browserPoolOptions: {
            useFingerprints: false,
        },

        // Camoufox launch configuration
        launchContext: {
            launcher: firefox,
            launchOptions: await launchOptions({
                headless: true,
            }),
        },

        async requestHandler({ page, request }) {
            pagesProcessed++;
            log.info(`Processing page ${pagesProcessed}: ${request.url}`);

            try {
                // Wait for page to settle after navigation + handleCloudflareChallenge
                await page.waitForTimeout(3000);

                // Simulate human behavior
                await simulateHumanBehavior(page);

                // Check for blocks with retry - give handleCloudflareChallenge time to work
                let isBlocked = true;
                const retryDelays = [5000, 8000, 10000]; // Increasing delays

                for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
                    const title = await page.title();
                    const hasProducts = await page.$('li[data-listing-id], div.wt-grid li');

                    if (title !== 'etsy.com' && !title.includes('Verification') && hasProducts) {
                        isBlocked = false;
                        break;
                    }

                    if (attempt < retryDelays.length) {
                        log.info(`Page may be blocked, waiting ${retryDelays[attempt] / 1000}s for challenge to clear (attempt ${attempt + 1}/${retryDelays.length})...`);
                        await page.waitForTimeout(retryDelays[attempt]);
                        // Scroll and move mouse to trigger JS loading
                        await page.evaluate(() => window.scrollBy(0, 100));
                        await page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 200);
                    }
                }

                if (isBlocked) {
                    log.warning('Page still blocked after retries');
                    await saveDebugInfo(page, 'blocked');
                    throw new Error('Page blocked');
                }

                // Extract products
                let products = await extractProductDataViaHTML(page);

                if (products.length === 0) {
                    log.warning('No products found');
                    await saveDebugInfo(page, 'no-products');
                    return;
                }

                log.info(`✓ Extracted ${products.length} products`);

                // Limit and deduplicate
                let productsToSave = maxProducts > 0
                    ? products.slice(0, Math.max(0, maxProducts - totalProductsScraped))
                    : products;

                const uniqueProducts = productsToSave.filter(product => {
                    const productId = product.listingId || product.url;
                    if (!productId) return true;
                    if (seenProductIds.has(productId)) return false;
                    seenProductIds.add(productId);
                    return true;
                });

                // Enrich with detail page data (pushes data internally in batches)
                if (enrichDetails && uniqueProducts.length > 0 && totalProductsScraped < maxEnrich) {
                    const enrichCount = Math.min(maxEnrich - totalProductsScraped, uniqueProducts.length);
                    if (enrichCount > 0) {
                        const result = await enrichProductsWithDetails(uniqueProducts, page, enrichCount);
                        totalProductsScraped += result.total;
                        log.info(`Total scraped: ${totalProductsScraped}`);
                    }
                } else if (uniqueProducts.length > 0) {
                    // No enrichment - push directly
                    await Actor.pushData(uniqueProducts);
                    totalProductsScraped += uniqueProducts.length;
                    log.info(`Saved ${uniqueProducts.length} products. Total: ${totalProductsScraped}`);
                }

                if (maxProducts > 0 && totalProductsScraped >= maxProducts) {
                    log.info(`Reached limit: ${maxProducts}`);
                    return;
                }

                // PAGINATION - Scroll to bottom first
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(1500);

                // Try to find next page
                const nextPageUrl = await page.evaluate((currentUrl) => {
                    // Multiple selector strategies
                    const selectors = [
                        'a[data-page][rel="next"]',
                        'a[href*="page="][rel="next"]',
                        'a[aria-label*="Next" i]',
                        'nav[aria-label="Pagination"] a:last-child',
                        'a[href*="page="]:not([aria-current])',
                    ];

                    for (const selector of selectors) {
                        const link = document.querySelector(selector);
                        if (link?.href) return link.href;
                    }

                    // Text-based search
                    const links = document.querySelectorAll('a[href]');
                    for (const link of links) {
                        const text = link.textContent?.trim().toLowerCase();
                        const aria = link.getAttribute('aria-label')?.toLowerCase() || '';
                        if ((text === 'next' || text === '→' || aria.includes('next')) && link.href) {
                            return link.href;
                        }
                    }

                    // Manual page construction
                    const url = new URL(currentUrl);
                    const currentPage = parseInt(url.searchParams.get('page') || '1');
                    url.searchParams.set('page', (currentPage + 1).toString());
                    return url.toString();
                }, request.url);

                if (nextPageUrl && totalProductsScraped < maxProducts) {
                    log.info(`Next page: ${nextPageUrl}`);
                    await crawler.addRequests([{ url: nextPageUrl, uniqueKey: nextPageUrl }]);
                }

            } catch (error) {
                log.error(`Error: ${error.message}`, { url: request.url });
                throw error;
            }
        },

        async failedRequestHandler({ request }, error) {
            log.error(`Failed: ${request.url} - ${error.message}`);
        }
    });

    log.info('Starting crawler with Camoufox + handleCloudflareChallenge...');
    await crawler.run([searchUrl]);

    const duration = Math.round((Date.now() - startTime) / 1000);

    const statistics = {
        totalProductsScraped,
        pagesProcessed,
        enrichmentEnabled: enrichDetails,
        duration: `${duration} seconds`,
    };

    await Actor.setValue('statistics', statistics);
    log.info('✓ Completed!', statistics);

} catch (error) {
    log.exception(error, 'Actor failed');
    throw error;
}

await Actor.exit();
