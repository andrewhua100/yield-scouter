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

// Sectors where high payout ratios are normal and expected
const HIGH_PAYOUT_SECTORS = ['reit', 'real estate', 'utilities', 'utility'];

// ── Calculate Dividend Safety Score (0–100) ──
// Weighted algorithm combining yield, payout ratio, beta, eps, and sector
function calcSafetyScore(data) {
  const { dividendYield, payoutRatio, beta, eps, sector } = data;
  let score = 0;
  let breakdown = {};

  const isHighPayoutSector = HIGH_PAYOUT_SECTORS.some(s =>
    (sector || '').toLowerCase().includes(s)
  );

  // ── 1. Dividend Yield (25 points) ──
  // Sweet spot is 3–8%. Too low = not worth it. Too high = could be a trap.
  let yieldScore = 0;
  const yieldPct = (dividendYield || 0) * 100;
  if (yieldPct >= 3 && yieldPct <= 8) yieldScore = 25;
  else if (yieldPct > 8 && yieldPct <= 12) yieldScore = 15; // high but risky
  else if (yieldPct > 12) yieldScore = 5;                   // likely a yield trap
  else if (yieldPct >= 1) yieldScore = 10;                  // low yield
  else yieldScore = 0;                                       // no dividend
  breakdown.yield = { score: yieldScore, max: 25, value: yieldPct.toFixed(2) + '%' };
  score += yieldScore;

  // ── 2. Earnings Payout Ratio (25 points) ──
  // What % of earnings are paid as dividends.
  // REITs/Utilities are allowed higher ratios by law.
  let payoutScore = 0;
  if (payoutRatio == null) {
    payoutScore = 10; // unknown — give neutral score
  } else {
    const pct = payoutRatio > 1 ? payoutRatio : payoutRatio * 100;
    if (isHighPayoutSector) {
      // For REITs/Utilities, up to 95% is fine
      if (pct <= 95) payoutScore = 25;
      else if (pct <= 110) payoutScore = 15;
      else payoutScore = 5;
    } else {
      if (pct <= 60) payoutScore = 25;
      else if (pct <= 80) payoutScore = 15;
      else if (pct <= 100) payoutScore = 5;
      else payoutScore = 0; // paying more than it earns
    }
  }
  breakdown.payout = { score: payoutScore, max: 25, value: payoutRatio != null ? (payoutRatio > 1 ? payoutRatio : payoutRatio * 100).toFixed(1) + '%' : 'N/A' };
  score += payoutScore;

  // ── 3. Beta / Volatility (20 points) ──
  // Lower beta = more stable = better for income investors
  let betaScore = 0;
  if (beta == null) {
    betaScore = 10; // unknown — neutral
  } else if (beta <= 0.5) betaScore = 20; // very stable
  else if (beta <= 0.8) betaScore = 17;
  else if (beta <= 1.0) betaScore = 13;
  else if (beta <= 1.3) betaScore = 8;
  else if (beta <= 1.6) betaScore = 4;
  else betaScore = 0; // very volatile
  breakdown.beta = { score: betaScore, max: 20, value: beta != null ? beta.toFixed(2) : 'N/A' };
  score += betaScore;

  // ── 4. EPS / Profitability (15 points) ──
  // Positive EPS means the company is profitable and can sustain dividends
  let epsScore = 0;
  if (eps == null) epsScore = 5;
  else if (eps > 5) epsScore = 15;
  else if (eps > 2) epsScore = 12;
  else if (eps > 0) epsScore = 8;
  else epsScore = 0; // losing money
  breakdown.eps = { score: epsScore, max: 15, value: eps != null ? '$' + eps.toFixed(2) : 'N/A' };
  score += epsScore;

  // ── 5. Sector Bonus (15 points) ──
  // Reward sectors historically known for reliable dividends
  const RELIABLE_SECTORS = [
    'consumer staples', 'utilities', 'real estate', 'reit',
    'energy', 'healthcare', 'financials', 'communication services'
  ];
  const sectorLower = (sector || '').toLowerCase();
  let sectorScore = 0;
  if (RELIABLE_SECTORS.some(s => sectorLower.includes(s))) sectorScore = 15;
  else if (sectorLower) sectorScore = 8; // known sector, just not top-tier for dividends
  else sectorScore = 5; // unknown sector
  breakdown.sector = { score: sectorScore, max: 15, value: sector || 'Unknown' };
  score += sectorScore;

  // Determine tier based on total score
  let tier, tierClass;
  if (score >= 70) { tier = 'Safe'; tierClass = 'safe'; }
  else if (score >= 40) { tier = 'Moderate'; tierClass = 'moderate'; }
  else { tier = 'Risky'; tierClass = 'risky'; }

  return { score: Math.round(score), tier, tierClass, breakdown };
}

async function fetchTickerData(ticker) {
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

  console.log(`[${ticker}] metrics:`, JSON.stringify(metricsData).slice(0, 300));

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

  const beta = metrics.betaTTM ?? profile.beta ?? quote.beta ?? null;

  // Calculate EPS from available fields
  const eps = metrics.netIncomePerShareTTM
    ?? metrics.epsTTM
    ?? quote.eps
    ?? null;

  // Calculate payout ratio ourselves: annual dividend / EPS
  // This is more reliable than fetching it since we already have both values
  let payoutRatio = null;
  if (annualDividend != null && eps != null && eps > 0) {
    payoutRatio = (annualDividend / eps); // e.g. 0.65 = 65%
  } else if (profile.payoutRatio != null) {
    payoutRatio = profile.payoutRatio;
  }

  const sector = profile.sector || null;

  console.log(`[${ticker}] beta: ${beta} | eps: ${eps} | payoutRatio: ${payoutRatio} | metrics keys: ${Object.keys(metrics).join(', ')}`);

  return {
    ticker, companyName, price, annualDividend, dividendYield,
    payoutRatio, beta, eps, sector
  };
}

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
app.get('/api/top10', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured.' });

  const WATCHLIST = [
    'MO', 'T', 'VZ', 'KO', 'PEP', 'JNJ', 'PFE', 'ABBV',
    'XOM', 'CVX', 'O', 'D', 'IBM', 'ET', 'CAG'
  ];

  try {
    const results = await Promise.allSettled(
      WATCHLIST.map(ticker => fetchTickerData(ticker))
    );

    const valid = results
      .filter(r => r.status === 'fulfilled' && r.value.dividendYield > 0)
      .map(r => r.value);

    const top10 = valid
      .sort((a, b) => b.dividendYield - a.dividendYield)
      .slice(0, 10);

    res.json(top10);
  } catch (err) {
    console.error('Error fetching top 10:', err.message);
    res.status(500).json({ error: 'Failed to fetch top 10.' });
  }
});

// ── Scores endpoint ──
// Ranks the watchlist by Safety Score rather than raw yield
app.get('/api/scores', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured.' });

  const WATCHLIST = [
    'MO', 'T', 'VZ', 'KO', 'PEP', 'JNJ', 'PFE', 'ABBV',
    'XOM', 'CVX', 'O', 'D', 'IBM', 'ET', 'CAG'
  ];

  try {
    const results = await Promise.allSettled(
      WATCHLIST.map(ticker => fetchTickerData(ticker))
    );

    const scored = results
      .filter(r => r.status === 'fulfilled')
      .map(r => {
        const data = r.value;
        const safety = calcSafetyScore(data);
        return { ...data, safety };
      })
      .sort((a, b) => b.safety.score - a.safety.score);

    res.json(scored);
  } catch (err) {
    console.error('Error fetching scores:', err.message);
    res.status(500).json({ error: 'Failed to fetch scores.' });
  }
});

app.listen(PORT, () => {
  console.log(`Yield Scout running at http://localhost:${PORT}`);
});