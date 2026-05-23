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

async function fetchTickerData(ticker) {
  const [quoteRes, divRes] = await Promise.all([
    fetch(`https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${API_KEY}`),
    fetch(`https://financialmodelingprep.com/stable/dividends?symbol=${ticker}&apikey=${API_KEY}`)
  ]);

  const [quoteData, divData] = await Promise.all([
    quoteRes.json(),
    divRes.json()
  ]);

  console.log(`[${ticker}] quote:`, JSON.stringify(quoteData).slice(0, 200));
  console.log(`[${ticker}] div:`, JSON.stringify(divData).slice(0, 200));

  if (!quoteData || quoteData.length === 0) {
    throw new Error(`Ticker "${ticker}" not found.`);
  }

  const quote = quoteData[0];
  const price = quote.price;
  const companyName = quote.name || ticker;

  const recentDiv = Array.isArray(divData) && divData.length > 0 ? divData[0] : null;
  const quarterlyDiv = recentDiv?.dividend ?? recentDiv?.adjDividend ?? null;
  const annualDividend = quarterlyDiv ? quarterlyDiv * 4 : null;
  const dividendYield = annualDividend && price ? annualDividend / price : null;

  return { ticker, companyName, price, annualDividend, dividendYield };
}

app.get('/api/stock/:ticker', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured.' });

  const ticker = req.params.ticker.toUpperCase().trim();
  if (!/^[A-Z]{1,6}$/.test(ticker)) {
    return res.status(400).json({ error: `Invalid ticker: ${ticker}` });
  }

  try {
    const data = await fetchTickerData(ticker);
    res.json(data);
  } catch (err) {
    console.error(`Error fetching ${ticker}:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch stock data.' });
  }
});

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

app.listen(PORT, () => {
  console.log(`Yield Scout running at http://localhost:${PORT}`);
});