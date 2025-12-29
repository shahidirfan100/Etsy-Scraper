/**
 * Etsy Products Scraper - Production-ready Apify Actor
 * Uses PlaywrightCrawler with Camoufox for Cloudflare/Akamai bypass
 */

import { PlaywrightCrawler } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import * as cheerio from 'cheerio';

// Initialize the Apify SDK
await Actor.init();

/**
 * Extract products from window.__INITIAL_STATE__ (PRIMARY METHOD - FASTEST)
 * Etsy embeds all search results in Redux state for immediate rendering
 */
async function extractProductsViaInitialState(page) {
    log.info('Attempting to extract products via window.__INITIAL_STATE__ (Redux state)');

    try {
        const html = await page.content();

        // Extract window.__INITIAL_STATE__ using regex
        const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.+?\});?\s*(?:<\/script|window)/s);

        if (!stateMatch) {
            log.debug('window.__INITIAL_STATE__ not found in page');
            return [];
        }

        const initialState = JSON.parse(stateMatch[1]);
        const products = [];

        // Navigate to search results in the state object
        const searchResults = initialState?.search?.results?.entries ||
            initialState?.search?.results?.listings ||
            initialState?.searchResults?.results ||
            [];

        if (!Array.isArray(searchResults) || searchResults.length === 0) {
            log.debug('No search results found in initial state');
            return [];
        }

        log.info(`Found ${searchResults.length} products in window.__INITIAL_STATE__`);

        for (const item of searchResults) {
            const product = parseProductFromInitialState(item);
            if (product) products.push(product);
        }

        return products;

    } catch (error) {
        log.warning(`Initial state extraction failed: ${error.message}`);
        return [];
    }
}

/**
 * Parse product from window.__INITIAL_STATE__ data
 */
function parseProductFromInitialState(data) {
    try {
        const listing = data.listing || data;

        // Price calculation (Etsy stores price in cents)
        let priceValue = '';
        if (listing.price?.amount) {
            priceValue = (listing.price.amount / 100).toFixed(2);
        } else if (listing.price) {
            priceValue = String(listing.price);
        }

        return {
            listingId: String(listing.listing_id || listing.id || ''),
            title: listing.title || '',
            price: priceValue,
            currency: listing.price?.currency_code || listing.currency_code || 'USD',
            image: listing.img?.url_570xN || listing.image || listing.images?.[0]?.url_570xN || '',
            url: listing.url ? `https://www.etsy.com${listing.url}` : `https://www.etsy.com/listing/${listing.listing_id || listing.id}`,
            seller: listing.shop_name || listing.shop?.shop_name || '',
            rating: listing.rating || listing.avg_rating || null,
            reviewCount: listing.num_reviews || listing.review_count || null,
            favoritesCount: listing.num_favorers || 0,
            freeShipping: listing.is_free_shipping || false,
            isAd: listing.is_ad_listing || false,
            scrapedAt: new Date().toISOString(),
        };
    } catch (err) {
        log.debug(`Failed to parse product from initial state: ${err.message}`);
        return null;
    }
}

/**
 * Extract products from JSON-LD structured data (FALLBACK METHOD)
 */
async function extractProductsViaJsonLD(page) {
    log.info('Attempting to extract products via JSON-LD');

    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const products = [];

        $('script[type="application/ld+json"]').each((_, script) => {
            try {
                const data = JSON.parse($(script).html() || '{}');

                if (data['@type'] === 'Product') {
                    products.push(parseProductFromJsonLD(data));
                } else if (data['@graph']) {
                    for (const item of data['@graph']) {
                        if (item['@type'] === 'Product') {
                            products.push(parseProductFromJsonLD(item));
                        }
                    }
                }
            } catch (parseErr) {
                log.debug(`Failed to parse JSON-LD: ${parseErr.message}`);
            }
        });

        if (products.length > 0) {
            log.info(`Extracted ${products.length} products via JSON-LD`);
        }

        return products;
    } catch (error) {
        log.warning(`JSON-LD extraction failed: ${error.message}`);
        return [];
    }
}

/**
 * Parse product from JSON-LD
 */
function parseProductFromJsonLD(data) {
    const offers = data.offers || {};
    const aggregateRating = data.aggregateRating || {};

    return {
        listingId: data.sku || '',
        title: data.name || '',
        price: offers.price || '',
        currency: offers.priceCurrency || 'USD',
        image: Array.isArray(data.image) ? data.image[0] : data.image || '',
        url: data.url || '',
        seller: data.brand?.name || data.seller?.name || '',
        rating: aggregateRating.ratingValue ? parseFloat(aggregateRating.ratingValue) : null,
        reviewCount: aggregateRating.reviewCount ? parseInt(aggregateRating.reviewCount) : null,
        favoritesCount: 0,
        freeShipping: false,
        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Extract products via embedded scripts (SECONDARY METHOD)
 */
async function extractProductsViaEmbeddedData(page) {
    log.info('Attempting to extract products via embedded scripts');

    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const products = [];

        $('script:not([src])').each((_, script) => {
            const content = $(script).html() || '';

            const dataPatterns = [
                /var\s+listings\s*=\s*(\[.+?\]);/s,
                /window\.__etsy_data\s*=\s*(\{.+?\});/s,
                /"listings":\s*(\[.+?\])/s,
            ];

            for (const pattern of dataPatterns) {
                const match = content.match(pattern);
                if (match) {
                    try {
                        const data = JSON.parse(match[1]);
                        const listings = Array.isArray(data) ? data : (data.listings || []);

                        for (const item of listings) {
                            const product = parseProductFromInitialState(item);
                            if (product) products.push(product);
                        }

                        if (products.length > 0) {
                            log.info(`Found ${products.length} products in embedded scripts`);
                            return products;
                        }
                    } catch (parseErr) {
                        log.debug(`Failed to parse embedded data: ${parseErr.message}`);
                    }
                }
            }
        });

        return products;
    } catch (error) {
        log.warning(`Embedded data extraction failed: ${error.message}`);
        return [];
    }
}

/**
 * Extract products via HTML parsing (LAST RESORT)
 */
async function extractProductDataViaHTML(page) {
    log.info('Extracting product data via HTML parsing with Cheerio');

    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const products = [];

        const productSelectors = [
            'div[data-search-results-lg] li[data-search-result-index]',
            'li[data-listing-id]',
            'div.wt-grid li.wt-grid__item-xs-6',
            '[data-appears-component-name*="search_results"] li',
        ];

        let productElements = $([]);

        for (const selector of productSelectors) {
            const elements = $(selector);
            if (elements.length > 0) {
                log.info(`Found ${elements.length} products with selector: ${selector}`);
                productElements = elements;
                break;
            }
        }

        if (productElements.length === 0) {
            log.warning('No product elements found with any selector');
            return [];
        }

        productElements.each((_, element) => {
            const product = extractProductFromElement($, $(element));
            if (product) products.push(product);
        });

        log.info(`Extracted ${products.length} products via HTML parsing`);
        return products;

    } catch (error) {
        log.warning(`HTML parsing failed: ${error.message}`);
        return [];
    }
}

/**
 * Extract product data from a single DOM element
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

        const titleSelectors = ['h3[class*="title"]', 'h3.wt-text-caption', '[data-listing-card-title]'];
        let title = '';
        for (const sel of titleSelectors) {
            const titleEl = $el.find(sel).first();
            if (titleEl.length && titleEl.text().trim()) {
                title = titleEl.text().trim();
                break;
            }
        }

        const priceSelectors = ['span[class*="currency-value"]', 'span.currency-value', 'p[class*="price"]'];
        let price = '';
        let currency = 'USD';
        for (const sel of priceSelectors) {
            const priceEl = $el.find(sel).first();
            if (priceEl.length && priceEl.text().trim()) {
                const priceText = priceEl.text().trim();
                const currencyMatch = priceText.match(/([£$€¥₹]|[A-Z]{3})/);
                if (currencyMatch) {
                    const symbol = currencyMatch[1];
                    currency = { '$': 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR' }[symbol] || symbol;
                }
                price = priceText.replace(/[^0-9.,]/g, '').trim();
                break;
            }
        }

        let image = '';
        const imgEl = $el.find('img[data-listing-card-listing-image], img[src*="i.etsystatic.com"]').first();
        if (imgEl.length) {
            image = imgEl.attr('data-src') || imgEl.attr('src') || '';
            if (image) image = image.replace(/(_\d+x\d+)/, '_fullxfull');
        }

        const sellerEl = $el.find('p[class*="shop"], span.wt-text-caption').first();
        const seller = sellerEl.text().trim();

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
                rating: null,
                reviewCount: null,
                favoritesCount: 0,
                freeShipping,
                scrapedAt: new Date().toISOString()
            };
        }
        return null;
    } catch (err) {
        log.debug(`Error extracting individual product: ${err.message}`);
        return null;
    }
}

/**
 * Build Etsy search URL from input parameters
 */
function buildSearchUrl(input) {
    if (input.searchUrl && input.searchUrl.trim()) {
        log.info('Using provided search URL directly');
        return input.searchUrl.trim();
    }

    const baseUrl = 'https://www.etsy.com';

    if (input.category && input.category.trim()) {
        const categoryPath = input.category.trim();
        const url = new URL(`${baseUrl}${categoryPath.startsWith('/') ? categoryPath : '/c/' + categoryPath}`);

        if (input.searchQuery?.trim()) url.searchParams.append('q', input.searchQuery.trim());
        if (input.minPrice) url.searchParams.append('min_price', input.minPrice.toString());
        if (input.maxPrice) url.searchParams.append('max_price', input.maxPrice.toString());
        if (input.sortBy && input.sortBy !== 'relevance') url.searchParams.append('sort_order', input.sortBy);

        return url.toString();
    }

    if (input.searchQuery && input.searchQuery.trim()) {
        const url = new URL(`${baseUrl}/search`);
        url.searchParams.append('q', input.searchQuery.trim());

        if (input.minPrice) url.searchParams.append('min_price', input.minPrice.toString());
        if (input.maxPrice) url.searchParams.append('max_price', input.maxPrice.toString());
        if (input.sortBy && input.sortBy !== 'relevance') url.searchParams.append('sort_order', input.sortBy);

        return url.toString();
    }

    log.warning('No search parameters provided, using default category');
    return `${baseUrl}/c/art-and-collectibles`;
}

/**
 * Save debug info when no products found
 */
async function saveDebugInfo(page) {
    try {
        const html = await page.content();
        const $ = cheerio.load(html);

        log.warning('DEBUG: Page structure analysis', {
            title: $('title').text(),
            divCount: $('div').length,
            liCount: $('li').length,
            hasCloudflare: html.includes('Just a moment') || html.includes('cf-browser')
        });

        await Actor.setValue('DEBUG_PAGE_HTML', html, { contentType: 'text/html' });
        log.info('Saved full page HTML to DEBUG_PAGE_HTML for analysis');

    } catch (error) {
        log.warning(`Failed to save debug info: ${error.message}`);
    }
}

// ============================================================================
// MAIN ACTOR EXECUTION
// ============================================================================

try {
    const input = await Actor.getInput() || {};

    log.info('Starting Etsy Products Scraper with Camoufox stealth', {
        searchUrl: input.searchUrl,
        searchQuery: input.searchQuery,
        category: input.category,
        maxProducts: input.maxProducts
    });

    // Validate input
    if (!input.searchUrl?.trim() && !input.category?.trim() && !input.searchQuery?.trim()) {
        throw new Error('Invalid input: Provide either "searchUrl", "category", or "searchQuery"');
    }

    const maxProducts = input.maxProducts ?? 50;
    if (maxProducts < 0 || maxProducts > 10000) {
        throw new Error('maxProducts must be between 0 and 10000');
    }

    const searchUrl = buildSearchUrl(input);
    log.info(`Search URL: ${searchUrl}`);

    // checkAccess flag ensures the proxy credentials are valid
    const proxyConfiguration = await Actor.createProxyConfiguration({ checkAccess: true });

    let totalProductsScraped = 0;
    let pagesProcessed = 0;
    let extractionMethod = 'None';
    const startTime = Date.now();
    const seenProductIds = new Set();

    // PlaywrightCrawler with Camoufox for Cloudflare/Akamai bypass
    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: 20,
        maxConcurrency: 2,
        navigationTimeoutSecs: 60,
        requestHandlerTimeoutSecs: 180,
        launchContext: {
            launcher: firefox,
            launchOptions: await camoufoxLaunchOptions({
                headless: true,
                proxy: await proxyConfiguration.newUrl(),
                geoip: true,
            }),
        },

        async requestHandler({ page, request }) {
            pagesProcessed++;
            log.info(`Processing page ${pagesProcessed}: ${request.url}`);

            try {
                // Set realistic browser headers
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                });

                await page.goto(request.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });

                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

                // Handle Cloudflare challenge
                let retryCount = 0;
                const maxRetries = 3;

                while (retryCount < maxRetries) {
                    const title = await page.title();
                    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');

                    if (title.includes('Just a moment') ||
                        title.includes('Cloudflare') ||
                        bodyText.includes('unusual traffic') ||
                        bodyText.includes('Checking your browser')) {

                        log.warning(`Cloudflare challenge detected (attempt ${retryCount + 1}/${maxRetries})`);
                        await page.waitForTimeout(5000);

                        try {
                            const turnstileFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
                            const checkbox = turnstileFrame.locator('input[type="checkbox"], .cf-turnstile-wrapper');
                            if (await checkbox.count() > 0) {
                                log.info('Found Turnstile checkbox, attempting click...');
                                await checkbox.first().click({ timeout: 5000 });
                                await page.waitForTimeout(3000);
                            }
                        } catch (clickErr) {
                            log.debug('No clickable Turnstile element found');
                        }

                        await page.waitForTimeout(5000);
                        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
                        retryCount++;
                    } else {
                        break;
                    }
                }

                if (retryCount >= maxRetries) {
                    log.error('Failed to bypass Cloudflare after maximum retries');
                    await saveDebugInfo(page);
                    return;
                }

                await page.waitForTimeout(2000);

                let products = [];

                // Strategy 1: window.__INITIAL_STATE__ (PRIMARY - FASTEST)
                products = await extractProductsViaInitialState(page);
                if (products.length > 0) {
                    extractionMethod = 'window.__INITIAL_STATE__ (Redux)';
                    log.info(`✓ Initial state extraction successful: ${products.length} products`);
                }

                // Strategy 2: Embedded scripts
                if (products.length === 0) {
                    products = await extractProductsViaEmbeddedData(page);
                    if (products.length > 0) {
                        extractionMethod = 'Embedded Scripts';
                        log.info(`✓ Embedded data extraction successful: ${products.length} products`);
                    }
                }

                // Strategy 3: JSON-LD
                if (products.length === 0) {
                    products = await extractProductsViaJsonLD(page);
                    if (products.length > 0) {
                        extractionMethod = 'JSON-LD';
                        log.info(`✓ JSON-LD extraction successful: ${products.length} products`);
                    }
                }

                // Strategy 4: HTML parsing (LAST RESORT)
                if (products.length === 0) {
                    products = await extractProductDataViaHTML(page);
                    if (products.length > 0) {
                        extractionMethod = 'HTML Parsing (Cheerio)';
                        log.info(`✓ HTML parsing successful: ${products.length} products`);
                    }
                }

                if (products.length === 0) {
                    log.warning('No products found with any extraction method. Saving debug info...');
                    await saveDebugInfo(page);
                }

                if (products.length > 0) {
                    let productsToSave = maxProducts > 0
                        ? products.slice(0, Math.max(0, maxProducts - totalProductsScraped))
                        : products;

                    const uniqueProducts = productsToSave.filter(product => {
                        const productId = product.listingId || product.url;
                        if (!productId) return true;
                        if (seenProductIds.has(productId)) {
                            log.debug(`Skipping duplicate product: ${product.title}`);
                            return false;
                        }
                        seenProductIds.add(productId);
                        return true;
                    });

                    if (uniqueProducts.length < productsToSave.length) {
                        log.info(`Removed ${productsToSave.length - uniqueProducts.length} duplicate products`);
                    }

                    if (uniqueProducts.length > 0) {
                        await Actor.pushData(uniqueProducts);
                        totalProductsScraped += uniqueProducts.length;
                        log.info(`Saved ${uniqueProducts.length} products. Total: ${totalProductsScraped}`);
                    }

                    if (maxProducts > 0 && totalProductsScraped >= maxProducts) {
                        log.info(`Reached maximum products limit: ${maxProducts}`);
                        return;
                    }

                    // Handle pagination
                    const nextPageUrl = await page.evaluate(() => {
                        const nextLink = document.querySelector('a[data-id="pagination-next"]') ||
                            document.querySelector('a[aria-label="Next page"]') ||
                            document.querySelector('nav[aria-label="Pagination"] a[rel="next"]') ||
                            document.querySelector('.pagination-next');
                        return nextLink ? nextLink.href : null;
                    });

                    if (nextPageUrl && totalProductsScraped < maxProducts) {
                        log.info(`Found next page: ${nextPageUrl}`);
                        await crawler.addRequests([{ url: nextPageUrl, uniqueKey: nextPageUrl }]);
                    } else if (!nextPageUrl) {
                        log.info('No next page found - this may be the last page');
                    }
                }

            } catch (error) {
                log.error(`Error processing page: ${error.message}`, { url: request.url });
            }
        },

        async failedRequestHandler({ request }, error) {
            log.error(`Request failed: ${request.url} - ${error.message}`);
        }
    });

    log.info('Starting crawler with Camoufox stealth mode for Cloudflare bypass...');
    await crawler.run([searchUrl]);

    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000);

    const statistics = {
        totalProductsScraped,
        pagesProcessed,
        extractionMethod,
        duration: `${duration} seconds`,
        timestamp: new Date().toISOString()
    };

    await Actor.setValue('statistics', statistics);
    log.info('✓ Scraping completed successfully!', statistics);

    if (totalProductsScraped > 0) {
        log.info(`Successfully scraped ${totalProductsScraped} products in ${duration} seconds`);
    } else {
        log.warning('No products were scraped. Please check your search parameters.');
    }

} catch (error) {
    log.exception(error, 'Actor failed with error');
    throw error;
}

// Exit successfully
await Actor.exit();
