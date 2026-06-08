/**
 * Wallet Model for Pebeto Creator's Hub
 * 
 * Manages user wallet balances including available funds, pending transactions,
 * escrow holds, and tips. Supports optimistic concurrency control and provides
 * helper methods for safe balance updates.
 * 
 * @module models/Wallet
 */

const mongoose = require('mongoose');

// ============================================
// Constants
// ============================================

const WALLET_TYPES = {
  PROFIT: 'profit',
  STANDARD: 'standard',
  ESCROW: 'escrow'  // Platform escrow account
};

const TRANSACTION_DIRECTIONS = {
  CREDIT: 'credit',
  DEBIT: 'debit'
};

// ============================================
// Schema Definition
// ============================================

const walletSchema = new mongoose.Schema(
  {
    // User association (one-to-one)
    userId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User', 
      required: true, 
      unique: true,
      index: true
    },
    
    // Wallet type
    walletType: { 
      type: String, 
      enum: Object.values(WALLET_TYPES), 
      default: WALLET_TYPES.STANDARD,
      index: true
    },
    
    // Balance components
    balances: {
      available: { 
        type: Number, 
        default: 0, 
        min: 0,
        validate: {
          validator: function(v) {
            return v >= 0;
          },
          message: 'Available balance cannot be negative'
        }
      },
      pending: { 
        type: Number, 
        default: 0, 
        min: 0,
        validate: {
          validator: function(v) {
            return v >= 0;
          },
          message: 'Pending balance cannot be negative'
        }
      },
      escrow: { 
        type: Number, 
        default: 0, 
        min: 0,
        validate: {
          validator: function(v) {
            return v >= 0;
          },
          message: 'Escrow balance cannot be negative'
        }
      },
      tips: { 
        type: Number, 
        default: 0, 
        min: 0,
        validate: {
          validator: function(v) {
            return v >= 0;
          },
          message: 'Tips balance cannot be negative'
        }
      }
    },
    
    // Currency (immutable after creation)
    currency: { 
      type: String, 
      default: 'USD', 
      uppercase: true,
      immutable: true,
      maxlength: 3,
      validate: {
        validator: function(v) {
          return ['USD', 'KES', 'EUR', 'GBP', 'NGN', 'ZAR', 'GHS'].includes(v);
        },
        message: 'Unsupported currency'
      }
    },
    
    // Optimistic concurrency control
    version: {
      type: Number,
      default: 0,
      min: 0
    },
    
    // Wallet status
    isFrozen: {
      type: Boolean,
      default: false,
      index: true
    },
    frozenAt: {
      type: Date
    },
    frozenReason: {
      type: String,
      trim: true,
      maxlength: 500
    },
    
    // Transaction counters (for statistics)
    stats: {
      totalCredited: { type: Number, default: 0, min: 0 },
      totalDebited: { type: Number, default: 0, min: 0 },
      transactionCount: { type: Number, default: 0, min: 0 },
      lastTransactionAt: { type: Date }
    },
    
    // Metadata
    metadata: {
      notes: { type: String, trim: true, maxlength: 500 },
      createdAt: { type: Date, default: Date.now }
    }
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// ============================================
// Indexes
// ============================================

// Compound indexes for common queries
walletSchema.index({ userId: 1, walletType: 1 });
walletSchema.index({ walletType: 1, 'balances.available': -1 });
walletSchema.index({ isFrozen: 1, updatedAt: -1 });

// For admin queries
walletSchema.index({ 'stats.totalCredited': -1 });
walletSchema.index({ 'stats.transactionCount': -1 });

// ============================================
// Virtual Fields
// ============================================

/**
 * Total balance (available + escrow + tips - pending)
 */
walletSchema.virtual('totalBalance').get(function() {
  return this.balances.available + this.balances.escrow + this.balances.tips;
});

/**
 * Net spendable balance (available - pending)
 */
walletSchema.virtual('netSpendable').get(function() {
  return Math.max(0, this.balances.available - this.balances.pending);
});

/**
 * Check if wallet has sufficient funds for a debit
 */
walletSchema.virtual('hasSufficientFunds').get(function() {
  return (amount) => this.balances.available >= amount;
});

/**
 * Check if wallet is empty
 */
walletSchema.virtual('isEmpty').get(function() {
  return this.totalBalance === 0;
});

/**
 * Format available balance as string
 */
walletSchema.virtual('formattedAvailable').get(function() {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: this.currency
  }).format(this.balances.available);
});

/**
 * Format total balance as string
 */
walletSchema.virtual('formattedTotal').get(function() {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: this.currency
  }).format(this.totalBalance);
});

// ============================================
// Instance Methods
// ============================================

/**
 * Check if wallet is frozen
 * @returns {boolean}
 */
walletSchema.methods.isFrozenWallet = function() {
  return this.isFrozen === true;
};

/**
 * Freeze wallet (prevent transactions)
 * @param {string} reason - Reason for freezing
 * @returns {Promise<Wallet>}
 */
walletSchema.methods.freeze = async function(reason) {
  this.isFrozen = true;
  this.frozenAt = new Date();
  this.frozenReason = reason;
  await this.save();
  return this;
};

/**
 * Unfreeze wallet (allow transactions)
 * @returns {Promise<Wallet>}
 */
walletSchema.methods.unfreeze = async function() {
  this.isFrozen = false;
  this.frozenAt = null;
  this.frozenReason = null;
  await this.save();
  return this;
};

/**
 * Credit funds to wallet (with optimistic locking)
 * @param {number} amount - Amount to credit
 * @param {string} type - Balance type ('available', 'pending', 'escrow', 'tips')
 * @param {Object} options - Additional options
 * @returns {Promise<Wallet>}
 */
walletSchema.methods.credit = async function(amount, type = 'available', options = {}) {
  if (this.isFrozenWallet()) {
    throw new Error('Wallet is frozen. Cannot credit funds.');
  }
  
  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error('Credit amount must be a positive number');
  }
  
  const balanceTypes = ['available', 'pending', 'escrow', 'tips'];
  if (!balanceTypes.includes(type)) {
    throw new Error(`Invalid balance type. Must be one of: ${balanceTypes.join(', ')}`);
  }
  
  // Use findOneAndUpdate with version check for optimistic concurrency
  const updated = await this.constructor.findOneAndUpdate(
    {
      _id: this._id,
      version: this.version
    },
    {
      $inc: {
        [`balances.${type}`]: numAmount,
        'stats.totalCredited': numAmount,
        'stats.transactionCount': 1
      },
      $set: {
        'stats.lastTransactionAt': new Date(),
        version: this.version + 1
      }
    },
    { new: true, runValidators: true }
  );
  
  if (!updated) {
    throw new Error('Concurrency conflict: Wallet was modified. Please retry.');
  }
  
  // Update current instance
  Object.assign(this, updated.toObject());
  
  if (options.transactionId && options.log !== false) {
    // Optionally log to transaction collection
    await this.logTransaction('credit', numAmount, type, options);
  }
  
  return this;
};

/**
 * Debit funds from wallet (with optimistic locking)
 * @param {number} amount - Amount to debit
 * @param {string} type - Balance type ('available', 'pending', 'escrow', 'tips')
 * @param {Object} options - Additional options
 * @returns {Promise<Wallet>}
 */
walletSchema.methods.debit = async function(amount, type = 'available', options = {}) {
  if (this.isFrozenWallet()) {
    throw new Error('Wallet is frozen. Cannot debit funds.');
  }
  
  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error('Debit amount must be a positive number');
  }
  
  const balanceTypes = ['available', 'pending', 'escrow', 'tips'];
  if (!balanceTypes.includes(type)) {
    throw new Error(`Invalid balance type. Must be one of: ${balanceTypes.join(', ')}`);
  }
  
  // Check sufficient balance
  const currentBalance = this.balances[type];
  if (currentBalance < numAmount) {
    throw new Error(`Insufficient ${type} balance. Available: ${currentBalance}, Requested: ${numAmount}`);
  }
  
  // Use findOneAndUpdate with version check for optimistic concurrency
  const updated = await this.constructor.findOneAndUpdate(
    {
      _id: this._id,
      version: this.version,
      [`balances.${type}`]: { $gte: numAmount }
    },
    {
      $inc: {
        [`balances.${type}`]: -numAmount,
        'stats.totalDebited': numAmount,
        'stats.transactionCount': 1
      },
      $set: {
        'stats.lastTransactionAt': new Date(),
        version: this.version + 1
      }
    },
    { new: true, runValidators: true }
  );
  
  if (!updated) {
    throw new Error('Concurrency conflict: Wallet was modified or insufficient funds. Please retry.');
  }
  
  // Update current instance
  Object.assign(this, updated.toObject());
  
  if (options.transactionId && options.log !== false) {
    // Optionally log to transaction collection
    await this.logTransaction('debit', numAmount, type, options);
  }
  
  return this;
};

/**
 * Transfer funds between balance types within same wallet
 * @param {number} amount - Amount to transfer
 * @param {string} fromType - Source balance type
 * @param {string} toType - Destination balance type
 * @param {Object} options - Additional options
 * @returns {Promise<Wallet>}
 */
walletSchema.methods.transferBetweenBalances = async function(amount, fromType, toType, options = {}) {
  if (this.isFrozenWallet()) {
    throw new Error('Wallet is frozen. Cannot transfer funds.');
  }
  
  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error('Transfer amount must be a positive number');
  }
  
  const balanceTypes = ['available', 'pending', 'escrow', 'tips'];
  if (!balanceTypes.includes(fromType) || !balanceTypes.includes(toType)) {
    throw new Error(`Invalid balance type. Must be one of: ${balanceTypes.join(', ')}`);
  }
  
  if (fromType === toType) {
    throw new Error('Cannot transfer to the same balance type');
  }
  
  // Use findOneAndUpdate with version check
  const updated = await this.constructor.findOneAndUpdate(
    {
      _id: this._id,
      version: this.version,
      [`balances.${fromType}`]: { $gte: numAmount }
    },
    {
      $inc: {
        [`balances.${fromType}`]: -numAmount,
        [`balances.${toType}`]: numAmount
      },
      $set: { version: this.version + 1 }
    },
    { new: true, runValidators: true }
  );
  
  if (!updated) {
    throw new Error('Concurrency conflict or insufficient funds. Please retry.');
  }
  
  Object.assign(this, updated.toObject());
  return this;
};

/**
 * Move funds from escrow to available (campaign completion)
 * @param {number} amount - Amount to release
 * @param {Object} options - Additional options
 * @returns {Promise<Wallet>}
 */
walletSchema.methods.releaseFromEscrow = async function(amount, options = {}) {
  return this.transferBetweenBalances(amount, 'escrow', 'available', options);
};

/**
 * Move funds from available to escrow (campaign funding)
 * @param {number} amount - Amount to hold in escrow
 * @param {Object} options - Additional options
 * @returns {Promise<Wallet>}
 */
walletSchema.methods.holdInEscrow = async function(amount, options = {}) {
  return this.transferBetweenBalances(amount, 'available', 'escrow', options);
};

/**
 * Get current balance snapshot
 * @returns {Object} Balance snapshot
 */
walletSchema.methods.getBalanceSnapshot = function() {
  return {
    available: this.balances.available,
    pending: this.balances.pending,
    escrow: this.balances.escrow,
    tips: this.balances.tips,
    total: this.totalBalance,
    netSpendable: this.netSpendable,
    currency: this.currency,
    timestamp: new Date()
  };
};

/**
 * Log transaction (placeholder - should integrate with Transaction model)
 * @param {string} direction - 'credit' or 'debit'
 * @param {number} amount - Transaction amount
 * @param {string} balanceType - Type of balance affected
 * @param {Object} options - Additional options
 * @returns {Promise<void>}
 */
walletSchema.methods.logTransaction = async function(direction, amount, balanceType, options = {}) {
  // This would typically create a Transaction document
  // For now, just a placeholder
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[Wallet] ${direction.toUpperCase()}: ${amount} ${this.currency} to ${balanceType} for user ${this.userId}`);
  }
};

// ============================================
// Static Methods
// ============================================

/**
 * Get or create wallet for a user
 * @param {string} userId - User ID
 * @param {string} walletType - Type of wallet
 * @returns {Promise<Wallet>}
 */
walletSchema.statics.getOrCreate = async function(userId, walletType = WALLET_TYPES.STANDARD) {
  let wallet = await this.findOne({ userId, walletType });
  
  if (!wallet) {
    wallet = new this({
      userId,
      walletType,
      currency: 'USD'
    });
    await wallet.save();
  }
  
  return wallet;
};

/**
 * Get wallet with user details (populated)
 * @param {string} userId - User ID
 * @param {string} walletType - Type of wallet
 * @returns {Promise<Object>}
 */
walletSchema.statics.getWithUser = async function(userId, walletType = WALLET_TYPES.STANDARD) {
  return this.findOne({ userId, walletType })
    .populate('userId', 'email uniqueCode role profile.displayName profile.stageName profile.companyName');
};

/**
 * Bulk update multiple wallets (for batch operations)
 * @param {Array} updates - Array of { walletId, amount, type, operation }
 * @returns {Promise<Array>} Results
 */
walletSchema.statics.bulkUpdate = async function(updates) {
  const session = await mongoose.startSession();
  const results = [];
  
  try {
    await session.withTransaction(async () => {
      for (const update of updates) {
        const wallet = await this.findById(update.walletId).session(session);
        if (!wallet) {
          results.push({ walletId: update.walletId, success: false, error: 'Wallet not found' });
          continue;
        }
        
        try {
          if (update.operation === 'credit') {
            await wallet.credit(update.amount, update.balanceType, { log: false });
          } else if (update.operation === 'debit') {
            await wallet.debit(update.amount, update.balanceType, { log: false });
          }
          results.push({ walletId: update.walletId, success: true, newBalance: wallet.balances.available });
        } catch (error) {
          results.push({ walletId: update.walletId, success: false, error: error.message });
        }
      }
    });
  } finally {
    await session.endSession();
  }
  
  return results;
};

/**
 * Get wallet statistics across platform
 * @returns {Promise<Object>}
 */
walletSchema.statics.getPlatformStats = async function() {
  const stats = await this.aggregate([
    {
      $group: {
        _id: '$walletType',
        totalAvailable: { $sum: '$balances.available' },
        totalEscrow: { $sum: '$balances.escrow' },
        totalTips: { $sum: '$balances.tips' },
        totalPending: { $sum: '$balances.pending' },
        walletCount: { $sum: 1 },
        activeWallets: { $sum: { $cond: [{ $eq: ['$isFrozen', false] }, 1, 0] } }
      }
    }
  ]);
  
  return stats;
};

/**
 * Find wallets with low balance (for monitoring)
 * @param {number} threshold - Balance threshold
 * @returns {Query}
 */
walletSchema.statics.findLowBalance = function(threshold = 10) {
  return this.find({
    'balances.available': { $lt: threshold },
    isFrozen: false
  }).sort({ 'balances.available': 1 });
};

/**
 * Find wallets with high transaction volume (for monitoring)
 * @param {number} minTransactions - Minimum transaction count
 * @returns {Query}
 */
walletSchema.statics.findHighVolumeWallets = function(minTransactions = 1000) {
  return this.find({
    'stats.transactionCount': { $gt: minTransactions }
  }).sort({ 'stats.transactionCount': -1 });
};

// ============================================
// Pre-Save Hooks
// ============================================

/**
 * Validate wallet before saving
 */
walletSchema.pre('save', function(next) {
  // Ensure balances don't go negative (additional safety)
  if (this.balances.available < 0 ||
      this.balances.pending < 0 ||
      this.balances.escrow < 0 ||
      this.balances.tips < 0) {
    return next(new Error('Balances cannot be negative'));
  }
  
  // Update timestamp for stats
  if (this.isModified('balances')) {
    this.stats.lastTransactionAt = new Date();
  }
  
  next();
});

// ============================================
// Exports
// ============================================

module.exports = {
  Wallet: mongoose.model('Wallet', walletSchema),
  WALLET_TYPES,
  TRANSACTION_DIRECTIONS
};
