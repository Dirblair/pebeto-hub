const ExchangeRateCache = require('../models/ExchangeRateCache');
const env = require('../config/env');
const { BASE_CURRENCY } = require('../config/constants');
const { AppError } = require('../utils/errors');

const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchRatesFromApi() {
  if (!env.exchangeRateApiKey) {
    return { USD: 1 };
  }
  const url = `${env.exchangeRateApiUrl}/${env.exchangeRateApiKey}/latest/${BASE_CURRENCY}`;
  const res = await fetch(url);
  if (!res.ok) throw new AppError('Failed to fetch exchange rates', 502);
  const data = await res.json();
  if (data.result !== 'success' || !data.conversion_rates) {
    throw new AppError('Invalid exchange rate API response', 502);
  }
  return data.conversion_rates;
}

async function getRatesMap() {
  const now = new Date();
  const cached = await ExchangeRateCache.findOne({ base: BASE_CURRENCY });

  // 1. If we have valid cached data, return the rates as a plain object
  if (cached && cached.expiresAt && cached.expiresAt > now) {
    return cached.rates; // Mongoose stores this as a plain object already
  }

  let rates;
  try {
    rates = await fetchRatesFromApi();
  } catch (err) {
    if (cached && cached.rates) {
      return cached.rates;
    }
    // Fallback if API is down and no cache exists
    rates = { USD: 1, KES: 130, EUR: 0.92, GBP: 0.79 };
  }

  // 2. Update cache using a plain object
  await ExchangeRateCache.findOneAndUpdate(
    { base: BASE_CURRENCY },
    {
      base: BASE_CURRENCY,
      rates: rates, // Store as plain object, NOT a Map
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
  const rate = rates[currency.toUpperCase()];
  if (!rate) throw new AppError(`Rate not found for ${currency}`, 400);
  return Math.round(usdAmount * rate * 100) / 100;
}

module.exports = { getRatesMap, convertUsdToLocal };
