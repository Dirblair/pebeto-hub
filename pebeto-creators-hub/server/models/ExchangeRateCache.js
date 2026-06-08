const mongoose = require('mongoose');

const exchangeRateCacheSchema = new mongoose.Schema({
  base: { type: String, default: 'USD' },
  rates: { type: mongoose.Schema.Types.Mixed }, // Changed from Map to Mixed
  provider: String,
  fetchedAt: Date,
  expiresAt: Date,
});

module.exports = mongoose.model('ExchangeRateCache', exchangeRateCacheSchema);
