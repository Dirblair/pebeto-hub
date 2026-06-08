/**
 * Exchange Rate Cache Model for Pebeto Creator's Hub
 * 
 * Stores and manages currency exchange rates with automatic expiration.
 * Provides helper methods for getting, setting, and validating rates.
 * 
 * @module models/ExchangeRateCache
 */

const mongoose = require('mongoose');

// ============================================
// Constants
// ============================================

const DEFAULT_BASE_CURRENCY = 'USD';
const DEFAULT_CACHE_TTL_HOURS = 24; // Cache expires after 24 hours
const SUPPORTED_CURRENCIES = [
  'USD', 'KES', 'EUR', 'GBP', 'UGX', 'TZS', 
  'JPY', 'INR', 'NGN', 'ZAR', 'GHS', 'CAD', 
  'AUD', 'CHF', 'CNY', 'SEK', 'NZD'
];

// ============================================
// Schema Definition
// ============================================

const exchangeRateCacheSchema = new mongoose.Schema(
  {
    // Base currency (e.g., 'USD')
    base: { 
      type: String, 
      default: DEFAULT_BASE_CURRENCY,
      uppercase: true,
      trim: true,
      required: true,
      index: true,
      validate: {
        validator: function(v) {
          return SUPPORTED_CURRENCIES.includes(v.toUpperCase());
        },
        message: `Base currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`
      }
    },
    
    // Exchange rates object: { "KES": 130.5, "EUR": 0.92, ... }
    rates: { 
      type: mongoose.Schema.Types.Mixed,
      required: true,
      validate: {
        validator: function(v) {
          if (!v || typeof v !== 'object') return false;
          // Ensure rates object has at least one rate
          return Object.keys(v).length > 0;
        },
        message: 'Rates must be a non-empty object'
      }
    },
    
    // Provider/source of the rates (e.g., 'exchangerate-api', 'openexchangerates')
    provider: {
      type: String,
      trim: true,
      default: 'unknown'
    },
    
    // When the rates were fetched from the external API
    fetchedAt: {
      type: Date,
      default: Date.now,
      required: true
    },
    
    // When the cache entry expires
    expiresAt: {
      type: Date,
      required: true,
      index: true, // Important for cleanup queries
      default: function() {
        const ttlHours = process.env.EXCHANGE_RATE_CACHE_TTL_HOURS || DEFAULT_CACHE_TTL_HOURS;
        return new Date(Date.now() + (ttlHours * 60 * 60 * 1000));
      }
    },
    
    // When this record was last accessed (for LRU cache management)
    lastAccessedAt: {
      type: Date,
      default: Date.now
    },
    
    // Number of times this cache entry has been accessed
    accessCount: {
      type: Number,
      default: 0,
      min: 0
    },
    
    // Optional metadata about the rate fetch
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true, // Adds createdAt and updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// ============================================
// Indexes
// ============================================

// Compound index for finding active cache entries
exchangeRateCacheSchema.index({ base: 1, expiresAt: 1 });

// Index for TTL cleanup (MongoDB will auto-delete expired documents if TTL index is set)
// Note: This requires a TTL index on expiresAt
exchangeRateCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Index for LRU cache management
exchangeRateCacheSchema.index({ lastAccessedAt: -1 });

// ============================================
// Virtual Fields
// ============================================

/**
 * Check if the cache entry has expired
 */
exchangeRateCacheSchema.virtual('isExpired').get(function() {
  return new Date() >= this.expiresAt;
});

/**
 * Check if the cache entry is still valid (not expired)
 */
exchangeRateCacheSchema.virtual('isValid').get(function() {
  return !this.isExpired;
});

/**
 * Time until expiration in milliseconds
 */
exchangeRateCacheSchema.virtual('ttlMs').get(function() {
  const remaining = this.expiresAt - new Date();
  return Math.max(0, remaining);
});

/**
 * Time until expiration in human-readable format
 */
exchangeRateCacheSchema.virtual('ttlHuman').get(function() {
  const remaining = this.ttlMs;
  const hours = Math.floor(remaining / (1000 * 60 * 60));
  const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
  
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
});

/**
 * Number of supported currencies in this cache
 */
exchangeRateCacheSchema.virtual('currencyCount').get(function() {
  return this.rates ? Object.keys(this.rates).length : 0;
});

// ============================================
// Instance Methods
// ============================================

/**
 * Update last accessed timestamp and increment access count
 * @returns {Promise<void>}
 */
exchangeRateCacheSchema.methods.recordAccess = async function() {
  this.lastAccessedAt = new Date();
  this.accessCount += 1;
  await this.save();
  return this;
};

/**
 * Get a specific exchange rate
 * @param {string} targetCurrency - Target currency code
 * @returns {number|null} Exchange rate or null if not found
 */
exchangeRateCacheSchema.methods.getRate = function(targetCurrency) {
  const currency = targetCurrency.toUpperCase();
  if (currency === this.base) return 1;
  return this.rates?.[currency] || null;
};

/**
 * Convert an amount using cached rates
 * @param {number} amount - Amount to convert
 * @param {string} fromCurrency - Source currency
 * @param {string} toCurrency - Target currency
 * @returns {number} Converted amount
 */
exchangeRateCacheSchema.methods.convert = function(amount, fromCurrency, toCurrency) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  
  if (from === to) return amount;
  
  // Convert to base first
  let inBase = amount;
  if (from !== this.base) {
    const rate = this.getRate(from);
    if (!rate) throw new Error(`Rate not available for ${from}`);
    inBase = amount / rate;
  }
  
  // Convert from base to target
  if (to === this.base) return inBase;
  const rate = this.getRate(to);
  if (!rate) throw new Error(`Rate not available for ${to}`);
  
  return inBase * rate;
};

/**
 * Refresh the expiration time (extend cache life)
 * @param {number} ttlHours - Hours to extend (default: DEFAULT_CACHE_TTL_HOURS)
 * @returns {Promise<void>}
 */
exchangeRateCacheSchema.methods.extendExpiry = async function(ttlHours = DEFAULT_CACHE_TTL_HOURS) {
  this.expiresAt = new Date(Date.now() + (ttlHours * 60 * 60 * 1000));
  await this.save();
  return this;
};

// ============================================
// Static Methods
// ============================================

/**
 * Get active (non-expired) cache entry for a base currency
 * @param {string} baseCurrency - Base currency code (default: 'USD')
 * @returns {Promise<Object|null>} Cache entry or null
 */
exchangeRateCacheSchema.statics.getActiveCache = async function(baseCurrency = DEFAULT_BASE_CURRENCY) {
  const base = baseCurrency.toUpperCase();
  const cache = await this.findOne({
    base,
    expiresAt: { $gt: new Date() }
  }).sort({ fetchedAt: -1 });
  
  if (cache) {
    await cache.recordAccess();
  }
  
  return cache;
};

/**
 * Set or update exchange rates in cache
 * @param {Object} params - Cache parameters
 * @param {string} params.base - Base currency
 * @param {Object} params.rates - Rates object
 * @param {string} params.provider - Provider name
 * @param {number} params.ttlHours - Cache TTL in hours
 * @returns {Promise<Object>} Created/updated cache entry
 */
exchangeRateCacheSchema.statics.setRates = async function({ base, rates, provider = 'api', ttlHours = DEFAULT_CACHE_TTL_HOURS }) {
  const baseCurrency = (base || DEFAULT_BASE_CURRENCY).toUpperCase();
  
  // Validate rates
  if (!rates || typeof rates !== 'object') {
    throw new Error('Rates must be a valid object');
  }
  
  // Remove existing expired cache for this base (optional cleanup)
  await this.deleteMany({
    base: baseCurrency,
    expiresAt: { $lt: new Date() }
  });
  
  // Create new cache entry
  const cache = new this({
    base: baseCurrency,
    rates,
    provider,
    fetchedAt: new Date(),
    expiresAt: new Date(Date.now() + (ttlHours * 60 * 60 * 1000)),
    lastAccessedAt: new Date(),
    accessCount: 0
  });
  
  await cache.save();
  return cache;
};

/**
 * Get a specific exchange rate from cache
 * @param {string} fromCurrency - Source currency
 * @param {string} toCurrency - Target currency
 * @returns {Promise<number>} Exchange rate
 * @throws {Error} If rates not available
 */
exchangeRateCacheSchema.statics.getExchangeRate = async function(fromCurrency, toCurrency) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  
  if (from === to) return 1;
  
  // Try to get cache with USD base (most common)
  const cache = await this.getActiveCache(DEFAULT_BASE_CURRENCY);
  if (!cache) {
    throw new Error('Exchange rates not available. Please try again later.');
  }
  
  const rate = cache.getRate(to);
  if (!rate) {
    throw new Error(`Exchange rate not available for ${to}`);
  }
  
  // If from is not USD, need to convert through USD
  if (from !== DEFAULT_BASE_CURRENCY) {
    const fromRate = cache.getRate(from);
    if (!fromRate) {
      throw new Error(`Exchange rate not available for ${from}`);
    }
    // Return rate from source to target: target_rate / source_rate
    return rate / fromRate;
  }
  
  return rate;
};

/**
 * Convert amount using cached rates
 * @param {number} amount - Amount to convert
 * @param {string} fromCurrency - Source currency
 * @param {string} toCurrency - Target currency
 * @returns {Promise<number>} Converted amount
 */
exchangeRateCacheSchema.statics.convertAmount = async function(amount, fromCurrency, toCurrency) {
  const rate = await this.getExchangeRate(fromCurrency, toCurrency);
  return amount * rate;
};

/**
 * Get all supported currencies with their rates (relative to base)
 * @param {string} baseCurrency - Base currency
 * @returns {Promise<Object>} Object containing rates and metadata
 */
exchangeRateCacheSchema.statics.getRatesWithMetadata = async function(baseCurrency = DEFAULT_BASE_CURRENCY) {
  const cache = await this.getActiveCache(baseCurrency);
  
  if (!cache) {
    return {
      base: baseCurrency,
      rates: {},
      isAvailable: false,
      message: 'Exchange rates not available'
    };
  }
  
  return {
    base: cache.base,
    rates: cache.rates,
    provider: cache.provider,
    fetchedAt: cache.fetchedAt,
    expiresAt: cache.expiresAt,
    isExpired: cache.isExpired,
    ttlMs: cache.ttlMs,
    ttlHuman: cache.ttlHuman,
    isAvailable: true,
    currencyCount: cache.currencyCount
  };
};

/**
 * Clean up expired cache entries
 * @returns {Promise<number>} Number of deleted entries
 */
exchangeRateCacheSchema.statics.cleanupExpired = async function() {
  const result = await this.deleteMany({
    expiresAt: { $lt: new Date() }
  });
  return result.deletedCount;
};

/**
 * Clean up old cache entries (keep only most recent N entries per base)
 * @param {number} keepCount - Number of entries to keep per base (default: 2)
 * @returns {Promise<number>} Number of deleted entries
 */
exchangeRateCacheSchema.statics.cleanupOldEntries = async function(keepCount = 2) {
  // Get all bases
  const bases = await this.distinct('base');
  let totalDeleted = 0;
  
  for (const base of bases) {
    // Get entries for this base, sorted by fetchedAt desc
    const entries = await this.find({ base })
      .sort({ fetchedAt: -1 })
      .select('_id');
    
    if (entries.length > keepCount) {
      const toDelete = entries.slice(keepCount).map(e => e._id);
      const result = await this.deleteMany({ _id: { $in: toDelete } });
      totalDeleted += result.deletedCount;
    }
  }
  
  return totalDeleted;
};

/**
 * Check if cache needs refresh (expired or about to expire within threshold)
 * @param {string} baseCurrency - Base currency
 * @param {number} thresholdMinutes - Minutes before expiry to consider stale (default: 60)
 * @returns {Promise<boolean>} True if cache needs refresh
 */
exchangeRateCacheSchema.statics.needsRefresh = async function(baseCurrency = DEFAULT_BASE_CURRENCY, thresholdMinutes = 60) {
  const cache = await this.getActiveCache(baseCurrency);
  
  if (!cache) return true;
  
  const thresholdMs = thresholdMinutes * 60 * 1000;
  const timeUntilExpiry = cache.expiresAt - new Date();
  
  return timeUntilExpiry < thresholdMs;
};

// ============================================
// Pre-Save Hooks
// ============================================

/**
 * Validate that rates object contains valid numeric values
 */
exchangeRateCacheSchema.pre('save', function(next) {
  if (this.rates) {
    for (const [currency, rate] of Object.entries(this.rates)) {
      if (typeof rate !== 'number' || isNaN(rate) || rate <= 0) {
        return next(new Error(`Invalid rate for ${currency}: must be a positive number`));
      }
    }
  }
  next();
});

/**
 * Ensure rates include all supported currencies (optional warning, not blocking)
 */
exchangeRateCacheSchema.pre('save', function(next) {
  const missingCurrencies = SUPPORTED_CURRENCIES.filter(
    curr => curr !== this.base && !this.rates[curr]
  );
  
  if (missingCurrencies.length > 0 && process.env.NODE_ENV !== 'production') {
    console.warn(`[ExchangeRateCache] Missing rates for: ${missingCurrencies.join(', ')}`);
  }
  
  next();
});

// ============================================
// Exports
// ============================================

module.exports = {
  ExchangeRateCache: mongoose.model('ExchangeRateCache', exchangeRateCacheSchema),
  DEFAULT_BASE_CURRENCY,
  DEFAULT_CACHE_TTL_HOURS,
  SUPPORTED_CURRENCIES
};
