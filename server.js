// Import required libraries
import express from 'express'; // Express is the web server framework
import fetch from 'node-fetch'; // fetch lets us make HTTP requests to the FMP API
import path from 'path'; // path helps us build file paths
import { fileURLToPath } from 'url'; // needed to get the current directory in ES modules

// Get the current directory (needed because we're using ES modules)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create the Express app
const app = express();

// Use port from environment variable (Render sets this) or default to 3000 locally
const PORT = process.env.PORT || 3000;

// Get the FMP API key from environment variables (never hardcoded)
const API_KEY = process.env.FMP_API_KEY;

// Log whether the API key was found — useful for debugging
console.log('API KEY loaded:', API_KEY ? 'YES' : 'NO');

// Warn if no API key is set
if (!API_KEY) {
  console.warn('⚠️  Warning: FMP_API_KEY environment variable is not set.');
}

// Serve the frontend files from the public/ folder
// When someone visits your site, they get index.html
app.use(express.static(path.join(__dirname, 'public')));

// This is the API endpoint the frontend calls
// When the user searches for e.g. "KO", the frontend calls /api/stock/KO
app.get('/api/stock/:ticker', async (req, res) => {

  // If no API key, return an error immediately
  if (!API_KEY) {
    return res.status(500).json({ error: 'Server is not configured with an API key.' });
  }

  // Get the ticker from the URL and make it uppercase (e.g. "ko" → "KO")
  const ticker = req.params.ticker.toUpperCase().trim();

  // Validate the ticker — must be 1-5 capital letters only
  if (!/^[A-Z]{1,5}$/.test(ticker)) {
    return res.status(400).json({ error: `Invalid ticker: ${ticker}` });
  }

  try {
    // Make 3 API calls to FMP at the same time (in parallel, so it's faster)
    const [quoteRes, profileRes, dividendRes] = await Promise.all([
      // Quote endpoint: gets current price, volume, market cap etc.
      fetch(`https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${API_KEY}`),
      // Profile endpoint: gets company name, description etc.
      fetch(`https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${API_KEY}`),
      // Dividends calendar: gets recent dividend payments for all stocks
      fetch(`https://financialmodelingprep.com/stable/dividends-calendar?symbol=${ticker}&apikey=${API_KEY}`)
    ]);

    // Parse all 3 responses from JSON at the same time
    const [quoteData, profileData, dividendData] = await Promise.all([
      quoteRes.json(),
      profileRes.json(),
      dividendRes.json()
    ]);

    // If no quote data found, the ticker doesn't exist
    if (!quoteData || quoteData.length === 0) {
      return res.status(404).json({ error: `Ticker "${ticker}" not found.` });
    }

    // Get the first (most recent) result from each response
    const quote = quoteData[0];
    const profile = profileData?.[0] || {};

    // The dividend calendar returns data for many stocks
    // Find the entry that matches our specific ticker
    const tickerDividend = dividendData?.find(d => d.symbol === ticker) || {};

    // Calculate annual dividend by multiplying quarterly dividend by 4
    // e.g. KO pays $0.53/quarter → $2.12/year
    const annualDividend = tickerDividend.dividend ? tickerDividend.dividend * 4 : null;

    // Convert yield from percentage to decimal
    // e.g. FMP returns 2.66 → we store 0.0266
    const dividendYield = tickerDividend.yield ? tickerDividend.yield / 100 : null;

    // Send the data back to the frontend
    res.json({ quote, profile, dividend: { annualDividend, dividendYield } });

  } catch (err) {
    // If anything goes wrong, log it and return an error
    console.error(`Error fetching ${ticker}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch stock data. Please try again.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Yield Scout running at http://localhost:${PORT}`);
});