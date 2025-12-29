/**
 * Etsy Products Scraper - Production-ready Apify Actor
 * Uses PlaywrightCrawler with Camoufox for Cloudflare/Akamai bypass
 * Includes detail page enrichment for full descriptions
 */

import { PlaywrightCrawler } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import * as cheerio from 'cheerio';

// Initialize the Apify SDK
await Actor.init();

/**
 * Extract product detail from individual product page
 */
async function extractProductDetail(page) {
    const html = await page.content();
    const $ = cheerio.load(html);

    // Full description
    const descriptionSelectors = [
        '[data-product-details-description]',
        '#wt-content-toggle-product-details-read-more',
        '.wt-content-toggle__body',
        '[data-appears-component-name="product-details-description"]',
        'p[data-product-details-description-text-content]',
    ];
    let description = '';
    for (const sel of descriptionSelectors) {
        const descEl = $(sel).first();
        if (descEl.length && descEl.text().trim()) {
            description = descEl.text().trim();
            break;
        }
    }

    // Materials
    const materialsSelectors = [
        '[data-materials]',
        '#materials li',
        '.materials-list li',
    ];
    const materials = [];
    $(materialsSelectors.join(', ')).each((_, el) => {
        const text = $(el).text().trim();
        if (text) materials.push(text);
    });

    // Tags/Categories
    const tags = [];
    $('[data-tag], .wt-badge, [role="listitem"] a[href*="/search?q="]').each((_, el) => {
        const text = $(el).text().trim();
        if (text && !tags.includes(text)) tags.push(text);
    });

    // Shop info
    const shopUrl = $('a[href*="/shop/"]').first().attr('href') || '';
    const shopLocation = $('[data-shop-location], .shop-location').first().text().trim();

    // Additional images
    const images = [];
    $('img[src*="i.etsystatic.com"][data-index], .carousel-pane img').each((_, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src') || '';
        if (src && !images.includes(src)) {
            images.push(src.replace(/(_\d+x\d+)/, '_fullxfull'));
        }
    });

    // Item details/attributes
    const attributes = {};
    $('ul[data-product-details-item-details] li, .item-details li').each((_, li) => {
        const text = $(li).text().trim();
        const [key, ...valueParts] = text.split(':');
        if (key && valueParts.length) {
            attributes[key.trim()] = valueParts.join(':').trim();
        }
    });

    // Shipping info
    const shippingInfo = $('[data-estimated-delivery], .estimated-delivery').first().text().trim();

    // Policy info (returns, exchanges)
    const returnPolicy = $('[data-returns-and-exchanges], .returns-and-exchanges').first().text().trim();

    // Sales count
    let salesCount = null;
    const salesText = $('[data-shop-sales-count]').first().text();
    const salesMatch = salesText.match(/([0-9,]+)\s*sales/i);
    if (salesMatch) {
        salesCount = parseInt(salesMatch[1].replace(/,/g, ''));
    }

    return {
        description: description || null,
        materials: materials.length ? materials : null,
        tags: tags.length ? tags.slice(0, 10) : null,
        shopUrl: shopUrl || null,
        shopLocation: shopLocation || null,
        additionalImages: images.length > 1 ? images : null,
        attributes: Object.keys(attributes).length ? attributes : null,
        shippingInfo: shippingInfo || null,
        returnPolicy: returnPolicy || null,
        salesCount: salesCount,
    };
}

/**
 * Enrich products with detail page data using Playwright
 */
async function enrichProductsWithDetails(products, page, maxEnrich = 10) {
    if (products.length === 0) return products;

    const productsToEnrich = products.slice(0, maxEnrich);
    log.info(`Fetching details for ${productsToEnrich.length} products...`);

    const enrichedProducts = [];

    for (let i = 0; i < productsToEnrich.length; i++) {
        const product = productsToEnrich[i];

        if (!product.url) {
            enrichedProducts.push(product);
            continue;
        }

        try {
            log.info(`Enriching product ${i + 1}/${productsToEnrich.length}: ${product.title.substring(0, 40)}...`);

            await page.goto(product.url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });

            // Check for Cloudflare challenge on detail page
            const title = await page.title();
            if (title.includes('Just a moment') || title.includes('Cloudflare')) {
                log.warning(`Cloudflare detected on detail page, waiting...`);
                await page.waitForTimeout(5000);
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
            }

            const details = await extractProductDetail(page);

            enrichedProducts.push({
                ...product,
                description: details.description,
                materials: details.materials,
                tags: details.tags,
                shopUrl: details.shopUrl,
                shopLocation: details.shopLocation,
                additionalImages: details.additionalImages,
                attributes: details.attributes,
                shippingInfo: details.shippingInfo,
                returnPolicy: details.returnPolicy,
                salesCount: details.salesCount,
            });

            // Small delay between requests to avoid rate limiting
            if (i < productsToEnrich.length - 1) {
                await page.waitForTimeout(1000);
            }

        } catch (error) {
            log.warning(`Failed to enrich product: ${error.message}`);
            enrichedProducts.push(product);
        }
    }

    // Add remaining products without enrichment
    for (let i = maxEnrich; i < products.length; i++) {
        enrichedProducts.push(products[i]);
    }

    log.info(`Enriched ${Math.min(productsToEnrich.length, enrichedProducts.length)} products with details`);
    return enrichedProducts;
}

/**
 * Extract products via HTML parsing (PRIMARY METHOD)
 */
async function extractProductDataViaHTML(page) {
    log.info('Extracting product data via HTML parsing with Cheerio');

    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const products = [];

        const productSelectors = [
            'div.wt-grid li.wt-grid__item-xs-6',
            'div[data-search-results-lg] li[data-search-result-index]',
            'li[data-listing-id]',
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

        // Title
        const titleSelectors = ['h3[class*="title"]', 'h3.wt-text-caption', '[data-listing-card-title]', 'a[href*="/listing/"] h3'];
        let title = '';
        for (const sel of titleSelectors) {
            const titleEl = $el.find(sel).first();
            if (titleEl.length && titleEl.text().trim()) {
                title = titleEl.text().trim();
                break;
            }
        }

        // Price
        const priceSelectors = ['span[class*="currency-value"]', 'span.currency-value', 'p[class*="price"]', '.wt-text-title-01'];
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

        // Image
        let image = '';
        const imgEl = $el.find('img[data-listing-card-listing-image], img[src*="i.etsystatic.com"], img[data-src*="i.etsystatic.com"]').first();
        if (imgEl.length) {
            image = imgEl.attr('data-src') || imgEl.attr('src') || '';
            if (image) image = image.replace(/(_\d+x\d+)/, '_fullxfull');
        }

        // Seller
        const sellerSelectors = ['p[class*="shop"]', '.v2-listing-card__shop', 'span.wt-text-caption'];
        let seller = '';
        for (const sel of sellerSelectors) {
            const sellerEl = $el.find(sel).first();
            if (sellerEl.length && sellerEl.text().trim()) {
                seller = sellerEl.text().trim();
                break;
            }
        }

        // Rating
        let rating = null;
        const ratingSelectors = ['div[aria-label*="out of 5 stars"]', '[aria-label*="out of 5 stars"]', 'input[name="rating"]'];
        for (const sel of ratingSelectors) {
            const ratingEl = $el.find(sel).first();
            if (ratingEl.length) {
                const ariaLabel = ratingEl.attr('aria-label') || '';
                const ratingMatch = ariaLabel.match(/(\d+(?:\.\d+)?)\s*out of/i);
                if (ratingMatch) {
                    rating = parseFloat(ratingMatch[1]);
                    break;
                }
                const dataRating = ratingEl.attr('data-rating');
                if (dataRating) {
                    rating = parseFloat(dataRating);
                    break;
                }
            }
        }

        // Review Count
        let reviewCount = null;
        const reviewSelectors = ['span.wt-text-caption', 'p.wt-text-body-smaller', 'span.wt-text-gray'];
        for (const sel of reviewSelectors) {
            const reviewEls = $el.find(sel);
            reviewEls.each((_, reviewEl) => {
                const text = $(reviewEl).text().trim();
                const reviewMatch = text.match(/\(?([0-9,]+)\)?\s*(?:reviews?)?/i);
                if (reviewMatch && reviewMatch[1]) {
                    const count = parseInt(reviewMatch[1].replace(/,/g, ''));
                    if (!isNaN(count) && count > 0) {
                        reviewCount = count;
                        return false;
                    }
                }
            });
            if (reviewCount) break;
        }

        const freeShipping = $el.find('[class*="free-shipping"], [data-free-shipping="true"]').length > 0;

        let favoritesCount = 0;
        const favEl = $el.find('[data-favorites-count]').first();
        if (favEl.length) {
            favoritesCount = parseInt(favEl.attr('data-favorites-count') || '0') || 0;
        }

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
                favoritesCount,
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
        maxProducts: input.maxProducts,
        enrichDetails: input.enrichDetails
    });

    if (!input.searchUrl?.trim() && !input.category?.trim() && !input.searchQuery?.trim()) {
        throw new Error('Invalid input: Provide either "searchUrl", "category", or "searchQuery"');
    }

    const maxProducts = input.maxProducts ?? 50;
    const enrichDetails = input.enrichDetails !== false; // Default true
    const maxEnrich = Math.min(maxProducts, 20); // Limit enrichment to avoid timeouts

    if (maxProducts < 0 || maxProducts > 10000) {
        throw new Error('maxProducts must be between 0 and 10000');
    }

    const searchUrl = buildSearchUrl(input);
    log.info(`Search URL: ${searchUrl}`);

    const proxyConfiguration = await Actor.createProxyConfiguration({ checkAccess: true });

    let totalProductsScraped = 0;
    let pagesProcessed = 0;
    const startTime = Date.now();
    const seenProductIds = new Set();

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: 50,
        maxConcurrency: 2,
        navigationTimeoutSecs: 60,
        requestHandlerTimeoutSecs: 300, // Increased for detail page enrichment
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

                // Handle Cloudflare
                let retryCount = 0;
                const maxRetries = 3;

                while (retryCount < maxRetries) {
                    const title = await page.title();
                    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');

                    if (title.includes('Just a moment') || title.includes('Cloudflare') ||
                        bodyText.includes('unusual traffic') || bodyText.includes('Checking your browser')) {

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

                // Extract products from listing page
                let products = await extractProductDataViaHTML(page);

                if (products.length === 0) {
                    log.warning('No products found. Saving debug info...');
                    await saveDebugInfo(page);
                    return;
                }

                log.info(`✓ HTML parsing successful: ${products.length} products`);

                // Limit products to remaining quota
                let productsToSave = maxProducts > 0
                    ? products.slice(0, Math.max(0, maxProducts - totalProductsScraped))
                    : products;

                // Remove duplicates
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

                // Enrich with detail page data if enabled
                let finalProducts = uniqueProducts;
                if (enrichDetails && uniqueProducts.length > 0) {
                    const enrichCount = Math.min(maxEnrich - totalProductsScraped, uniqueProducts.length);
                    if (enrichCount > 0) {
                        finalProducts = await enrichProductsWithDetails(uniqueProducts, page, enrichCount);
                    }
                }

                if (finalProducts.length > 0) {
                    await Actor.pushData(finalProducts);
                    totalProductsScraped += finalProducts.length;
                    log.info(`Saved ${finalProducts.length} products. Total: ${totalProductsScraped}`);
                }

                if (maxProducts > 0 && totalProductsScraped >= maxProducts) {
                    log.info(`Reached maximum products limit: ${maxProducts}`);
                    return;
                }

                // Pagination
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
        enrichmentEnabled: enrichDetails,
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

await Actor.exit();
