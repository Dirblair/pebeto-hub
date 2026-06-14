/**
 * Campaign Model for Pebeto Creator's Hub
 * 
 * Manages brand-created campaigns, creator bids, escrow funds,
 * and the entire campaign lifecycle from creation to payment.
 * 
 * @module models/Campaign
 */

const mongoose = require('mongoose');

// ============================================
// Bid Sub-Schema
// ============================================

const bidSchema = new mongoose.Schema({
  creatorId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true
  },
  uniqueCode: {
    type: String,
    trim: true,
    uppercase: true
  },
  amount: { 
    type: Number, 
    required: true,
    min: [0.01, 'Bid amount must be at least $0.01'],
    validate: {
      validator: function(v) {
        return v > 0;
      },
      message: 'Bid amount must be positive'
    }
  },
  proposal: {
    type: String,
    trim: true,
    maxlength: [2000, 'Proposal cannot exceed 2000 characters']
  },
  status: { 
    type: String, 
    enum: ['pending', 'accepted', 'rejected'], 
    default: 'pending',
    index: true
  },
  submittedWorkUrl: {
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        if (!v) return true;
        return /^https?:\/\//.test(v);
      },
      message: 'Work URL must be a valid HTTP/HTTPS URL'
    }
  },
  submittedAt: {
    type: Date
  },
  reviewedAt: {
    type: Date
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewNotes: {
    type: String,
    trim: true,
    maxlength: 500
  },
  feeCalculated: {
    type: Number,
    default: 0
  },
  netAmount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true  // Adds createdAt and updatedAt
});

// Add indexes for bid sub-document queries
bidSchema.index({ creatorId: 1, status: 1 });
bidSchema.index({ uniqueCode: 1 });

// ============================================
// Campaign Status Constants
// ============================================

const CAMPAIGN_STATUS = {
  DRAFT: 'draft',
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  SUBMITTED_FOR_REVIEW: 'submitted_for_review',
  COMPLETED: 'completed',
  PAID: 'paid',
  DISPUTED: 'disputed',
  CANCELLED: 'cancelled'
};

// Valid status transitions
const STATUS_TRANSITIONS = {
  [CAMPAIGN_STATUS.DRAFT]: [CAMPAIGN_STATUS.OPEN, CAMPAIGN_STATUS.CANCELLED],
  [CAMPAIGN_STATUS.OPEN]: [CAMPAIGN_STATUS.IN_PROGRESS, CAMPAIGN_STATUS.CANCELLED],
  [CAMPAIGN_STATUS.IN_PROGRESS]: [CAMPAIGN_STATUS.SUBMITTED_FOR_REVIEW, CAMPAIGN_STATUS.CANCELLED, CAMPAIGN_STATUS.DISPUTED],
  [CAMPAIGN_STATUS.SUBMITTED_FOR_REVIEW]: [CAMPAIGN_STATUS.COMPLETED, CAMPAIGN_STATUS.IN_PROGRESS, CAMPAIGN_STATUS.DISPUTED],
  [CAMPAIGN_STATUS.COMPLETED]: [CAMPAIGN_STATUS.PAID, CAMPAIGN_STATUS.DISPUTED],
  [CAMPAIGN_STATUS.PAID]: [], // Terminal state
  [CAMPAIGN_STATUS.DISPUTED]: [CAMPAIGN_STATUS.IN_PROGRESS, CAMPAIGN_STATUS.CANCELLED],
  [CAMPAIGN_STATUS.CANCELLED]: [] // Terminal state
};

// Creator-facing stages (simplified for creator view)
const CREATOR_STAGES = {
  BID: 'Bid',
  WAITING_APPROVAL: 'Waiting for Approval',
  COMPLETED: 'Completed',
  PAID: 'Paid'
};

// ============================================
// Main Campaign Schema
// ============================================

const campaignSchema = new mongoose.Schema(
  {
    // Brand / Creator Relations
    businessId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User', 
      required: true,
      index: true
    },
    assignedCreatorId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User',
      index: true
    },
    
    // Campaign Details
    title: { 
      type: String, 
      required: true,
      trim: true,
      minlength: [3, 'Title must be at least 3 characters'],
      maxlength: [200, 'Title cannot exceed 200 characters'],
      index: true
    },
    description: {
      type: String,
      trim: true,
      maxlength: [5000, 'Description cannot exceed 5000 characters']
    },
    instructions: {
      type: String,
      trim: true,
      maxlength: [2000, 'Instructions cannot exceed 2000 characters']
    },
    
    // Budget & Financials
    budget: { 
      type: Number, 
      required: true,
      min: [1, 'Budget must be at least $1'],
      validate: {
        validator: function(v) {
          return v > 0 && v <= 1000000; // Max $1M
        },
        message: 'Budget must be between $1 and $1,000,000'
      }
    },
    fundedAmount: { 
      type: Number, 
      default: 0,
      min: 0,
      validate: {
        validator: function(v) {
          return v <= this.budget;
        },
        message: 'Funded amount cannot exceed budget'
      }
    },
    escrowHeld: { 
      type: Number, 
      default: 0,
      min: 0,
      validate: {
        validator: function(v) {
          return v <= this.budget;
        },
        message: 'Escrow held cannot exceed budget'
      }
    },
    
    // Statuses
    status: {
      type: String,
      enum: Object.values(CAMPAIGN_STATUS),
      default: CAMPAIGN_STATUS.DRAFT,
      index: true
    },
    
    // Business-facing stage (more detailed)
    businessStage: {
      type: String,
      enum: ['Active', 'Submitted for Review', 'Completed', 'Paid'],
      default: 'Active'
    },
    
    // Creator-facing stage (simplified)
    creatorStage: {
      type: String,
      enum: Object.values(CREATOR_STAGES),
      default: CREATOR_STAGES.BID
    },
    
    // Bids
    bids: [bidSchema],
    
    // Timeline
    publishedAt: {
      type: Date
    },
    startedAt: {
      type: Date
    },
    submittedAt: {
      type: Date
    },
    completedAt: {
      type: Date
    },
    paidAt: {
      type: Date
    },
    cancelledAt: {
      type: Date
    },
    
    // Deadline
    deadline: {
      type: Date,
      validate: {
        validator: function(v) {
          if (!v) return true;
          return v > new Date();
        },
        message: 'Deadline must be in the future'
      }
    },
    
    // ============================================
    // NEW: Analytics Fields (for performance tracking)
    // ============================================
    
    /**
     * Number of times this campaign has been viewed
     */
    views: {
      type: Number,
      default: 0,
      min: 0
    },
    
    /**
     * Click-Through Rate percentage (0-100)
     * Calculated as (clicks / views) * 100
     */
    ctr: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    
    /**
     * Return on Investment percentage for completed campaigns
     */
    roi: {
      type: Number,
      default: 0
    },
    
    // Additional Metadata
    tags: [{
      type: String,
      trim: true,
      lowercase: true,
      index: true
    }],
    category: {
      type: String,
      trim: true,
      lowercase: true,
      index: true
    },
    requirements: [{
      type: String,
      trim: true
    }],
    
    // Flag for whether creator can submit multiple deliverables
    allowsMultipleSubmissions: {
      type: Boolean,
      default: false
    },
    
    // Dispute tracking
    disputeReason: {
      type: String,
      trim: true
    },
    disputeResolvedAt: {
      type: Date
    },
    disputeResolution: {
      type: String,
      trim: true
    },

    // ============================================
    // NEW: Escrow Auto-Release & Mutual Completion Fields
    // ============================================

    /**
     * Creator has marked work as completed
     */
    creatorWorkCompleted: {
      type: Boolean,
      default: false
    },

    /**
     * When creator marked work as completed
     */
    creatorWorkCompletedAt: {
      type: Date
    },

    /**
     * Business has approved the work
     */
    businessWorkApproved: {
      type: Boolean,
      default: false
    },

    /**
     * When business approved the work
     */
    businessWorkApprovedAt: {
      type: Date
    },

    /**
     * Deadline for auto-release (7 days after creator marks completed)
     */
    autoReleaseDeadline: {
      type: Date,
      index: true
    },

    /**
     * Number of reminders sent (0-7)
     */
    autoReleaseReminderSent: {
      type: Number,
      default: 0
    },

    /**
     * When the last reminder was sent
     */
    lastReminderSentAt: {
      type: Date
    },

    /**
     * Status of auto-release process
     * - pending: waiting for business approval
     * - reminding: reminders being sent
     * - processing: auto-release in progress
     * - completed: auto-release done
     * - cancelled: business approved before deadline
     */
    autoReleaseStatus: {
      type: String,
      enum: ['pending', 'reminding', 'processing', 'completed', 'cancelled'],
      default: 'pending'
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
campaignSchema.index({ businessId: 1, status: 1, createdAt: -1 });
campaignSchema.index({ assignedCreatorId: 1, status: 1 });
campaignSchema.index({ status: 1, createdAt: -1 });
campaignSchema.index({ status: 1, budget: -1 });
campaignSchema.index({ category: 1, status: 1 });
campaignSchema.index({ tags: 1, status: 1 });

// NEW: Indexes for analytics queries
campaignSchema.index({ views: -1 });
campaignSchema.index({ ctr: -1 });
campaignSchema.index({ roi: -1 });

// NEW: Index for auto-release queries
campaignSchema.index({ autoReleaseDeadline: 1, autoReleaseStatus: 1 });
campaignSchema.index({ creatorWorkCompleted: 1, businessWorkApproved: 1, autoReleaseDeadline: 1 });

// Text search index
campaignSchema.index({ 
  title: 'text', 
  description: 'text', 
  instructions: 'text',
  tags: 'text'
}, {
  weights: {
    title: 10,
    tags: 5,
    description: 2,
    instructions: 1
  },
  name: 'text_search_index'
});

// Date-based indexes for expiration queries
campaignSchema.index({ deadline: 1, status: 1 });
campaignSchema.index({ createdAt: 1 });

// ============================================
// Virtual Fields
// ============================================

/**
 * Calculate remaining budget (budget - fundedAmount)
 */
campaignSchema.virtual('remainingBudget').get(function() {
  return Math.max(0, this.budget - this.fundedAmount);
});

/**
 * Calculate remaining escrow (budget - escrowHeld)
 */
campaignSchema.virtual('remainingEscrow').get(function() {
  return Math.max(0, this.budget - this.escrowHeld);
});

/**
 * Check if campaign is fully funded
 */
campaignSchema.virtual('isFullyFunded').get(function() {
  return this.fundedAmount >= this.budget;
});

/**
 * Get accepted bid (the winning bid)
 */
campaignSchema.virtual('acceptedBid').get(function() {
  return this.bids.find(bid => bid.status === 'accepted');
});

/**
 * Get pending bids count
 */
campaignSchema.virtual('pendingBidsCount').get(function() {
  return this.bids.filter(bid => bid.status === 'pending').length;
});

/**
 * Get total bids amount
 */
campaignSchema.virtual('totalBidsAmount').get(function() {
  return this.bids.reduce((sum, bid) => sum + bid.amount, 0);
});

/**
 * Get campaign progress percentage (based on funding)
 */
campaignSchema.virtual('fundingProgress').get(function() {
  if (this.budget === 0) return 0;
  return Math.min(100, Math.round((this.fundedAmount / this.budget) * 100));
});

/**
 * NEW: Check if both parties have completed the campaign
 */
campaignSchema.virtual('bothPartiesCompleted').get(function() {
  return this.creatorWorkCompleted === true && this.businessWorkApproved === true;
});

/**
 * NEW: Check if auto-release is pending
 */
campaignSchema.virtual('isAutoReleasePending').get(function() {
  return this.creatorWorkCompleted === true && 
         this.businessWorkApproved === false && 
         this.autoReleaseStatus === 'pending';
});

/**
 * NEW: Get days remaining until auto-release
 */
campaignSchema.virtual('autoReleaseDaysRemaining').get(function() {
  if (!this.autoReleaseDeadline) return null;
  const remaining = this.autoReleaseDeadline - new Date();
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / (1000 * 60 * 60 * 24));
});

/**
 * NEW: Get hours remaining until auto-release
 */
campaignSchema.virtual('autoReleaseHoursRemaining').get(function() {
  if (!this.autoReleaseDeadline) return null;
  const remaining = this.autoReleaseDeadline - new Date();
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / (1000 * 60 * 60));
});

// ============================================
// Instance Methods
// ============================================

/**
 * Check if a status transition is valid
 * @param {string} newStatus - Target status
 * @returns {boolean} True if transition is valid
 */
campaignSchema.methods.canTransitionTo = function(newStatus) {
  const allowed = STATUS_TRANSITIONS[this.status];
  return allowed ? allowed.includes(newStatus) : false;
};

/**
 * Transition campaign to a new status with validation
 * @param {string} newStatus - Target status
 * @param {Object} options - Additional options
 * @returns {Promise<Campaign>} Updated campaign
 */
campaignSchema.methods.transitionTo = async function(newStatus, options = {}) {
  if (!this.canTransitionTo(newStatus)) {
    throw new Error(`Cannot transition from ${this.status} to ${newStatus}`);
  }
  
  const oldStatus = this.status;
  this.status = newStatus;
  
  // Update timestamps based on status
  const now = new Date();
  switch (newStatus) {
    case CAMPAIGN_STATUS.OPEN:
      if (!this.publishedAt) this.publishedAt = now;
      break;
    case CAMPAIGN_STATUS.IN_PROGRESS:
      if (!this.startedAt) this.startedAt = now;
      break;
    case CAMPAIGN_STATUS.SUBMITTED_FOR_REVIEW:
      this.submittedAt = now;
      break;
    case CAMPAIGN_STATUS.COMPLETED:
      this.completedAt = now;
      break;
    case CAMPAIGN_STATUS.PAID:
      this.paidAt = now;
      break;
    case CAMPAIGN_STATUS.CANCELLED:
      this.cancelledAt = now;
      break;
  }
  
  if (options.save !== false) {
    await this.save();
  }
  
  return this;
};

/**
 * Check if a creator has already bid on this campaign
 * @param {string} creatorId - Creator's user ID
 * @returns {boolean} True if creator has bid
 */
campaignSchema.methods.hasCreatorBid = function(creatorId) {
  return this.bids.some(bid => bid.creatorId.toString() === creatorId.toString());
};

/**
 * Get a creator's bid on this campaign
 * @param {string} creatorId - Creator's user ID
 * @returns {Object|null} Bid object or null
 */
campaignSchema.methods.getCreatorBid = function(creatorId) {
  return this.bids.find(bid => bid.creatorId.toString() === creatorId.toString());
};

/**
 * Accept a bid and assign the creator
 * @param {string} bidId - Bid ID to accept
 * @returns {Promise<Campaign>} Updated campaign
 */
campaignSchema.methods.acceptBid = async function(bidId) {
  const bid = this.bids.id(bidId);
  if (!bid) {
    throw new Error('Bid not found');
  }
  
  if (bid.status !== 'pending') {
    throw new Error(`Cannot accept bid with status: ${bid.status}`);
  }
  
  // Reject all other pending bids
  this.bids.forEach(b => {
    if (b._id.toString() !== bidId && b.status === 'pending') {
      b.status = 'rejected';
    }
  });
  
  // Accept this bid
  bid.status = 'accepted';
  this.assignedCreatorId = bid.creatorId;
  this.status = CAMPAIGN_STATUS.IN_PROGRESS;
  this.businessStage = 'Active';
  this.creatorStage = CREATOR_STAGES.WAITING_APPROVAL;
  
  if (!this.startedAt) this.startedAt = new Date();
  
  await this.save();
  return this;
};

/**
 * Submit work for a campaign (Creator submits work URL)
 * @param {string} creatorId - Creator's user ID
 * @param {string} workUrl - URL to submitted work
 * @returns {Promise<Campaign>} Updated campaign
 */
campaignSchema.methods.submitWork = async function(creatorId, workUrl) {
  if (this.assignedCreatorId?.toString() !== creatorId.toString()) {
    throw new Error('You are not the assigned creator for this campaign');
  }
  
  if (this.status !== CAMPAIGN_STATUS.IN_PROGRESS) {
    throw new Error(`Cannot submit work when campaign status is ${this.status}`);
  }
  
  const bid = this.getCreatorBid(creatorId);
  if (!bid) {
    throw new Error('Bid not found');
  }
  
  bid.submittedWorkUrl = workUrl;
  bid.submittedAt = new Date();
  
  this.status = CAMPAIGN_STATUS.SUBMITTED_FOR_REVIEW;
  this.businessStage = 'Submitted for Review';
  this.creatorStage = CREATOR_STAGES.COMPLETED;
  this.submittedAt = new Date();
  
  await this.save();
  return this;
};

/**
 * NEW: Creator marks work as completed (starts auto-release timer)
 * @param {string} creatorId - Creator's user ID
 * @param {string} workUrl - Optional work URL if not already submitted
 * @returns {Promise<Campaign>} Updated campaign
 */
campaignSchema.methods.markCreatorCompleted = async function(creatorId, workUrl = null) {
  if (this.assignedCreatorId?.toString() !== creatorId.toString()) {
    throw new Error('You are not the assigned creator for this campaign');
  }
  
  if (this.status !== CAMPAIGN_STATUS.IN_PROGRESS && this.status !== CAMPAIGN_STATUS.SUBMITTED_FOR_REVIEW) {
    throw new Error(`Cannot mark completed when campaign status is ${this.status}`);
  }
  
  if (this.creatorWorkCompleted) {
    throw new Error('You have already marked this work as completed');
  }
  
  // Save work URL if provided
  if (workUrl) {
    const bid = this.getCreatorBid(creatorId);
    if (bid) {
      bid.submittedWorkUrl = workUrl;
      bid.submittedAt = new Date();
    }
  }
  
  // Set creator completion flags
  this.creatorWorkCompleted = true;
  this.creatorWorkCompletedAt = new Date();
  
  // Set auto-release deadline (7 days from now)
  const autoReleaseDays = parseInt(process.env.AUTO_RELEASE_DAYS) || 7;
  this.autoReleaseDeadline = new Date();
  this.autoReleaseDeadline.setDate(this.autoReleaseDeadline.getDate() + autoReleaseDays);
  this.autoReleaseStatus = 'pending';
  
  // Update status if still in progress
  if (this.status === CAMPAIGN_STATUS.IN_PROGRESS) {
    this.status = CAMPAIGN_STATUS.SUBMITTED_FOR_REVIEW;
    this.businessStage = 'Submitted for Review';
    this.creatorStage = CREATOR_STAGES.COMPLETED;
    this.submittedAt = new Date();
  }
  
  await this.save();
  return this;
};

/**
 * NEW: Business approves work and releases payment
 * @param {string} businessId - Business user ID
 * @returns {Promise<Campaign>} Updated campaign
 */
campaignSchema.methods.markBusinessApproved = async function(businessId) {
  if (this.businessId?.toString() !== businessId.toString()) {
    throw new Error('You are not the business that owns this campaign');
  }
  
  if (!this.creatorWorkCompleted) {
    throw new Error('Creator has not marked work as completed yet');
  }
  
  if (this.businessWorkApproved) {
    throw new Error('You have already approved this work');
  }
  
  this.businessWorkApproved = true;
  this.businessWorkApprovedAt = new Date();
  this.autoReleaseStatus = 'cancelled';
  
  await this.save();
  return this;
};

/**
 * NEW: Process auto-release (called by cron job)
 * @returns {Promise<Object>} Result of auto-release
 */
campaignSchema.methods.processAutoRelease = async function() {
  if (!this.creatorWorkCompleted || this.businessWorkApproved) {
    return { success: false, reason: 'Not eligible for auto-release' };
  }
  
  if (new Date() < this.autoReleaseDeadline) {
    return { success: false, reason: 'Deadline not yet reached' };
  }
  
  if (this.autoReleaseStatus === 'completed') {
    return { success: false, reason: 'Already auto-released' };
  }
  
  this.autoReleaseStatus = 'processing';
  await this.save();
  
  // Note: Actual payment processing will be handled by the service layer
  // This method just marks the status
  return { 
    success: true, 
    campaignId: this._id, 
    creatorId: this.assignedCreatorId,
    amount: this.acceptedBid?.amount || this.escrowHeld
  };
};

/**
 * Complete campaign and release payment
 * @returns {Promise<Campaign>} Updated campaign
 */
campaignSchema.methods.complete = async function() {
  if (this.status !== CAMPAIGN_STATUS.SUBMITTED_FOR_REVIEW) {
    throw new Error(`Cannot complete campaign with status: ${this.status}`);
  }
  
  this.status = CAMPAIGN_STATUS.PAID;
  this.businessStage = 'Paid';
  this.creatorStage = CREATOR_STAGES.PAID;
  this.completedAt = new Date();
  this.paidAt = new Date();
  
  await this.save();
  return this;
};

/**
 * Cancel campaign
 * @param {string} reason - Reason for cancellation
 * @returns {Promise<Campaign>} Updated campaign
 */
campaignSchema.methods.cancel = async function(reason) {
  if (!this.canTransitionTo(CAMPAIGN_STATUS.CANCELLED)) {
    throw new Error(`Cannot cancel campaign with status: ${this.status}`);
  }
  
  this.status = CAMPAIGN_STATUS.CANCELLED;
  this.cancelledAt = new Date();
  this.disputeReason = reason;
  
  await this.save();
  return this;
};

// ============================================
// Static Methods
// ============================================

/**
 * Find open campaigns for creator bidding
 * @param {Object} filters - Filter options
 * @returns {Query} Mongoose query
 */
campaignSchema.statics.findOpenCampaigns = function(filters = {}) {
  const query = { 
    status: CAMPAIGN_STATUS.OPEN,
    ...filters
  };
  return this.find(query).sort({ createdAt: -1 });
};

/**
 * Find campaigns by business
 * @param {string} businessId - Business user ID
 * @param {Object} options - Query options
 * @returns {Query} Mongoose query
 */
campaignSchema.statics.findByBusiness = function(businessId, options = {}) {
  const { limit = 50, skip = 0, status } = options;
  const query = { businessId };
  if (status) query.status = status;
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip);
};

/**
 * Find campaigns by creator (assigned or bid on)
 * @param {string} creatorId - Creator user ID
 * @param {Object} options - Query options
 * @returns {Query} Mongoose query
 */
campaignSchema.statics.findByCreator = function(creatorId, options = {}) {
  const { limit = 50, skip = 0 } = options;
  
  return this.find({
    $or: [
      { assignedCreatorId: creatorId },
      { 'bids.creatorId': creatorId }
    ]
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip);
};

/**
 * Get campaign statistics by status
 * @param {string} businessId - Business user ID
 * @returns {Promise<Object>} Statistics object
 */
campaignSchema.statics.getStatsByBusiness = async function(businessId) {
  return this.aggregate([
    { $match: { businessId: mongoose.Types.ObjectId(businessId) } },
    { $group: {
      _id: '$status',
      count: { $sum: 1 },
      totalBudget: { $sum: '$budget' },
      totalFunded: { $sum: '$fundedAmount' },
      totalPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$budget', 0] } }
    }}
  ]);
};

/**
 * NEW: Find campaigns pending auto-release (deadline passed)
 * @returns {Query} Mongoose query
 */
campaignSchema.statics.findPendingAutoRelease = function() {
  const now = new Date();
  return this.find({
    creatorWorkCompleted: true,
    businessWorkApproved: false,
    autoReleaseDeadline: { $lte: now },
    autoReleaseStatus: { $in: ['pending', 'reminding'] }
  }).populate('businessId assignedCreatorId');
};

/**
 * NEW: Find campaigns needing reminders
 * @param {number} daysThreshold - Days before deadline to check
 * @returns {Query} Mongoose query
 */
campaignSchema.statics.findCampaignsNeedingReminders = function(daysThreshold) {
  const now = new Date();
  const futureDeadline = new Date();
  futureDeadline.setDate(futureDeadline.getDate() + daysThreshold);
  
  return this.find({
    creatorWorkCompleted: true,
    businessWorkApproved: false,
    autoReleaseDeadline: { $lte: futureDeadline, $gt: now },
    autoReleaseStatus: { $in: ['pending', 'reminding'] }
  });
};

// ============================================
// Pre-Save Hooks
// ============================================

/**
 * Validate status transition on save
 */
campaignSchema.pre('save', function(next) {
  // Skip validation for new documents
  if (this.isNew) {
    return next();
  }
  
  // Check if status is changing
  const originalStatus = this.originalStatus || this.status;
  if (this.isModified('status') && originalStatus !== this.status) {
    const allowed = STATUS_TRANSITIONS[originalStatus];
    if (!allowed || !allowed.includes(this.status)) {
      return next(new Error(`Invalid status transition from ${originalStatus} to ${this.status}`));
    }
  }
  
  next();
});

/**
 * Store original status before modification
 */
campaignSchema.pre('save', function(next) {
  if (!this.isNew && this.isModified('status')) {
    this.originalStatus = this.status;
  }
  next();
});

/**
 * Auto-calculate bid net amounts
 */
campaignSchema.pre('save', function(next) {
  this.bids.forEach(bid => {
    if (bid.amount && !bid.netAmount) {
      const feeRate = 0.05; // 5% platform fee on tips
      bid.feeCalculated = bid.amount * feeRate;
      bid.netAmount = bid.amount - bid.feeCalculated;
    }
  });
  next();
});

/**
 * NEW: Auto-set auto-release deadline when creator marks completed
 */
campaignSchema.pre('save', function(next) {
  // If creatorWorkCompleted just changed from false to true, set deadline
  if (this.isModified('creatorWorkCompleted') && this.creatorWorkCompleted === true && !this.autoReleaseDeadline) {
    const autoReleaseDays = parseInt(process.env.AUTO_RELEASE_DAYS) || 7;
    this.autoReleaseDeadline = new Date();
    this.autoReleaseDeadline.setDate(this.autoReleaseDeadline.getDate() + autoReleaseDays);
    this.autoReleaseStatus = 'pending';
  }
  next();
});

// ============================================
// Exports
// ============================================

module.exports = {
  Campaign: mongoose.model('Campaign', campaignSchema),
  CAMPAIGN_STATUS,
  CREATOR_STAGES,
  STATUS_TRANSITIONS
};
