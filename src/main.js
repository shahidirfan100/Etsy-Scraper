/**
 * Etsy Products Scraper - Production-ready Apify Actor
 * Uses PlaywrightCrawler with Camoufox for anti-bot bypass
 * Includes advanced stealth and CAPTCHA handling
 */

import { PlaywrightCrawler } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import * as cheerio from 'cheerio';

// Initialize the Apify SDK
await Actor.init();

/**
 * Simulate human-like mouse movement for slider CAPTCHA
 */
async function solveSliderCaptcha(page) {
    log.info('Attempting to solve slider CAPTCHA...');

    try {
        // Wait for captcha to appear
        await page.waitForTimeout(2000);

        // Look for the slider button
        const sliderSelectors = [
            'button.slider-button',
            '[class*="slider"] button',
            'div[class*="captcha"] button',
            '[aria-label*="slide"]',
            'button[class*="geetest"]',
            '.geetest_slider_button',
        ];

        let sliderButton = null;
        for (const selector of sliderSelectors) {
            const element = await page.$(selector);
            if (element) {
                sliderButton = element;
                log.info(`Found slider button with selector: ${selector}`);
                break;
            }
        }

        if (!sliderButton) {
            // Try finding by arrow icon or similar
            sliderButton = await page.$('button:has-text("→"), [class*="arrow"]');
        }

        if (!sliderButton) {
            log.warning('Slider button not found');
            return false;
        }

        // Get button position
        const box = await sliderButton.boundingBox();
        if (!box) {
            log.warning('Could not get slider button position');
            return false;
        }

        const startX = box.x + box.width / 2;
        const startY = box.y + box.height / 2;

        // Calculate slide distance (usually full width of slider track)
        const sliderTrack = await page.$('[class*="slider-track"], [class*="geetest_slider"]');
        let slideDistance = 250; // Default
        if (sliderTrack) {
            const trackBox = await sliderTrack.boundingBox();
            if (trackBox) {
                slideDistance = trackBox.width - box.width - 10;
            }
        }

        // Human-like slide with acceleration/deceleration
        await page.mouse.move(startX, startY);
        await page.waitForTimeout(100 + Math.random() * 200);
        await page.mouse.down();

        // Slide with human-like movement (ease-out curve)
        const steps = 30 + Math.floor(Math.random() * 20);
        for (let i = 1; i <= steps; i++) {
            const progress = i / steps;
            // Ease-out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            const currentX = startX + slideDistance * eased;
            // Add small vertical wobble
            const wobbleY = startY + (Math.random() - 0.5) * 3;

            await page.mouse.move(currentX, wobbleY);
            await page.waitForTimeout(10 + Math.random() * 20);
        }

        await page.waitForTimeout(100 + Math.random() * 200);
        await page.mouse.up();

        log.info('Slider moved, waiting for verification...');
        await page.waitForTimeout(3000);

        return true;

    } catch (error) {
        log.warning(`Slider CAPTCHA solving failed: ${error.message}`);
        return false;
    }
}

/**
 * Handle various CAPTCHA types
 */
async function handleCaptcha(page) {
    const pageContent = await page.content();
    const pageTitle = await page.title();

    // Check for verification page
    const hasVerification =
        pageTitle.includes('Verification') ||
        pageContent.includes('Verification Required') ||
        pageContent.includes('Slide right to complete') ||
        pageContent.includes('unusual activity') ||
        pageContent.includes('geetest');

    if (!hasVerification) {
        return true; // No CAPTCHA
    }

    log.warning('CAPTCHA/Verification detected, attempting to solve...');

    // Try solving slider CAPTCHA
    const solved = await solveSliderCaptcha(page);

    if (solved) {
        await page.waitForTimeout(3000);
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

        // Check if still blocked
        const newTitle = await page.title();
        if (!newTitle.includes('Verification') && !newTitle.includes('etsy.com')) {
            log.info('CAPTCHA appears to be solved!');
            return true;
        }
    }

    log.warning('CAPTCHA could not be automatically solved');
    return false;
}

/**
 * Simulate human browsing behavior
 */
async function simulateHumanBehavior(page) {
    // Random scroll
    const scrollAmount = 300 + Math.floor(Math.random() * 500);
    await page.evaluate((amount) => {
        window.scrollBy({ top: amount, behavior: 'smooth' });
    }, scrollAmount);

    await page.waitForTimeout(500 + Math.random() * 1000);

    // Random mouse movements
    const viewport = page.viewportSize();
    if (viewport) {
        for (let i = 0; i < 3; i++) {
            const x = 100 + Math.random() * (viewport.width - 200);
            const y = 100 + Math.random() * (viewport.height - 200);
            await page.mouse.move(x, y, { steps: 10 });
            await page.waitForTimeout(100 + Math.random() * 200);
        }
    }

    // Scroll back up slightly
    await page.evaluate(() => {
        window.scrollBy({ top: -100, behavior: 'smooth' });
    });

    await page.waitForTimeout(300 + Math.random() * 500);
}

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
    $('[data-materials] li, #materials li, .materials-list li').each((_, el) => {
        const text = $(el).text().trim();
        if (text) materials.push(text);
    });

    // Tags
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
    $('img[src*="i.etsystatic.com"]').each((_, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src') || '';
        if (src && !images.includes(src) && images.length < 10) {
            images.push(src.replace(/(_\d+x\d+)/, '_fullxfull'));
        }
    });

    // Item attributes
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
        salesCount: salesCount,
    };
}

/**
 * Enrich products with detail page data
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

            // Handle CAPTCHA on detail page
            await handleCaptcha(page);

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
                salesCount: details.salesCount,
            });

            // Random delay between requests
            await page.waitForTimeout(1500 + Math.random() * 1500);

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
 * Extract products via HTML parsing
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

        const titleSelectors = ['h3[class*="title"]', 'h3.wt-text-caption', '[data-listing-card-title]', 'a[href*="/listing/"] h3'];
        let title = '';
        for (const sel of titleSelectors) {
            const titleEl = $el.find(sel).first();
            if (titleEl.length && titleEl.text().trim()) {
                title = titleEl.text().trim();
                break;
            }
        }

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

        let image = '';
        const imgEl = $el.find('img[data-listing-card-listing-image], img[src*="i.etsystatic.com"], img[data-src*="i.etsystatic.com"]').first();
        if (imgEl.length) {
            image = imgEl.attr('data-src') || imgEl.attr('src') || '';
            if (image) image = image.replace(/(_\d+x\d+)/, '_fullxfull');
        }

        const sellerSelectors = ['p[class*="shop"]', '.v2-listing-card__shop', 'span.wt-text-caption'];
        let seller = '';
        for (const sel of sellerSelectors) {
            const sellerEl = $el.find(sel).first();
            if (sellerEl.length && sellerEl.text().trim()) {
                seller = sellerEl.text().trim();
                break;
            }
        }

        let rating = null;
        const ratingSelectors = ['div[aria-label*="out of 5 stars"]', '[aria-label*="out of 5 stars"]'];
        for (const sel of ratingSelectors) {
            const ratingEl = $el.find(sel).first();
            if (ratingEl.length) {
                const ariaLabel = ratingEl.attr('aria-label') || '';
                const ratingMatch = ariaLabel.match(/(\d+(?:\.\d+)?)\s*out of/i);
                if (ratingMatch) {
                    rating = parseFloat(ratingMatch[1]);
                    break;
                }
            }
        }

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
 * Build Etsy search URL
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
 * Save debug info
 */
async function saveDebugInfo(page) {
    try {
        const html = await page.content();
        const $ = cheerio.load(html);

        log.warning('DEBUG: Page structure analysis', {
            title: $('title').text(),
            divCount: $('div').length,
            liCount: $('li').length,
            hasCloudflare: html.includes('Just a moment') || html.includes('cf-browser'),
            hasVerification: html.includes('Verification Required') || html.includes('Slide right'),
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
    const enrichDetails = input.enrichDetails !== false;
    const maxEnrich = Math.min(maxProducts, 20);

    if (maxProducts < 0 || maxProducts > 10000) {
        throw new Error('maxProducts must be between 0 and 10000');
    }

    const searchUrl = buildSearchUrl(input);
    log.info(`Search URL: ${searchUrl}`);

    const proxyConfiguration = await Actor.createProxyConfiguration({
        checkAccess: true,
        groups: ['RESIDENTIAL'], // Use residential proxies for better success
    });

    let totalProductsScraped = 0;
    let pagesProcessed = 0;
    const startTime = Date.now();
    const seenProductIds = new Set();

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: 50,
        maxConcurrency: 1, // Single concurrency for better stealth
        navigationTimeoutSecs: 90,
        requestHandlerTimeoutSecs: 300,
        maxRequestRetries: 5, // More retries for blocked requests
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
                // Set realistic headers
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                    'Cache-Control': 'max-age=0',
                });

                // Navigate with longer timeout
                await page.goto(request.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 90000
                });

                await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => { });

                // Handle CAPTCHA/verification
                const captchaSolved = await handleCaptcha(page);

                if (!captchaSolved) {
                    // Try refreshing and waiting
                    log.info('Refreshing page after CAPTCHA...');
                    await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => { });
                    await handleCaptcha(page);
                }

                // Simulate human browsing
                await simulateHumanBehavior(page);

                // Wait for content to load
                await page.waitForTimeout(2000);

                // Check for valid page content
                const pageTitle = await page.title();
                if (pageTitle === 'etsy.com' || pageTitle.includes('Verification')) {
                    log.warning('Still on blocked/verification page');
                    await saveDebugInfo(page);
                    throw new Error('Page blocked by CAPTCHA');
                }

                // Extract products
                let products = await extractProductDataViaHTML(page);

                if (products.length === 0) {
                    log.warning('No products found. Saving debug info...');
                    await saveDebugInfo(page);
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

                // Enrich with detail page data
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
                        document.querySelector('nav[aria-label="Pagination"] a[rel="next"]');
                    return nextLink ? nextLink.href : null;
                });

                if (nextPageUrl && totalProductsScraped < maxProducts) {
                    log.info(`Found next page: ${nextPageUrl}`);
                    await crawler.addRequests([{ url: nextPageUrl, uniqueKey: nextPageUrl }]);
                }

            } catch (error) {
                log.error(`Error processing page: ${error.message}`, { url: request.url });
                throw error; // Trigger retry
            }
        },

        async failedRequestHandler({ request }, error) {
            log.error(`Request failed after retries: ${request.url} - ${error.message}`);
        }
    });

    log.info('Starting crawler with Camoufox stealth + CAPTCHA handling...');
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
    log.info('✓ Scraping completed!', statistics);

    if (totalProductsScraped > 0) {
        log.info(`Successfully scraped ${totalProductsScraped} products in ${duration} seconds`);
    } else {
        log.warning('No products were scraped. The site may be blocking all requests.');
    }

} catch (error) {
    log.exception(error, 'Actor failed with error');
    throw error;
}

await Actor.exit();
