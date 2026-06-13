/**
 * Webhook Model for Pebeto Creator's Hub
 * 
 * Manages webhook configurations for external service integration.
 * 
 * @module models/Webhook
 */

const mongoose = require('mongoose');

// ============================================
// Constants
// ============================================

const WEBHOOK_EVENTS = {
  // User events
  USER_REGISTERED: 'user.registered',
  USER_VERIFIED: 'user.verified',
  USER_UPDATED: 'user.updated',
  
  // Wallet events
  DEPOSIT_COMPLETED: 'deposit.completed',
  WITHDRAWAL_COMPLETED: 'withdrawal.completed',
  TIP_SENT: 'tip.sent',
  TIP_RECEIVED: 'tip.received',
  
  // Campaign events
  CAMPAIGN_CREATED: 'campaign.created',
  CAMPAIGN_UPDATED: 'campaign.updated',
  CAMPAIGN_FUNDED: 'campaign.funded',
  CAMPAIGN_COMPLETED: 'campaign.completed',
  BID_PLACED: 'bid.placed',
  BID_ACCEPTED: 'bid.accepted',
  WORK_SUBMITTED: 'work.submitted',
  WORK_APPROVED: 'work.approved',
  
  // Transaction events
  TRANSACTION_CREATED: 'transaction.created',
  TRANSACTION_COMPLETED: 'transaction.completed',
  TRANSACTION_FAILED: 'transaction.failed',
};

const WEBHOOK_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  FAILED: 'failed',
  DELETED: 'deleted',
};

// ============================================
// Schema Definition
// ============================================

const webhookSchema = new mongoose.Schema(
  {
    // Owner
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    
    // Webhook URL
    url: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: function(v) {
          return /^https?:\/\//.test(v);
        },
        message: 'Webhook URL must start with http:// or https://',
      },
    },
    
    // Events to receive
    events: [{
      type: String,
      enum: Object.values(WEBHOOK_EVENTS),
      required: true,
    }],
    
    // Status
    status: {
      type: String,
      enum: Object.values(WEBHOOK_STATUS),
      default: WEBHOOK_STATUS.ACTIVE,
      index: true,
    },
    
    // Secret for signature verification
    secret: {
      type: String,
      required: true,
    },
    
    // Retry configuration
    retryCount: {
      type: Number,
      default: 0,
    },
    maxRetries: {
      type: Number,
      default: 5,
    },
    lastAttemptAt: {
      type: Date,
    },
    lastSuccessAt: {
      type: Date,
    },
    lastError: {
      type: String,
    },
    consecutiveFailures: {
      type: Number,
      default: 0,
    },
    
    // Description/Label
    description: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    
    // Optional headers
    headers: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// ============================================
// Indexes
// ============================================

webhookSchema.index({ userId: 1, status: 1 });
webhookSchema.index({ url: 1 });
webhookSchema.index({ status: 1, lastAttemptAt: 1 });

// ============================================
// Instance Methods
// ============================================

webhookSchema.methods.activate = async function() {
  this.status = WEBHOOK_STATUS.ACTIVE;
  this.consecutiveFailures = 0;
  await this.save();
  return this;
};

webhookSchema.methods.deactivate = async function() {
  this.status = WEBHOOK_STATUS.INACTIVE;
  await this.save();
  return this;
};

webhookSchema.methods.markFailure = async function(error) {
  this.consecutiveFailures++;
  this.lastError = error;
  this.lastAttemptAt = new Date();
  
  if (this.consecutiveFailures >= this.maxRetries) {
    this.status = WEBHOOK_STATUS.FAILED;
  }
  
  await this.save();
  return this;
};

webhookSchema.methods.markSuccess = async function() {
  this.consecutiveFailures = 0;
  this.lastSuccessAt = new Date();
  this.lastAttemptAt = new Date();
  this.lastError = null;
  if (this.status === WEBHOOK_STATUS.FAILED) {
    this.status = WEBHOOK_STATUS.ACTIVE;
  }
  await this.save();
  return this;
};

webhookSchema.methods.regenerateSecret = function() {
  const crypto = require('crypto');
  this.secret = crypto.randomBytes(32).toString('hex');
  return this.secret;
};

// ============================================
// Static Methods
// ============================================

/**
 * Get active webhooks for a user and event
 * @param {string} userId - User ID
 * @param {string} event - Event type
 * @returns {Promise<Array>} Webhooks
 */
webhookSchema.statics.getActiveWebhooksForEvent = async function(userId, event) {
  return this.find({
    userId,
    status: WEBHOOK_STATUS.ACTIVE,
    events: event,
  });
};

/**
 * Get all webhooks for a user
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Webhooks
 */
webhookSchema.statics.getUserWebhooks = async function(userId) {
  return this.find({ userId, status: { $ne: WEBHOOK_STATUS.DELETED } })
    .sort({ createdAt: -1 });
};

/**
 * Generate webhook signature
 * @param {string} payload - Webhook payload
 * @param {string} secret - Webhook secret
 * @returns {string} Signature
 */
webhookSchema.statics.generateSignature = function(payload, secret) {
  const crypto = require('crypto');
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
};

// ============================================
// Pre-save Hooks
// ============================================

webhookSchema.pre('save', function(next) {
  if (!this.secret) {
    const crypto = require('crypto');
    this.secret = crypto.randomBytes(32).toString('hex');
  }
  next();
});

// ============================================
// Exports
// ============================================

module.exports = {
  Webhook: mongoose.model('Webhook', webhookSchema),
  WEBHOOK_EVENTS,
  WEBHOOK_STATUS,
};
