# Etsy Product Listings Scraper

Extract Etsy product listing data at scale for research, analysis, and monitoring. Collect clean listing records with pricing, seller details, images, ratings, and listing links in a structured dataset. Ideal for market intelligence, catalog tracking, and trend analysis workflows.

---

## Features

- **Targeted Search Collection** — Collect listing data from Etsy search results using keywords, filters, and sorting.
- **Price Range Filtering** — Narrow results with minimum and maximum price constraints.
- **Structured Output** — Receive normalized records ready for analytics and downstream automation.
- **Automatic Pagination** — Continue across multiple pages until your limits are reached.
- **Clean Dataset Records** — Output excludes empty fields so your data stays concise and usable.
- **Flexible Export** — Download run results in JSON, CSV, Excel, and other Apify dataset formats.

---

## Use Cases

### Product Research
Analyze listing titles, prices, and ratings for niches before launching products or campaigns.

### Competitive Monitoring
Track how sellers position products, price items, and present listings over time.

### Trend Discovery
Identify recurring product themes and categories by scraping focused keyword searches.

### Pricing Analysis
Build datasets for price benchmarking across similar products and segments.

### Data Pipelines
Send structured listing output to BI tools, spreadsheets, warehouses, or internal services.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `searchUrl` | String | No | — | Full Etsy search URL. If provided, it is used directly. |
| `searchQuery` | String | No | `"vintage prints"` | Search keyword(s) used when `searchUrl` is not provided. |
| `results_wanted` | Integer | No | `20` | Maximum products to collect (`0` = unlimited). |
| `maxPages` | Integer | No | `2` | Maximum result pages to visit. |
| `proxyConfiguration` | Object | No | `{ "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }` | Proxy settings for reliability and anti-blocking. |

---

## Output Data

Each dataset item contains available listing fields such as:

| Field | Type | Description |
|-------|------|-------------|
| `listingId` | Number | Etsy listing identifier. |
| `title` | String | Listing title. |
| `url` | String | Listing URL. |
| `price` | Number | Parsed listing price. |
| `currency` | String | Currency symbol from listing card. |
| `priceFormatted` | String | Price formatted for display. |
| `image` | String | Primary image URL. |
| `imageUrls` | Array | Available image URLs. |
| `seller` | String | Seller/shop display name. |
| `shopId` | Number | Shop identifier when available. |
| `shopName` | String | Seller/shop name. |
| `shopUrl` | String | Shop URL when available. |
| `rating` | Number | Shop/listing card rating when available. |
| `reviewCount` | Number | Review count when available. |
| `freeShipping` | Boolean | Whether free shipping is indicated. |
| `listingType` | String | Listing type label when inferable. |
| `hasVariations` | Boolean | Whether variations are indicated. |
| `scrapedAt` | String | ISO timestamp of extraction. |
| `source` | String | Source marker for extraction path. |

---

## Usage Examples

### Basic Keyword Search

```json
{
  "searchQuery": "vintage prints",
  "results_wanted": 20
}
```

### Price-Filtered Collection

```json
{
  "searchQuery": "wall decor",
  "results_wanted": 100,
  "maxPages": 5
}
```

### Direct Search URL

```json
{
  "searchUrl": "https://www.etsy.com/search?q=ceramic+mug&order=most_recent",
  "results_wanted": 60,
  "maxPages": 4,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

---

## Sample Output

```json
{
  "listingId": 4413469874,
  "title": "Printable Rustic Two Mallard Ducks Wall Art Print",
  "url": "https://www.etsy.com/listing/4413469874/...",
  "price": 4.59,
  "currency": "$",
  "priceFormatted": "$ 4.59",
  "image": "https://i.etsystatic.com/.../il_300x300.jpg",
  "imageUrls": [
    "https://i.etsystatic.com/.../il_300x300.jpg"
  ],
  "seller": "FabolynArt",
  "shopId": 19878244,
  "shopName": "FabolynArt",
  "rating": 4.8,
  "reviewCount": 377,
  "freeShipping": false,
  "listingType": "download",
  "hasVariations": false,
  "scrapedAt": "2026-02-18T05:44:34.808Z",
  "source": "etsy_listingcards_intercept"
}
```

---

## Tips for Best Results

### Start With Focused Queries
- Use specific keywords instead of broad terms.
- Test queries with a small `results_wanted` value first.

### Control Runtime
- Keep `results_wanted` and `maxPages` aligned with your use case.
- Increase limits only after validating sample outputs.

### Improve Stability
- Use proxy configuration for consistent results.
- Add delay between pages when running larger collections.

### Validate Downstream Mapping
- Confirm required output fields in your integration pipeline.
- Build logic for optional fields that may not appear on every listing.

---

## Proxy Configuration

For reliable runs, use Apify Proxy:

```json
{
  "proxyConfiguration": {
    "useApifyProxy": true
  }
}
```

---

## Integrations

Connect your dataset to:

- **Google Sheets** — Analyze listings in spreadsheets.
- **Airtable** — Build searchable product databases.
- **Make** — Automate enrichment and notifications.
- **Zapier** — Trigger workflows from new run results.
- **Webhooks** — Push data to custom APIs.

### Export Formats

- **JSON** — Developer-friendly structured output.
- **CSV** — Spreadsheet and reporting workflows.
- **Excel** — Business review and presentation.
- **XML** — Legacy and enterprise integrations.

---

## Frequently Asked Questions

### How many listings can I collect per run?
Set `results_wanted` to your target count. Use `0` for unlimited and control scope with `maxPages`.

### Do I need to provide a search URL?
No. You can provide only `searchQuery`, and the actor builds the search URL automatically.

### Why do some fields appear only on some records?
Some listing attributes are not displayed for every item on Etsy search cards.

### Can I scrape multiple pages automatically?
Yes. The actor paginates through result pages until it reaches your limits.

### Is the dataset suitable for automation?
Yes. Output is structured and cleaned for downstream pipelines.

### Can I schedule recurring runs?
Yes. Use Apify schedules to run daily, weekly, or with custom cron timing.

---

## Support

For issues or feature requests, use the Apify Console actor page.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Apify Scheduling](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is intended for legitimate data collection and analysis. You are responsible for complying with applicable laws and website terms of service. Use collected data responsibly.

