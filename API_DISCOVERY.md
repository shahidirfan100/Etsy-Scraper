## Selected API Strategy

- Endpoint: `https://www.etsy.com/search?q=<query>&page=<n>`
- Method: `GET`
- Auth: No explicit API key, but anti-bot protected; run through Apify proxy sessions.
- Pagination: `page` query parameter.
- Primary extraction payloads:
  - Server-rendered listing card HTML blocks (`data-listing-id` entries)
  - JSON-LD (`script[type="application/ld+json"]`) product entities
- Why selected:
  - Works as API-like HTTP path with no full browser render cost.
  - Returns listing fields needed for dataset and can be merged with JSON-LD metadata.
  - Significantly faster than browser-only when not challenged.

## Candidate Endpoints Considered

1. `GET /search` HTML + JSON-LD
- Score: 75
- JSON directly: partial (JSON-LD blocks)
- Field coverage: 15+ merged fields
- Auth: no explicit auth token
- Pagination: yes (`page`)
- Stability: good with residential proxy, fallback required when challenged

2. `GET /api/v3/ajax/bespoke/member/neu/specs/listingCards`
- Score: 48
- JSON directly: yes
- Field coverage: rich
- Auth: context-dependent; requires browser/XHR state and can fail when initial page is challenged
- Pagination: yes, but tied to page runtime state
- Decision: keep as Playwright fallback intercept source, not primary path

## New/Improved Field Path

- Existing output fields are preserved.
- Additional source path: JSON-LD enriches these when present:
  - `rating`
  - `reviewCount`
  - `imageUrls`
  - `price` / `currency`

## Runtime Strategy

- Public input keeps only search/query/pagination and proxy controls.
- Runtime tuning is internal in `main.js` (retry/timeouts/challenge recovery).
- Data extraction is Playwright/Camoufox-driven with listingCards API interception and direct API replay from browser context.

This keeps the actor fast by default while retaining stealth recovery for protected responses.
