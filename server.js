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
  console.warn('⚠️  Warning: FMP_API_KEY environment variable is not set.');
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stock/:ticker', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'Server is not configured with an API key.' });
  }

  const ticker = req.params.ticker.toUpperCase().trim();

  if (!/^[A-Z]{1,5}$/.test(ticker)) {
    return res.status(400).json({ error: `Invalid ticker: ${ticker}` });
  }

  try {
    const [quoteRes, profileRes, dividendRes] = await Promise.all([
      fetch(`https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${API_KEY}`),
      fetch(`https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${API_KEY}`),
      fetch(`https://financialmodelingprep.com/stable/dividends-calendar?symbol=${ticker}&apikey=${API_KEY}`)
    ]);

    const [quoteData, profileData, dividendData] = await Promise.all([
      quoteRes.json(),
      profileRes.json(),
      dividendRes.json()
    ]);

    console.log('FMP quote:', JSON.stringify(quoteData));
    console.log('FMP dividend:', JSON.stringify(dividendData));

    if (!quoteData || quoteData.length === 0) {
      return res.status(404).json({ error: `Ticker "${ticker}" not found.` });
    }

    const quote = quoteData[0];
    const profile = profileData?.[0] || {};
    const dividend = dividendData?.[0] || {};

    res.json({ quote, profile, dividend });
  } catch (err) {
    console.error(`Error fetching ${ticker}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch stock data. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Yield Scout running at http://localhost:${PORT}`);
});