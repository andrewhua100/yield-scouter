import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import * as _yf from 'yahoo-finance2';
const yahooFinance = _yf.default ?? _yf;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

console.log('Yahoo Finance: ready (no API key required)');
console.log('Redis loaded:', REDIS_URL ? 'YES' : 'NO');

if (!REDIS_URL) console.warn('Warning: UPSTASH_REDIS_REST_URL is not set — falling back to in-memory cache.');

app.use(express.static(path.join(__dirname, 'public')));

// ── Cache TTL ──
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// ── Redis Cache (Upstash REST API) ──
// Direct REST calls: POST /set and GET /get/:key
function redisHeaders() {
  return {
    'Authorization': 'Bearer ' + (REDIS_TOKEN || '').trim(),
    'Content-Type': 'application/json'
  };
}

async function redisSet(key, value) {
  try {
    const base = (REDIS_URL || '').trim().replace(/\/$/, '');
    const encodedKey = encodeURIComponent(key);
    const encodedVal = encodeURIComponent(JSON.stringify(value));
    const url = `${base}/set/${encodedKey}/${encodedVal}?EX=${CACHE_TTL_SECONDS}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: redisHeaders()
    });
    const data = await res.json();
    console.log(`[redis] SET ${key}:`, data.result, data.error || '');
  } catch (err) {
    console.error(`[redis] SET error for ${key}:`, err.message);
  }
}

async function redisGet(key) {
  try {
    const base = (REDIS_URL || '').trim().replace(/\/$/, '');
    const res = await fetch(base + '/get/' + encodeURIComponent(key), {
      method: 'GET',
      headers: redisHeaders()
    });
    const data = await res.json();
    if (data.result == null) { console.log(`[redis] MISS ${key}`); return null; }
    console.log(`[redis] HIT ${key}`);
    return JSON.parse(data.result);
  } catch (err) {
    console.error(`[redis] GET error for ${key}:`, err.message);
    return null;
  }
}

// ── In-memory fallback cache ──
const memCache = new Map();

async function cacheSet(key, value) {
  if (REDIS_URL && REDIS_TOKEN) {
    await redisSet(key, value);
  } else {
    memCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
    console.log(`[memcache] SET ${key}`);
  }
}

async function cacheGet(key) {
  if (REDIS_URL && REDIS_TOKEN) {
    return await redisGet(key);
  } else {
    const entry = memCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { memCache.delete(key); return null; }
    console.log(`[memcache] HIT ${key}`);
    return entry.value;
  }
}

// ── Dividend Aristocrats ──
const DIVIDEND_ARISTOCRATS = [
  // Consumer Staples
  'KO', 'PEP', 'PG', 'CL', 'KMB', 'MKC', 'SYY', 'GPC', 'CLX', 'HRL',
  // Healthcare
  'JNJ', 'ABT', 'ABBV', 'BDX', 'MDT', 'WST', 'CAH', 'AFL',
  // Financials
  'AOS', 'BRO', 'CB', 'FRT', 'CINF', 'MMC', 'SHW', 'T', 'VZ',
  // Industrials
  'EMR', 'ITW', 'CAT', 'GWW', 'DOV', 'PH', 'SWK', 'TGT', 'SPGI', 'ECL',
  // Energy
  'XOM', 'CVX', 'ET', 'MO',
  // Real Estate / Utilities
  'O', 'D', 'ED', 'WEC', 'ES', 'ATO',
  // Technology
  'IBM', 'TXN', 'AVGO',
  // Materials
  'APD', 'PPG', 'NUE', 'ALB',
  // Communication
  'VFC', 'LOW', 'EXPD',
  // Mixed
  'ADP', 'BEN', 'CTAS', 'EFX', 'FAST', 'LDOS', 'LECO', 'NDSN', 'ROP', 'TROW'
];

// ── Sectors where high payout ratios are normal ──
const HIGH_PAYOUT_SECTORS = ['reit', 'real estate', 'utilities', 'utility'];

// ── Calculate Dividend Safety Score (0–100) ──
function calcSafetyScore(data) {
  const { dividendYield, payoutRatio, beta, eps, sector } = data;
  let score = 0;
  let breakdown = {};

  const isHighPayoutSector = HIGH_PAYOUT_SECTORS.some(s =>
    (sector || '').toLowerCase().includes(s)
  );

  // 1. Dividend Yield (25 points)
  let yieldScore = 0;
  const yieldPct = (dividendYield || 0) * 100;
  if (yieldPct >= 3 && yieldPct <= 8) yieldScore = 25;
  else if (yieldPct > 8 && yieldPct <= 12) yieldScore = 15;
  else if (yieldPct > 12) yieldScore = 5;
  else if (yieldPct >= 1) yieldScore = 10;
  else yieldScore = 0;
  breakdown.yield = { score: yieldScore, max: 25, value: yieldPct.toFixed(2) + '%' };
  score += yieldScore;

  // 2. Payout Ratio (25 points)
  let payoutScore = 0;
  if (payoutRatio == null) {
    payoutScore = 10;
  } else {
    const pct = payoutRatio > 1 ? payoutRatio : payoutRatio * 100;
    if (isHighPayoutSector) {
      if (pct <= 95) payoutScore = 25;
      else if (pct <= 110) payoutScore = 15;
      else payoutScore = 5;
    } else {
      if (pct <= 60) payoutScore = 25;
      else if (pct <= 80) payoutScore = 15;
      else if (pct <= 100) payoutScore = 5;
      else payoutScore = 0;
    }
  }
  breakdown.payout = {
    score: payoutScore, max: 25,
    value: payoutRatio != null ? (payoutRatio > 1 ? payoutRatio : payoutRatio * 100).toFixed(1) + '%' : 'N/A'
  };
  score += payoutScore;

  // 3. Beta / Volatility (20 points)
  let betaScore = 0;
  if (beta == null) betaScore = 10;
  else if (beta <= 0.5) betaScore = 20;
  else if (beta <= 0.8) betaScore = 17;
  else if (beta <= 1.0) betaScore = 13;
  else if (beta <= 1.3) betaScore = 8;
  else if (beta <= 1.6) betaScore = 4;
  else betaScore = 0;
  breakdown.beta = { score: betaScore, max: 20, value: beta != null ? beta.toFixed(2) : 'N/A' };
  score += betaScore;

  // 4. EPS / Profitability (15 points)
  let epsScore = 0;
  if (eps == null) epsScore = 5;
  else if (eps > 5) epsScore = 15;
  else if (eps > 2) epsScore = 12;
  else if (eps > 0) epsScore = 8;
  else epsScore = 0;
  breakdown.eps = { score: epsScore, max: 15, value: eps != null ? '$' + eps.toFixed(2) : 'N/A' };
  score += epsScore;

  // 5. Sector Bonus (15 points)
  const RELIABLE_SECTORS = [
    'consumer staples', 'utilities', 'real estate', 'reit',
    'energy', 'healthcare', 'financials', 'communication services'
  ];
  const sectorLower = (sector || '').toLowerCase();
  let sectorScore = 0;
  if (RELIABLE_SECTORS.some(s => sectorLower.includes(s))) sectorScore = 15;
  else if (sectorLower) sectorScore = 8;
  else sectorScore = 5;
  breakdown.sector = { score: sectorScore, max: 15, value: sector || 'Unknown' };
  score += sectorScore;

  let tier, tierClass;
  if (score >= 70) { tier = 'Safe'; tierClass = 'safe'; }
  else if (score >= 40) { tier = 'Moderate'; tierClass = 'moderate'; }
  else { tier = 'Risky'; tierClass = 'risky'; }

  return { score: Math.round(score), tier, tierClass, breakdown };
}

// ── Fetch all data for one ticker via Yahoo Finance ──
async function fetchTickerData(ticker) {
  const cached = await cacheGet(`stock:${ticker}`);
  if (cached) return cached;

  console.log(`[fetch] Calling Yahoo Finance for ${ticker}`);

  let quote;
  try {
    quote = await yahooFinance.quoteSummary(ticker, {
      modules: ['price', 'summaryDetail', 'defaultKeyStatistics', 'assetProfile']
    });
  } catch (err) {
    throw new Error(`Ticker "${ticker}" not found or Yahoo Finance returned an error: ${err.message}`);
  }

  const price_mod = quote.price                  || {};
  const summary   = quote.summaryDetail          || {};
  const keyStats  = quote.defaultKeyStatistics   || {};
  const profile   = quote.assetProfile           || {};

  const price          = price_mod.regularMarketPrice          ?? null;
  const companyName    = price_mod.longName || price_mod.shortName || ticker;
  const sector         = profile.sector                        || null;

  // Yield: Yahoo returns as a decimal (e.g. 0.032 = 3.2%)
  const dividendYield  = summary.dividendYield                 ?? null;

  // Annual dividend amount in dollars
  const annualDividend = summary.trailingAnnualDividendRate    ?? null;

  // Payout ratio: Yahoo returns as a decimal (e.g. 0.65 = 65%)
  const payoutRatio    = summary.payoutRatio                   ?? null;

  // Beta: prefer keyStats, fall back to summaryDetail
  const beta           = keyStats.beta ?? summary.beta         ?? null;

  // EPS (trailing twelve months)
  const eps            = keyStats.trailingEps                  ?? null;

  if (price == null) {
    throw new Error(`No price data found for "${ticker}".`);
  }

  const result = {
    ticker,
    companyName,
    price,
    annualDividend,
    dividendYield,
    payoutRatio,
    beta,
    eps,
    sector
  };

  await cacheSet(`stock:${ticker}`, result);
  return result;
}

// ── Batch fetcher with concurrency control (avoids Yahoo rate limiting) ──
async function fetchInBatches(tickers, batchSize = 5, delayMs = 300) {
  const results = [];
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fetchTickerData));
    results.push(...batchResults);
    if (i + batchSize < tickers.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}

// ── Debug endpoint: raw Yahoo data for one ticker ──
app.get('/api/debug/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase().trim();
  try {
    const quote = await yahooFinance.quoteSummary(ticker, {
      modules: ['price', 'summaryDetail', 'defaultKeyStatistics', 'assetProfile']
    });
    res.json(quote);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cache status endpoint ──
app.get('/api/cache-status', async (req, res) => {
  const checks = await Promise.all(
    DIVIDEND_ARISTOCRATS.map(async ticker => {
      const data = await cacheGet(`stock:${ticker}`);
      return { ticker, cached: data !== null };
    })
  );
  const cached  = checks.filter(c =>  c.cached).map(c => c.ticker);
  const missing = checks.filter(c => !c.cached).map(c => c.ticker);
  res.json({
    cachedCount: cached.length,
    missingCount: missing.length,
    apiCallsSavedEstimate: cached.length,
    cached,
    missing
  });
});

// ── Search endpoint ──
app.get('/api/stock/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase().trim();
  if (!/^[A-Z]{1,6}$/.test(ticker)) {
    return res.status(400).json({ error: `Invalid ticker: ${ticker}` });
  }

  try {
    const data   = await fetchTickerData(ticker);
    const safety = calcSafetyScore(data);
    res.json({ ...data, safety });
  } catch (err) {
    console.error(`Error fetching ${ticker}:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch stock data.' });
  }
});

// ── Top 50 endpoint ──
app.get('/api/top10', async (req, res) => {
  const cachedTop50 = await cacheGet('__top50__');
  if (cachedTop50) return res.json(cachedTop50);

  try {
    const results = await fetchInBatches(DIVIDEND_ARISTOCRATS);

    const valid = results
      .filter(r => r.status === 'fulfilled' && r.value.dividendYield > 0)
      .map(r => r.value);

    const top50 = valid
      .sort((a, b) => b.dividendYield - a.dividendYield)
      .slice(0, 50);

    await cacheSet('__top50__', top50);
    res.json(top50);
  } catch (err) {
    console.error('Error fetching top 50:', err.message);
    res.status(500).json({ error: 'Failed to fetch top 50.' });
  }
});

// ── Scores endpoint ──
app.get('/api/scores', async (req, res) => {
  const cachedScores = await cacheGet('__scores__');
  if (cachedScores) return res.json(cachedScores);

  try {
    const results = await fetchInBatches(DIVIDEND_ARISTOCRATS);

    const failures = results.filter(r => r.status === 'rejected');
    failures.forEach(r => console.error('[scores] rejected:', r.reason?.message));
    console.log(`[scores] fulfilled: ${results.filter(r => r.status === 'fulfilled').length}, rejected: ${failures.length}`);

    const scored = results
      .filter(r => r.status === 'fulfilled')
      .map(r => {
        const data   = r.value;
        const safety = calcSafetyScore(data);
        console.log(`[scores] ${data.ticker}: price=${data.price} yield=${data.dividendYield} eps=${data.eps} beta=${data.beta}`);
        return { ...data, safety };
      })
      .sort((a, b) => b.safety.score - a.safety.score);

    await cacheSet('__scores__', scored);
    res.json(scored);
  } catch (err) {
    console.error('Error fetching scores:', err.message);
    res.status(500).json({ error: 'Failed to fetch scores.' });
  }
});

app.listen(PORT, () => {
  console.log(`Yield Scout running at http://localhost:${PORT}`);
});