const mongoose = require('mongoose');

const exchangeRateCacheSchema = new mongoose.Schema({
  base: { type: String, default: 'USD' },
  rates: { type: Map, of: Number },
  provider: String,
  fetchedAt: Date,
  expiresAt: Date,
});

module.exports = mongoose.model('ExchangeRateCache', exchangeRateCacheSchema);
