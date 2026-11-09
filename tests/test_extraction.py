import unittest

from src.main import (
    build_page_url,
    build_search_url,
    detect_rendered_page_number,
    extract_products_from_html,
    is_challenge_response,
    looks_blocked,
    normalize_pagination_base_url,
    parse_compact_number,
    parse_json_ld_products,
    parse_price_value,
    sanitize_product,
)

CARD_HTML = """
<html><head><title>Vintage prints | Etsy</title></head><body>
<nav aria-label="Pagination"><a aria-current="page">2</a></nav>
<div data-appears-component-name="search2_organic_listings_group">
  <div data-listing-id="123456" data-shop-id="987">
    <a href="/listing/123456/vintage-print" aria-label="Vintage Print Title">
      <img src="https://i.etsystatic.com/a.jpg" alt="alt text">
    </a>
    <span class="currency-symbol">$</span><span class="currency-value">24.00</span>
    <span aria-label="4.8 out of 5 stars, 1.2k reviews">stars</span>
    <a href="/shop/MyShop?ref=x">shop</a>
    <p class="shop-name">By MyShop</p>
    <p>Digital download - Free shipping</p>
  </div>
</div>
</body></html>
"""

JSON_LD_HTML = """
<html><head>
<script type="application/ld+json">
{"@type": "Product",
 "url": "https://www.etsy.com/listing/111/foo",
 "name": "Foo Print",
 "image": ["https://i.etsystatic.com/1.jpg"],
 "offers": {"price": "12.50", "priceCurrency": "USD", "seller": {"name": "FooShop"}},
 "aggregateRating": {"ratingValue": "4.9", "reviewCount": "1234"}}
</script>
</head><body></body></html>
"""


class CardExtractionTest(unittest.TestCase):
    def test_card_fields(self):
        products = extract_products_from_html(CARD_HTML)
        self.assertEqual(len(products), 1)
        product = products[0]
        self.assertEqual(product['listingId'], 123456)
        self.assertEqual(product['url'], 'https://www.etsy.com/listing/123456/vintage-print')
        self.assertEqual(product['title'], 'Vintage Print Title')
        self.assertEqual(product['price'], 24)
        self.assertEqual(product['currency'], '$')
        self.assertEqual(product['priceFormatted'], '$ 24')
        self.assertEqual(product['image'], 'https://i.etsystatic.com/a.jpg')
        self.assertEqual(product['imageUrls'], ['https://i.etsystatic.com/a.jpg'])
        self.assertEqual(product['seller'], 'MyShop')
        self.assertEqual(product['shopName'], 'MyShop')
        self.assertEqual(product['shopId'], 987)
        self.assertEqual(product['shopUrl'], 'https://www.etsy.com/shop/MyShop?ref=x')
        self.assertEqual(product['rating'], 4.8)
        self.assertEqual(product['reviewCount'], 1200)
        self.assertTrue(product['freeShipping'])
        self.assertFalse(product['hasVariations'])
        self.assertEqual(product['listingType'], 'download')
        self.assertEqual(product['source'], 'etsy_listingcards_intercept')
        self.assertTrue(product['scrapedAt'].endswith('Z'))

    def test_card_without_price_keeps_js_zero(self):
        html = '<div data-listing-id="1"><a href="/listing/1/x">no price</a></div>'
        product = extract_products_from_html(html)[0]
        self.assertEqual(product['price'], 0)
        self.assertNotIn('priceFormatted', product)

    def test_json_ld_fields(self):
        products = parse_json_ld_products(JSON_LD_HTML)
        self.assertEqual(len(products), 1)
        product = products[0]
        self.assertEqual(product['listingId'], 111)
        self.assertEqual(product['title'], 'Foo Print')
        self.assertEqual(product['price'], 12.5)
        self.assertEqual(product['currency'], 'USD')
        self.assertEqual(product['priceFormatted'], 'USD 12.5')
        self.assertEqual(product['seller'], 'FooShop')
        self.assertEqual(product['rating'], 4.9)
        self.assertEqual(product['reviewCount'], 1234)
        self.assertEqual(product['imageUrls'], ['https://i.etsystatic.com/1.jpg'])
        self.assertEqual(product['source'], 'etsy_jsonld_intercept')


class HelpersTest(unittest.TestCase):
    def test_compact_numbers(self):
        self.assertEqual(parse_compact_number('1.2k'), 1200)
        self.assertEqual(parse_compact_number('3m'), 3000000)
        self.assertEqual(parse_compact_number('45'), 45)
        self.assertIsNone(parse_compact_number(''))

    def test_localized_prices(self):
        self.assertEqual(parse_price_value('8.57'), 8.57)
        self.assertEqual(parse_price_value('24'), 24)
        self.assertEqual(parse_price_value('24.00'), 24)
        self.assertEqual(parse_price_value('162,00'), 162)
        self.assertEqual(parse_price_value('1.620,00'), 1620)
        self.assertEqual(parse_price_value('1,620.00'), 1620)
        self.assertEqual(parse_price_value('1 620,00'), 1620)
        self.assertEqual(parse_price_value('R$ 1.234,56'), 1234.56)
        self.assertEqual(parse_price_value('1,234'), 1234)
        self.assertEqual(parse_price_value(''), 0)
        self.assertEqual(parse_price_value('abc'), 0)

    def test_urls(self):
        self.assertEqual(
            build_search_url({'searchQuery': 'vintage prints'}), 'https://www.etsy.com/search?q=vintage+prints'
        )
        self.assertEqual(
            build_search_url({'searchUrl': ' https://www.etsy.com/search?q=x '}), 'https://www.etsy.com/search?q=x'
        )
        base = 'https://www.etsy.com/search?q=x&page=3'
        self.assertEqual(build_page_url(base, 1), 'https://www.etsy.com/search?q=x')
        self.assertEqual(build_page_url(base, 4), 'https://www.etsy.com/search?q=x&page=4')
        self.assertEqual(
            normalize_pagination_base_url('https://www.etsy.com/search/vintage?q=x&page=2', base),
            'https://www.etsy.com/search/vintage?q=x',
        )
        self.assertEqual(normalize_pagination_base_url('https://www.etsy.com/search?q=x&page=2', base), base)

    def test_rendered_page_number(self):
        self.assertEqual(detect_rendered_page_number(CARD_HTML), 2)
        self.assertIsNone(detect_rendered_page_number('<html></html>'))

    def test_challenge_detection(self):
        self.assertTrue(is_challenge_response(403, ''))
        self.assertTrue(is_challenge_response(200, 'Are you human?'))
        self.assertFalse(is_challenge_response(200, '<html>normal page</html>'))
        self.assertTrue(looks_blocked(200, 'etsy.com', ''))
        self.assertTrue(looks_blocked(429, '', ''))
        self.assertFalse(looks_blocked(200, 'Vintage prints | Etsy', '<html>ok</html>'))

    def test_sanitize_keeps_false_and_zero(self):
        result = sanitize_product({'a': None, 'b': '', 'c': [], 'd': False, 'e': 0, 'f': 'x'})
        self.assertEqual(result, {'d': False, 'e': 0, 'f': 'x'})


if __name__ == '__main__':
    unittest.main()
