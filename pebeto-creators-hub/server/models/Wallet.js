const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    walletType: { type: String, enum: ['profit', 'standard'], default: 'standard' },
    balances: {
      available: { type: Number, default: 0, min: 0 },
      pending: { type: Number, default: 0, min: 0 },
      escrow: { type: Number, default: 0, min: 0 },
      tips: { type: Number, default: 0, min: 0 },
    },
    currency: { type: String, default: 'USD', immutable: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Wallet', walletSchema);
