const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Copart BidFax Proxy' });
});

// GET /history?make=toyota&model=camry&damage=front+end&year=2020
app.get('/history', async (req, res) => {
  const { make, model, damage, year } = req.query;

  if (!make || !model) {
    return res.status(400).json({ error: 'make and model are required' });
  }

  // Format for bidfax URL: lowercase, spaces to dashes
  const makeFmt = make.toLowerCase().replace(/\s+/g, '-');
  const modelFmt = model.toLowerCase().replace(/\s+/g, '-');

  const url = `https://bidfax.info/${makeFmt}/${modelFmt}/`;

  try {
    const response = await axios.get(url, {
      headers: HEADERS,
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const results = [];

    // Parse BidFax listing items
    // Each lot is typically in a card/item element
    $('div.item, article.lot, div.lot-item, .search-result-item, div[class*="lot"], li[class*="lot"]').each((i, el) => {
      if (i >= 50) return false; // limit

      const text = $(el).text();
      const priceMatch = text.match(/\$?([\d,]+)\s*(?:USD)?/);
      const dateMatch = text.match(/(\d{2}[.\/]\d{2}[.\/]\d{4}|\w+ \d{4})/);
      const mileMatch = text.match(/([\d,]+)\s*(?:miles?|mile)/i);
      const damageText = extractDamage($, el);

      if (priceMatch && parseInt(priceMatch[1].replace(',', '')) > 100) {
        results.push({
          price: parseInt(priceMatch[1].replace(/,/g, '')),
          date: dateMatch ? dateMatch[1] : null,
          mileage: mileMatch ? mileMatch[1] : null,
          damage: damageText,
          raw: text.substring(0, 200).trim(),
        });
      }
    });

    // Fallback: try to find prices in any structured way
    if (results.length === 0) {
      // Try generic price pattern across all text nodes
      const allText = $('body').text();
      const pricePattern = /\$([\d,]{3,})/g;
      let match;
      const prices = [];
      while ((match = pricePattern.exec(allText)) !== null && prices.length < 30) {
        const price = parseInt(match[1].replace(/,/g, ''));
        if (price > 200 && price < 200000) {
          prices.push(price);
        }
      }

      if (prices.length > 0) {
        // Return as generic history
        prices.forEach((price, i) => {
          results.push({ price, date: null, mileage: null, damage: damage || 'Unknown', raw: '' });
        });
      }
    }

    // Filter by year if provided
    let filtered = results;
    if (year) {
      filtered = results.filter(r => !r.raw || r.raw.includes(year));
      if (filtered.length < 3) filtered = results; // fallback to all if too few
    }

    // Filter by damage type if provided
    if (damage && damage !== 'none') {
      const dmgKeywords = damageKeywords(damage);
      const byDamage = filtered.filter(r =>
        r.damage && dmgKeywords.some(k => r.damage.toLowerCase().includes(k))
      );
      if (byDamage.length >= 3) filtered = byDamage;
    }

    // Stats
    const prices = filtered.map(r => r.price).filter(p => p > 0).sort((a, b) => a - b);
    const avg = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
    const min = prices[0] || 0;
    const max = prices[prices.length - 1] || 0;

    // Remove outliers (beyond 2 std dev)
    const stdDev = Math.sqrt(prices.map(p => Math.pow(p - avg, 2)).reduce((a, b) => a + b, 0) / prices.length);
    const cleanPrices = prices.filter(p => Math.abs(p - avg) < 2 * stdDev);
    const cleanAvg = cleanPrices.length > 0 ? Math.round(cleanPrices.reduce((a, b) => a + b, 0) / cleanPrices.length) : avg;

    res.json({
      make,
      model,
      damage: damage || 'any',
      year: year || 'any',
      total_found: filtered.length,
      stats: {
        avg: cleanAvg,
        min,
        max,
        median: prices[Math.floor(prices.length / 2)] || 0,
      },
      history: filtered.slice(0, 20),
      url,
    });

  } catch (err) {
    // If bidfax blocks, return error with details
    res.status(502).json({
      error: 'Failed to fetch from BidFax',
      details: err.message,
      url,
      suggestion: 'BidFax may be blocking requests. Try again in a few seconds.',
    });
  }
});

function extractDamage($, el) {
  const text = $(el).text().toLowerCase();
  const dmgMap = [
    ['front end', 'front'],
    ['rear end', 'rear'],
    ['side', 'side'],
    ['flood', 'flood'],
    ['fire', 'fire'],
    ['vandalism', 'vandalism'],
    ['normal wear', 'normal wear'],
    ['minor dent', 'minor dent'],
    ['rollover', 'rollover'],
    ['mechanical', 'mechanical'],
  ];
  for (const [key, label] of dmgMap) {
    if (text.includes(key)) return label;
  }
  return 'unknown';
}

function damageKeywords(damage) {
  const map = {
    none: ['normal wear', 'minor dent', 'run and drive'],
    minor: ['minor dent', 'normal wear', 'scratch'],
    front: ['front end', 'front'],
    rear: ['rear end', 'rear'],
    side: ['side', 'left side', 'right side'],
    flood: ['flood', 'water'],
    fire: ['fire', 'burn'],
    major: ['front end', 'rear end', 'rollover'],
  };
  return map[damage] || [damage];
}

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
