const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  transactionId: { type: String, required: true, unique: true },
  type: {
    type: String,
    enum: [
      'deposit',
      'platform_fee',
      'tip',
      'withdrawal',
      'escrow_release',
      'escrow_refund',
      'adjustment',
    ],
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'reversed'],
    default: 'completed',
  },
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  fromWalletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet' },
  toWalletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet' },
  grossAmount: { type: Number, required: true },
  feeAmount: { type: Number, default: 0 },
  netAmount: { type: Number, required: true },
  feeRate: Number,
  feeSource: { type: String, enum: ['deposit', 'tip', 'withdrawal', null], default: null },
  feeRecipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  metadata: {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },
    payoutMethod: String,
    payoutDetails: mongoose.Schema.Types.Mixed,
    displayCurrency: String,
    displayAmount: Number,
    exchangeRateUsed: Number,
    idempotencyKey: String,
    note: String,
  },
  createdAt: { type: Date, default: Date.now, immutable: true },
});

transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ feeRecipient: 1, feeSource: 1 });
transactionSchema.index({ fromUserId: 1, createdAt: -1 });
transactionSchema.index({ toUserId: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
