/**
 * Exchange Rate Service for Pebeto Creator's Hub
 * 
 * Handles currency exchange rates with caching, fallback rates,
 * and bidirectional conversion for international payments.
 * Supports USD, KES, EUR, GBP, and other global currencies.
 * 
 * @module services/exchangeRateService
 */

const ExchangeRateCache = require('../models/ExchangeRateCache');
const env = require('../config/env');
const { BASE_CURRENCY, SUPPORTED_CURRENCIES } = require('../config/constants');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

// ============================================
// Constants
// ============================================

const CACHE_TTL_MS = (env.exchangeRateCacheTtl || 3600) * 1000; // Default 1 hour
const DEFAULT_FALLBACK_RATES = {
  USD: 1,
  KES: 130,
  EUR: 0.92,
  GBP: 0.79,
  NGN: 750,
  ZAR: 18.5,
  GHS: 12.5,
  TZS: 2600,
  UGX: 3800,
  CAD: 1.35,
  AUD: 1.52,
  CHF: 0.91,
  CNY: 7.24,
  JPY: 148,
  INR: 83,
  SEK: 10.5,
  NZD: 1.65,
};

// ============================================
// Helper Functions
// ============================================

/**
 * Normalize currency code to uppercase
 * @param {string} currency - Currency code
 * @returns {string} Uppercase currency code
 */
function normalizeCurrency(currency) {
  if (!currency) return BASE_CURRENCY;
  return currency.toUpperCase().trim();
}

/**
 * Validate currency is supported
 * @param {string} currency - Currency code to validate
 * @returns {boolean} True if supported
 */
function isCurrencySupported(currency) {
  const normalized = normalizeCurrency(currency);
  return SUPPORTED_CURRENCIES.includes(normalized) || Object.keys(DEFAULT_FALLBACK_RATES).includes(normalized);
}

/**
 * Round amount to appropriate decimal places
 * @param {number} amount - Amount to round
 * @param {string} currency - Currency code
 * @returns {number} Rounded amount
 */
function roundAmount(amount, currency = BASE_CURRENCY) {
  // Different currencies have different decimal places
  const zeroDecimalCurrencies = ['JPY', 'KRW', 'VND', 'UGX', 'TZS'];
  const decimals = zeroDecimalCurrencies.includes(normalizeCurrency(currency)) ? 0 : 2;
  const multiplier = Math.pow(10, decimals);
  return Math.round(amount * multiplier) / multiplier;
}

// ============================================
// API Fetch Functions
// ============================================

/**
 * Fetch exchange rates from external API
 * @returns {Promise<Object>} Exchange rates object
 */
async function fetchRatesFromApi() {
  // If no API key, return fallback rates
  if (!env.exchangeRateApiKey) {
    logger.warn('No exchange rate API key provided. Using fallback rates.');
    return { ...DEFAULT_FALLBACK_RATES };
  }
  
  const url = `${env.exchangeRateApiUrl}/${env.exchangeRateApiKey}/latest/${BASE_CURRENCY}`;
  
  try {
    logger.debug('Fetching exchange rates from API', { url: url.replace(env.exchangeRateApiKey, '***') });
    
    const response = await fetch(url, {
      timeout: 10000,
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      throw new Error(`API returned status ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.result !== 'success' || !data.conversion_rates) {
      logger.error('Invalid exchange rate API response', { data });
      throw new AppError('Invalid exchange rate API response', 502);
    }
    
    // Filter and format rates
    const rates = {};
    for (const [currency, rate] of Object.entries(data.conversion_rates)) {
      if (SUPPORTED_CURRENCIES.includes(currency) || Object.keys(DEFAULT_FALLBACK_RATES).includes(currency)) {
        rates[currency] = rate;
      }
    }
    
    // Ensure base currency is always 1
    rates[BASE_CURRENCY] = 1;
    
    logger.info('Exchange rates fetched successfully', {
      base: BASE_CURRENCY,
      currencies: Object.keys(rates).length,
      timestamp: new Date().toISOString(),
    });
    
    return rates;
    
  } catch (error) {
    logger.error('Failed to fetch exchange rates from API', {
      error: error.message,
      url: url.replace(env.exchangeRateApiKey, '***'),
    });
    throw error;
  }
}

// ============================================
// Main Service Functions
// ============================================

/**
 * Get current exchange rates map (with caching)
 * @param {boolean} forceRefresh - Force refresh from API
 * @returns {Promise<Object>} Exchange rates object
 */
async function getRatesMap(forceRefresh = false) {
  const now = new Date();
  const cached = await ExchangeRateCache.findOne({ base: BASE_CURRENCY });
  
  // Check if cache is valid
  const isCacheValid = cached && cached.expiresAt && cached.expiresAt > now && !forceRefresh;
  
  if (isCacheValid) {
    logger.debug('Using cached exchange rates', {
      fetchedAt: cached.fetchedAt,
      expiresAt: cached.expiresAt,
      currencies: cached.rates ? Object.keys(cached.rates).length : 0,
    });
    return cached.rates;
  }
  
  // Fetch fresh rates
  let rates;
  try {
    rates = await fetchRatesFromApi();
    logger.info('Exchange rates fetched from API', { currencies: Object.keys(rates).length });
  } catch (error) {
    // If fetch fails but we have stale cache, use it
    if (cached && cached.rates) {
      logger.warn('Using stale cache due to API failure', {
        staleSince: cached.expiresAt,
        error: error.message,
      });
      return cached.rates;
    }
    
    // Fallback to default rates
    logger.error('Using fallback rates due to API failure', { error: error.message });
    rates = { ...DEFAULT_FALLBACK_RATES };
  }
  
  // Update cache
  await ExchangeRateCache.findOneAndUpdate(
    { base: BASE_CURRENCY },
    {
      base: BASE_CURRENCY,
      rates,
      provider: 'exchangerate-api',
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
    },
    { upsert: true, new: true }
  );
  
  return rates;
}

/**
 * Convert USD amount to local currency
 * @param {number} usdAmount - Amount in USD
 * @param {string} currency - Target currency code
 * @param {Object} rates - Exchange rates object (optional, will fetch if not provided)
 * @returns {Promise<number>} Amount in local currency
 */
async function convertUsdToLocal(usdAmount, currency, rates = null) {
  const targetCurrency = normalizeCurrency(currency);
  
  if (!targetCurrency || targetCurrency === BASE_CURRENCY) {
    return roundAmount(usdAmount, targetCurrency);
  }
  
  if (!rates) {
    rates = await getRatesMap();
  }
  
  const rate = rates[targetCurrency];
  
  if (rate === undefined || rate === null) {
    logger.error(`Exchange rate not available for ${targetCurrency}`, {
      availableRates: Object.keys(rates),
      requestedCurrency: targetCurrency,
    });
    throw new AppError(`Exchange rate for ${targetCurrency} is currently unavailable. Please try again later.`, 400);
  }
  
  const result = usdAmount * rate;
  return roundAmount(result, targetCurrency);
}

/**
 * Convert local currency amount to USD
 * @param {number} localAmount - Amount in local currency
 * @param {string} currency - Source currency code
 * @param {Object} rates - Exchange rates object (optional, will fetch if not provided)
 * @returns {Promise<number>} Amount in USD
 */
async function convertLocalToUsd(localAmount, currency, rates = null) {
  const sourceCurrency = normalizeCurrency(currency);
  
  if (!sourceCurrency || sourceCurrency === BASE_CURRENCY) {
    return roundAmount(localAmount, BASE_CURRENCY);
  }
  
  if (!rates) {
    rates = await getRatesMap();
  }
  
  const rate = rates[sourceCurrency];
  
  if (rate === undefined || rate === null) {
    logger.error(`Exchange rate not available for ${sourceCurrency}`, {
      availableRates: Object.keys(rates),
      requestedCurrency: sourceCurrency,
    });
    throw new AppError(`Exchange rate for ${sourceCurrency} is currently unavailable. Please try again later.`, 400);
  }
  
  const result = localAmount / rate;
  return roundAmount(result, BASE_CURRENCY);
}

/**
 * Get exchange rate between two currencies
 * @param {string} fromCurrency - Source currency
 * @param {string} toCurrency - Target currency
 * @param {Object} rates - Exchange rates object (optional)
 * @returns {Promise<number>} Exchange rate
 */
async function getExchangeRate(fromCurrency, toCurrency, rates = null) {
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  
  if (from === to) return 1;
  
  if (!rates) {
    rates = await getRatesMap();
  }
  
  // Convert through base currency
  const fromRate = from === BASE_CURRENCY ? 1 : rates[from];
  const toRate = to === BASE_CURRENCY ? 1 : rates[to];
  
  if (fromRate === undefined) {
    throw new AppError(`Exchange rate not available for ${from}`, 400);
  }
  if (toRate === undefined) {
    throw new AppError(`Exchange rate not available for ${to}`, 400);
  }
  
  return toRate / fromRate;
}

/**
 * Format amount with currency symbol
 * @param {number} amount - Amount to format
 * @param {string} currency - Currency code
 * @returns {string} Formatted amount
 */
function formatCurrency(amount, currency = BASE_CURRENCY) {
  const normalized = normalizeCurrency(currency);
  const rounded = roundAmount(amount, normalized);
  
  const symbols = {
    USD: '$',
    EUR: '€',
    GBP: '£',
    KES: 'KSh',
    NGN: '₦',
    ZAR: 'R',
    GHS: '₵',
    TZS: 'TSh',
    UGX: 'USh',
    JPY: '¥',
    CNY: '¥',
    INR: '₹',
    CHF: 'Fr',
    CAD: 'C$',
    AUD: 'A$',
    SEK: 'kr',
    NZD: 'NZ$',
  };
  
  const symbol = symbols[normalized] || normalized;
  const isSymbolFirst = !['KES', 'NGN', 'TZS', 'UGX', 'SEK'].includes(normalized);
  
  if (isSymbolFirst) {
    return `${symbol} ${rounded.toFixed(2)}`;
  }
  return `${rounded.toFixed(2)} ${symbol}`;
}

/**
 * Get all supported currencies with their current rates
 * @param {string} baseCurrency - Base currency (default: USD)
 * @returns {Promise<Object>} Currencies with rates
 */
async function getSupportedCurrencies(baseCurrency = BASE_CURRENCY) {
  const rates = await getRatesMap();
  const base = normalizeCurrency(baseCurrency);
  
  // Calculate rates relative to requested base
  const relativeRates = {};
  const baseRate = rates[base] || 1;
  
  for (const [currency, rate] of Object.entries(rates)) {
    relativeRates[currency] = rate / baseRate;
  }
  
  return {
    base,
    rates: relativeRates,
    lastUpdated: new Date().toISOString(),
    currencies: SUPPORTED_CURRENCIES.map(code => ({
      code,
      name: getCurrencyName(code),
      rate: relativeRates[code] || null,
    })),
  };
}

/**
 * Get currency display name
 * @param {string} currency - Currency code
 * @returns {string} Currency name
 */
function getCurrencyName(currency) {
  const names = {
    USD: 'US Dollar',
    KES: 'Kenyan Shilling',
    EUR: 'Euro',
    GBP: 'British Pound',
    NGN: 'Nigerian Naira',
    ZAR: 'South African Rand',
    GHS: 'Ghanaian Cedi',
    TZS: 'Tanzanian Shilling',
    UGX: 'Ugandan Shilling',
    JPY: 'Japanese Yen',
    CNY: 'Chinese Yuan',
    INR: 'Indian Rupee',
    CHF: 'Swiss Franc',
    CAD: 'Canadian Dollar',
    AUD: 'Australian Dollar',
    SEK: 'Swedish Krona',
    NZD: 'New Zealand Dollar',
  };
  return names[normalizeCurrency(currency)] || currency;
}

/**
 * Invalidate exchange rate cache (force refresh on next request)
 * @returns {Promise<void>}
 */
async function invalidateCache() {
  await ExchangeRateCache.deleteMany({ base: BASE_CURRENCY });
  logger.info('Exchange rate cache invalidated');
}

/**
 * Get cache status (for admin monitoring)
 * @returns {Promise<Object>} Cache status
 */
async function getCacheStatus() {
  const cached = await ExchangeRateCache.findOne({ base: BASE_CURRENCY });
  
  if (!cached) {
    return { isCached: false, message: 'No cache entry found' };
  }
  
  const now = new Date();
  const isExpired = cached.expiresAt <= now;
  
  return {
    isCached: true,
    isExpired,
    fetchedAt: cached.fetchedAt,
    expiresAt: cached.expiresAt,
    timeToExpiryMs: Math.max(0, cached.expiresAt - now),
    currenciesCount: cached.rates ? Object.keys(cached.rates).length : 0,
    provider: cached.provider,
  };
}

// ============================================
// Express Middleware
// ============================================

/**
 * Express middleware to attach exchange rate service to req
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function attachExchangeService(req, res, next) {
  req.exchangeService = {
    convertUsdToLocal: (amount, currency) => convertUsdToLocal(amount, currency),
    convertLocalToUsd: (amount, currency) => convertLocalToUsd(amount, currency),
    getExchangeRate: (from, to) => getExchangeRate(from, to),
    formatCurrency: (amount, currency) => formatCurrency(amount, currency),
    getRatesMap: () => getRatesMap(),
  };
  next();
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Main functions
  getRatesMap,
  convertUsdToLocal,
  convertLocalToUsd,
  getExchangeRate,
  formatCurrency,
  
  // Admin functions
  invalidateCache,
  getCacheStatus,
  getSupportedCurrencies,
  getCurrencyName,
  
  // Utilities
  normalizeCurrency,
  isCurrencySupported,
  roundAmount,
  
  // Middleware
  attachExchangeService,
  
  // Constants
  BASE_CURRENCY,
  SUPPORTED_CURRENCIES: SUPPORTED_CURRENCIES || Object.keys(DEFAULT_FALLBACK_RATES),
  DEFAULT_FALLBACK_RATES,
};
