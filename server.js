import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FMP_API_KEY;

console.log('API KEY loaded:', API_KEY ? 'YES' : 'NO');

if (!API_KEY) {
  console.warn('Warning: FMP_API_KEY environment variable is not set.');
}

app.use(express.static(path.join(__dirname, 'public')));

// ── In-Memory Cache ──
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function cacheSet(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  console.log(`[cache] SET ${key} — expires in 24hrs. Cache size: ${cache.size}`);
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    console.log(`[cache] EXPIRED ${key}`);
    return null;
  }
  console.log(`[cache] HIT ${key}`);
  return entry.data;
}

// ── Dividend Aristocrats ──
// S&P 500 companies with 25+ consecutive years of dividend increases
// This is the gold standard list for dividend investing
// Capped at 60 to stay within 250 API calls/day (60 x 4 = 240 calls)
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
  // Mixed / Other Aristocrats
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

// ── Fetch all data for one ticker ──
// Checks cache first — only calls FMP if data is missing or expired
async function fetchTickerData(ticker) {
  const cached = cacheGet(ticker);
  if (cached) return cached;

  console.log(`[fetch] Calling FMP for ${ticker}`);

  const [quoteRes, divRes, profileRes, metricsRes] = await Promise.all([
    fetch(`https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${API_KEY}`),
    fetch(`https://financialmodelingprep.com/stable/dividends?symbol=${ticker}&apikey=${API_KEY}`),
    fetch(`https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${API_KEY}`),
    fetch(`https://financialmodelingprep.com/stable/key-metrics-ttm?symbol=${ticker}&apikey=${API_KEY}`)
  ]);

  const [quoteData, divData, profileData, metricsData] = await Promise.all([
    quoteRes.json(),
    divRes.json(),
    profileRes.json(),
    metricsRes.json()
  ]);

  if (!quoteData || quoteData.length === 0) {
    throw new Error(`Ticker "${ticker}" not found.`);
  }

  const quote = quoteData[0];
  const profile = profileData?.[0] || {};
  const metrics = Array.isArray(metricsData) && metricsData.length > 0 ? metricsData[0] : (metricsData || {});
  const price = quote.price;
  const companyName = quote.name || profile.companyName || ticker;

  const recentDiv = Array.isArray(divData) && divData.length > 0 ? divData[0] : null;
  const quarterlyDiv = recentDiv?.dividend ?? recentDiv?.adjDividend ?? null;
  const annualDividend = quarterlyDiv ? quarterlyDiv * 4 : null;
  const dividendYield = annualDividend && price ? annualDividend / price : null;

  const beta = profile.beta ?? quote.beta ?? null;

  const earningsYield = metrics.earningsYieldTTM ?? null;
  const eps = earningsYield != null && price ? earningsYield * price : (quote.eps ?? null);

  let payoutRatio = null;
  if (annualDividend != null && eps != null && eps > 0) {
    payoutRatio = annualDividend / eps;
  } else if (profile.payoutRatio != null) {
    payoutRatio = profile.payoutRatio;
  }

  const sector = profile.sector || null;

  const result = {
    ticker, companyName, price, annualDividend, dividendYield,
    payoutRatio, beta, eps, sector
  };

  cacheSet(ticker, result);
  return result;
}

// ── Cache status endpoint ──
app.get('/api/cache-status', (req, res) => {
  const entries = [];
  for (const [key, entry] of cache.entries()) {
    const minutesLeft = Math.round((entry.expiresAt - Date.now()) / 60000);
    entries.push({ ticker: key, expiresInMinutes: minutesLeft });
  }
  res.json({ totalCached: cache.size, apiCallsSaved: cache.size * 4, entries });
});

// ── Search endpoint ──
app.get('/api/stock/:ticker', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured.' });

  const ticker = req.params.ticker.toUpperCase().trim();
  if (!/^[A-Z]{1,6}$/.test(ticker)) {
    return res.status(400).json({ error: `Invalid ticker: ${ticker}` });
  }

  try {
    const data = await fetchTickerData(ticker);
    const safety = calcSafetyScore(data);
    res.json({ ...data, safety });
  } catch (err) {
    console.error(`Error fetching ${ticker}:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch stock data.' });
  }
});

// ── Top 10 endpoint ──
// Fetches all 60 Dividend Aristocrats, ranks by yield, returns top 10
// First load uses up to 240 API calls, then cached for 24hrs
app.get('/api/top10', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured.' });

  // Check if we have a cached top10 result list
  const cachedTop10 = cacheGet('__top10__');
  if (cachedTop10) return res.json(cachedTop10);

  try {
    // Fetch all aristocrats in parallel — cache means repeat calls are free
    const results = await Promise.allSettled(
      DIVIDEND_ARISTOCRATS.map(ticker => fetchTickerData(ticker))
    );

    const valid = results
      .filter(r => r.status === 'fulfilled' && r.value.dividendYield > 0)
      .map(r => r.value);

    const top10 = valid
      .sort((a, b) => b.dividendYield - a.dividendYield)
      .slice(0, 10);

    // Cache the final top10 list separately so we don't re-sort every time
    cacheSet('__top10__', top10);

    res.json(top10);
  } catch (err) {
    console.error('Error fetching top 10:', err.message);
    res.status(500).json({ error: 'Failed to fetch top 10.' });
  }
});

// ── Scores endpoint ──
// Fetches all 60 Dividend Aristocrats, ranks by Safety Score
app.get('/api/scores', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured.' });

  // Check if we have a cached scores result list
  const cachedScores = cacheGet('__scores__');
  if (cachedScores) return res.json(cachedScores);

  try {
    const results = await Promise.allSettled(
      DIVIDEND_ARISTOCRATS.map(ticker => fetchTickerData(ticker))
    );

    const scored = results
      .filter(r => r.status === 'fulfilled')
      .map(r => {
        const data = r.value;
        const safety = calcSafetyScore(data);
        return { ...data, safety };
      })
      .sort((a, b) => b.safety.score - a.safety.score);

    // Cache the final scores list
    cacheSet('__scores__', scored);

    res.json(scored);
  } catch (err) {
    console.error('Error fetching scores:', err.message);
    res.status(500).json({ error: 'Failed to fetch scores.' });
  }
});

app.listen(PORT, () => {
  console.log(`Yield Scout running at http://localhost:${PORT}`);
});