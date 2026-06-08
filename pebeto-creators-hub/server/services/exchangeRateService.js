const ExchangeRateCache = require('../models/ExchangeRateCache');
const env = require('../config/env');
const { BASE_CURRENCY } = require('../config/constants');
const { AppError } = require('../utils/errors');

const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchRatesFromApi() {
  if (!env.exchangeRateApiKey) return { USD: 1, KES: 130, EUR: 0.92, GBP: 0.79 };
  
  const url = `${env.exchangeRateApiUrl}/${env.exchangeRateApiKey}/latest/${BASE_CURRENCY}`;
  console.log("DEBUG: Fetching from URL:", url); // <--- Add this
  
  const res = await fetch(url);
  const data = await res.json();
  
  console.log("DEBUG: API Response Keys:", Object.keys(data.conversion_rates || {})); // <--- Add this
  
  if (data.result !== 'success' || !data.conversion_rates) {
    throw new AppError('Invalid exchange rate API response', 502);
  }
  return data.conversion_rates;
}

async function getRatesMap() {
  const now = new Date();
  const cached = await ExchangeRateCache.findOne({ base: BASE_CURRENCY });

  if (cached && cached.expiresAt && cached.expiresAt > now) {
    return cached.rates; // Returns as a plain object
  }

  let rates;
  try {
    rates = await fetchRatesFromApi();
    console.log("API Rates received:", Object.keys(rates));
  } catch (err) {
    if (cached && cached.rates) return cached.rates;
    rates = { USD: 1, KES: 130, EUR: 0.92, GBP: 0.79 };
  }

  await ExchangeRateCache.findOneAndUpdate(
    { base: BASE_CURRENCY },
    {
      base: BASE_CURRENCY,
      rates: rates, // Stored as a clean object
      provider: 'exchangerate-api',
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
    },
    { upsert: true, new: true }
  );
  return rates;
}

function convertUsdToLocal(usdAmount, currency, rates) {
  if (!currency || currency.toUpperCase() === BASE_CURRENCY) return usdAmount;
  
  // Safe lookup: normalize to uppercase just in case
  const upperCurrency = currency.toUpperCase();
  const rate = rates[upperCurrency];

  // Specific check to help you debug if a specific currency is missing
  if (rate === undefined || rate === null) {
    console.error(`Rate mapping failure for: ${upperCurrency}. Current rates available:`, Object.keys(rates));
    throw new AppError(`Exchange rate for ${upperCurrency} is currently unavailable.`, 400);
  }

  return Math.round(usdAmount * rate * 100) / 100;
}
module.exports = { getRatesMap, convertUsdToLocal };
