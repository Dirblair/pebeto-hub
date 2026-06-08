/**
 * Transaction Model for Pebeto Creator's Hub
 * 
 * Tracks all financial transactions including deposits, tips, withdrawals,
 * platform fees, escrow operations, and adjustments.
 * 
 * @module models/Transaction
 */

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// ============================================
// Constants
// ============================================

const TRANSACTION_TYPES = {
  DEPOSIT: 'deposit',
  PLATFORM_FEE: 'platform_fee',
  TIP: 'tip',
  WITHDRAWAL: 'withdrawal',
  ESCROW_RELEASE: 'escrow_release',
  ESCROW_REFUND: 'escrow_refund',
  ADJUSTMENT: 'adjustment',
  CAMPAIGN_FUND: 'campaign_fund',
  CAMPAIGN_PAYMENT: 'campaign_payment',
  REFERRAL_BONUS: 'referral_bonus'
};

const TRANSACTION_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REVERSED: 'reversed',
  PROCESSING: 'processing',
  CANCELLED: 'cancelled'
};

const FEE_SOURCES = {
  DEPOSIT: 'deposit',
  TIP: 'tip',
  WITHDRAWAL: 'withdrawal',
  ESCROW: 'escrow',
  REFERRAL: 'referral'
};

// ============================================
// Schema Definition
// ============================================

const transactionSchema = new mongoose.Schema(
  {
    // Primary identifiers
    transactionId: { 
      type: String, 
      required: true, 
      unique: true,
      index: true
    },
    referenceId: {
      type: String,
      index: true,
      sparse: true,
      description: 'External reference (M-Pesa transaction ID, PayPal payment ID, etc.)'
    },
    
    // Transaction type and status
    type: {
      type: String,
      enum: Object.values(TRANSACTION_TYPES),
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: Object.values(TRANSACTION_STATUS),
      default: TRANSACTION_STATUS.PENDING,
      index: true
    },
    
    // Party information
    fromUserId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User',
      index: true
    },
    toUserId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User',
      index: true
    },
    fromWalletId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'Wallet',
      index: true
    },
    toWalletId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'Wallet',
      index: true
    },
    
    // Amount information
    grossAmount: { 
      type: Number, 
      required: true,
      min: 0,
      validate: {
        validator: function(v) {
          return v >= 0;
        },
        message: 'Gross amount cannot be negative'
      }
    },
    feeAmount: { 
      type: Number, 
      default: 0,
      min: 0,
      validate: {
        validator: function(v) {
          return v >= 0 && v <= this.grossAmount;
        },
        message: 'Fee amount must be between 0 and gross amount'
      }
    },
    netAmount: { 
      type: Number, 
      required: true,
      min: 0,
      validate: {
        validator: function(v) {
          return v >= 0 && v <= this.grossAmount;
        },
        message: 'Net amount must be between 0 and gross amount'
      }
    },
    
    // Fee details
    feeRate: {
      type: Number,
      min: 0,
      max: 1,
      description: 'Fee rate as decimal (e.g., 0.03 = 3%)'
    },
    feeSource: { 
      type: String, 
      enum: Object.values(FEE_SOURCES), 
      default: null 
    },
    feeRecipient: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User',
      index: true
    },
    
    // Timestamps
    createdAt: { 
      type: Date, 
      default: Date.now, 
      immutable: true,
      index: true
    },
    completedAt: {
      type: Date,
      description: 'When transaction was completed'
    },
    updatedAt: {
      type: Date,
      default: Date.now,
      index: true
    },
    
    // Error tracking
    errorCode: {
      type: String,
      maxlength: 50
    },
    errorMessage: {
      type: String,
      maxlength: 500
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0,
      max: 10
    },
    
    // Metadata for additional context
    metadata: {
      // Campaign related
      campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },
      bidId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign.bids' },
      
      // Payment method details
      payoutMethod: { type: String, enum: ['mpesa', 'paypal', 'swift', 'bank'] },
      payoutDetails: { type: mongoose.Schema.Types.Mixed },
      
      // Currency information
      displayCurrency: { type: String, uppercase: true, default: 'USD' },
      displayAmount: { type: Number },
      exchangeRateUsed: { type: Number, min: 0 },
      
      // Idempotency
      idempotencyKey: { type: String, index: true, sparse: true },
      
      // Notes and descriptions
      note: { type: String, trim: true, maxlength: 500 },
      description: { type: String, trim: true, maxlength: 500 },
      
      // IP address and user agent for audit
      ipAddress: { type: String },
      userAgent: { type: String },
      
      // Flexible metadata for future use
      custom: { type: mongoose.Schema.Types.Mixed, default: {} }
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// ============================================
// Indexes
// ============================================

// Single field indexes (already added above with `index: true`)
// Additional compound indexes for common query patterns

// Date range queries with type
transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ status: 1, createdAt: -1 });

// User transaction history
transactionSchema.index({ fromUserId: 1, createdAt: -1 });
transactionSchema.index({ toUserId: 1, createdAt: -1 });
transactionSchema.index({ fromUserId: 1, type: 1, status: 1 });
transactionSchema.index({ toUserId: 1, type: 1, status: 1 });

// Fee recipient queries
transactionSchema.index({ feeRecipient: 1, feeSource: 1, createdAt: -1 });

// Campaign transactions
transactionSchema.index({ 'metadata.campaignId': 1, type: 1, createdAt: -1 });

// Idempotency key lookup
transactionSchema.index({ 'metadata.idempotencyKey': 1 }, { sparse: true });

// Reference ID lookup
transactionSchema.index({ referenceId: 1 }, { sparse: true });

// Aggregation indexes
transactionSchema.index({ type: 1, status: 1, createdAt: -1 });
transactionSchema.index({ fromUserId: 1, status: 1, createdAt: -1 });
transactionSchema.index({ toUserId: 1, status: 1, createdAt: -1 });

// TTL for pending transactions that never completed (optional cleanup)
// transactionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400, partialFilterExpression: { status: 'pending' } });

// ============================================
// Virtual Fields
// ============================================

/**
 * Check if transaction is successful
 */
transactionSchema.virtual('isSuccessful').get(function() {
  return this.status === TRANSACTION_STATUS.COMPLETED;
});

/**
 * Check if transaction failed
 */
transactionSchema.virtual('isFailed').get(function() {
  return this.status === TRANSACTION_STATUS.FAILED;
});

/**
 * Check if transaction is pending
 */
transactionSchema.virtual('isPending').get(function() {
  return this.status === TRANSACTION_STATUS.PENDING;
});

/**
 * Get formatted amount for display
 */
transactionSchema.virtual('formattedGrossAmount').get(function() {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: this.metadata?.displayCurrency || 'USD'
  }).format(this.grossAmount);
});

/**
 * Get formatted fee amount
 */
transactionSchema.virtual('formattedFeeAmount').get(function() {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: this.metadata?.displayCurrency || 'USD'
  }).format(this.feeAmount);
});

/**
 * Get formatted net amount
 */
transactionSchema.virtual('formattedNetAmount').get(function() {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: this.metadata?.displayCurrency || 'USD'
  }).format(this.netAmount);
});

/**
 * Processing time in milliseconds
 */
transactionSchema.virtual('processingTimeMs').get(function() {
  if (!this.completedAt) return null;
  return this.completedAt - this.createdAt;
});

/**
 * Processing time in human-readable format
 */
transactionSchema.virtual('processingTimeHuman').get(function() {
  const ms = this.processingTimeMs;
  if (!ms) return 'pending';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
});

// ============================================
// Instance Methods
// ============================================

/**
 * Mark transaction as completed
 * @param {Object} options - Additional options
 * @returns {Promise<Transaction>}
 */
transactionSchema.methods.markCompleted = async function(options = {}) {
  this.status = TRANSACTION_STATUS.COMPLETED;
  this.completedAt = new Date();
  
  if (options.referenceId) this.referenceId = options.referenceId;
  if (options.metadata) this.metadata = { ...this.metadata, ...options.metadata };
  
  await this.save();
  return this;
};

/**
 * Mark transaction as failed
 * @param {string} errorMessage - Error message
 * @param {string} errorCode - Error code
 * @returns {Promise<Transaction>}
 */
transactionSchema.methods.markFailed = async function(errorMessage, errorCode = null) {
  this.status = TRANSACTION_STATUS.FAILED;
  this.errorMessage = errorMessage;
  if (errorCode) this.errorCode = errorCode;
  await this.save();
  return this;
};

/**
 * Mark transaction as reversed
 * @param {string} reason - Reversal reason
 * @returns {Promise<Transaction>}
 */
transactionSchema.methods.markReversed = async function(reason) {
  this.status = TRANSACTION_STATUS.REVERSED;
  this.metadata.note = reason;
  await this.save();
  return this;
};

/**
 * Increment retry count and optionally change status
 * @returns {Promise<Transaction>}
 */
transactionSchema.methods.incrementRetry = async function() {
  this.retryCount += 1;
  if (this.status === TRANSACTION_STATUS.FAILED) {
    this.status = TRANSACTION_STATUS.PENDING;
  }
  await this.save();
  return this;
};

// ============================================
// Static Methods
// ============================================

/**
 * Generate a unique transaction ID
 * @returns {string} Unique transaction ID
 */
transactionSchema.statics.generateTransactionId = function() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `txn_${timestamp}_${random}`;
};

/**
 * Create a new transaction with auto-generated ID
 * @param {Object} data - Transaction data
 * @returns {Promise<Transaction>}
 */
transactionSchema.statics.createTransaction = async function(data) {
  const transaction = new this({
    transactionId: this.generateTransactionId(),
    ...data
  });
  
  // Auto-calculate net amount if not provided
  if (data.grossAmount !== undefined && transaction.netAmount === undefined) {
    transaction.netAmount = transaction.grossAmount - (transaction.feeAmount || 0);
  }
  
  await transaction.save();
  return transaction;
};

/**
 * Find transactions by user (as sender or receiver)
 * @param {string} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Transactions and pagination info
 */
transactionSchema.statics.findByUser = async function(userId, options = {}) {
  const {
    limit = 50,
    offset = 0,
    type = null,
    status = null,
    startDate = null,
    endDate = null
  } = options;
  
  const query = {
    $or: [
      { fromUserId: userId },
      { toUserId: userId }
    ]
  };
  
  if (type) query.type = type;
  if (status) query.status = status;
  if (startDate) query.createdAt = { ...query.createdAt, $gte: startDate };
  if (endDate) query.createdAt = { ...query.createdAt, $lte: endDate };
  
  const [transactions, total] = await Promise.all([
    this.find(query)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('fromUserId', 'email uniqueCode role')
      .populate('toUserId', 'email uniqueCode role')
      .lean(),
    this.countDocuments(query)
  ]);
  
  return {
    transactions,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + transactions.length < total
    }
  };
};

/**
 * Get transaction statistics for a user
 * @param {string} userId - User ID
 * @param {Object} options - Options (period)
 * @returns {Promise<Object>} Statistics
 */
transactionSchema.statics.getUserStats = async function(userId, options = {}) {
  const { days = 30 } = options;
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);
  
  const match = {
    $or: [{ fromUserId: userId }, { toUserId: userId }],
    status: TRANSACTION_STATUS.COMPLETED,
    createdAt: { $gte: sinceDate }
  };
  
  const stats = await this.aggregate([
    { $match: match },
    { $group: {
      _id: '$type',
      totalGross: { $sum: '$grossAmount' },
      totalFee: { $sum: '$feeAmount' },
      totalNet: { $sum: '$netAmount' },
      count: { $sum: 1 }
    }}
  ]);
  
  // Calculate total inflow and outflow
  const inflow = await this.aggregate([
    { $match: { toUserId: userId, status: TRANSACTION_STATUS.COMPLETED, createdAt: { $gte: sinceDate } } },
    { $group: { _id: null, total: { $sum: '$netAmount' } } }
  ]);
  
  const outflow = await this.aggregate([
    { $match: { fromUserId: userId, status: TRANSACTION_STATUS.COMPLETED, createdAt: { $gte: sinceDate } } },
    { $group: { _id: null, total: { $sum: '$netAmount' } } }
  ]);
  
  return {
    period: `${days} days`,
    byType: stats,
    summary: {
      totalInflow: inflow[0]?.total || 0,
      totalOutflow: outflow[0]?.total || 0,
      netChange: (inflow[0]?.total || 0) - (outflow[0]?.total || 0)
    }
  };
};

/**
 * Get platform fee statistics
 * @param {Object} options - Options (startDate, endDate)
 * @returns {Promise<Object>} Fee statistics
 */
transactionSchema.statics.getPlatformFeeStats = async function(options = {}) {
  const { startDate, endDate } = options;
  const match = {
    feeSource: { $ne: null },
    status: TRANSACTION_STATUS.COMPLETED
  };
  
  if (startDate) match.createdAt = { ...match.createdAt, $gte: startDate };
  if (endDate) match.createdAt = { ...match.createdAt, $lte: endDate };
  
  const stats = await this.aggregate([
    { $match: match },
    { $group: {
      _id: '$feeSource',
      totalFee: { $sum: '$feeAmount' },
      transactionCount: { $sum: 1 },
      averageFee: { $avg: '$feeAmount' }
    }},
    { $sort: { totalFee: -1 } }
  ]);
  
  const totalFees = stats.reduce((sum, s) => sum + s.totalFee, 0);
  
  return {
    bySource: stats,
    totalFees,
    period: { startDate, endDate }
  };
};

// ============================================
// Pre-Save Hooks
// ============================================

/**
 * Auto-generate transaction ID if not provided
 */
transactionSchema.pre('save', function(next) {
  if (!this.transactionId) {
    this.transactionId = this.constructor.generateTransactionId();
  }
  next();
});

/**
 * Set completedAt when status changes to completed
 */
transactionSchema.pre('save', function(next) {
  if (this.isModified('status') && this.status === TRANSACTION_STATUS.COMPLETED && !this.completedAt) {
    this.completedAt = new Date();
  }
  next();
});

/**
 * Validate net amount equals gross - fee
 */
transactionSchema.pre('save', function(next) {
  const calculatedNet = this.grossAmount - this.feeAmount;
  if (Math.abs(calculatedNet - this.netAmount) > 0.01) {
    return next(new Error(`Net amount mismatch: expected ${calculatedNet}, got ${this.netAmount}`));
  }
  next();
});

/**
 * Update updatedAt on save (handled by timestamps option)
 */
// Already handled by timestamps: true

// ============================================
// Exports
// ============================================

module.exports = {
  Transaction: mongoose.model('Transaction', transactionSchema),
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  FEE_SOURCES
};
