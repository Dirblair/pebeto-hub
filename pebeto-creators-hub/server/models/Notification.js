/**
 * Notification Model for Pebeto Creator's Hub
 * 
 * Manages user notifications for tips, campaign updates, withdrawals,
 * and system announcements.
 * 
 * @module models/Notification
 */

const mongoose = require('mongoose');

// ============================================
// Constants
// ============================================

const NOTIFICATION_TYPES = {
  // Wallet/Tip related
  TIP_RECEIVED: 'tip_received',
  DEPOSIT_CONFIRMED: 'deposit_confirmed',
  WITHDRAWAL_PROCESSED: 'withdrawal_processed',
  WITHDRAWAL_FAILED: 'withdrawal_failed',
  
  // Campaign related
  CAMPAIGN_CREATED: 'campaign_created',
  CAMPAIGN_UPDATED: 'campaign_updated',
  CAMPAIGN_FUNDED: 'campaign_funded',
  CAMPAIGN_COMPLETED: 'campaign_completed',
  BID_RECEIVED: 'bid_received',
  BID_ACCEPTED: 'bid_accepted',
  BID_REJECTED: 'bid_rejected',
  WORK_SUBMITTED: 'work_submitted',
  WORK_APPROVED: 'work_approved',
  WORK_REJECTED: 'work_rejected',
  
  // Community related
  NEW_FOLLOWER: 'new_follower',
  NEW_COMMENT: 'new_comment',
  NEW_LIKE: 'new_like',
  POST_SHARED: 'post_shared',
  
  // System related
  ACCOUNT_VERIFIED: 'account_verified',
  PAYOUT_INITIATED: 'payout_initiated',
  PAYOUT_COMPLETED: 'payout_completed',
  SYSTEM_ANNOUNCEMENT: 'system_announcement',
  SECURITY_ALERT: 'security_alert',
};

const NOTIFICATION_PRIORITIES = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  URGENT: 'urgent',
};

const NOTIFICATION_STATUS = {
  UNREAD: 'unread',
  READ: 'read',
  ARCHIVED: 'archived',
  DELETED: 'deleted',
};

// ============================================
// Schema Definition
// ============================================

const notificationSchema = new mongoose.Schema(
  {
    // Recipient
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    
    // Notification content
    type: {
      type: String,
      enum: Object.values(NOTIFICATION_TYPES),
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    body: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    
    // Priority level
    priority: {
      type: String,
      enum: Object.values(NOTIFICATION_PRIORITIES),
      default: NOTIFICATION_PRIORITIES.MEDIUM,
      index: true,
    },
    
    // Status
    status: {
      type: String,
      enum: Object.values(NOTIFICATION_STATUS),
      default: NOTIFICATION_STATUS.UNREAD,
      index: true,
    },
    
    // Read tracking
    readAt: {
      type: Date,
    },
    
    // Action/Deep link data
    actionUrl: {
      type: String,
      trim: true,
    },
    actionType: {
      type: String,
      enum: ['campaign', 'profile', 'transaction', 'withdrawal', 'post', 'message', 'settings'],
    },
    actionId: {
      type: String,
    },
    
    // Additional metadata
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    
    // For email/push delivery tracking
    emailSent: {
      type: Boolean,
      default: false,
    },
    pushSent: {
      type: Boolean,
      default: false,
    },
    
    // Expiration
    expiresAt: {
      type: Date,
      index: true,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    },
    
    // Sender info (if applicable)
    fromUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    fromUserName: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ============================================
// Indexes
// ============================================

// User notification queries
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, status: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, type: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, priority: 1, createdAt: -1 });

// Expiration cleanup
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// TTL for old read notifications (delete after 90 days)
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// ============================================
// Virtual Fields
// ============================================

notificationSchema.virtual('isRead').get(function() {
  return this.status === NOTIFICATION_STATUS.READ;
});

notificationSchema.virtual('isUrgent').get(function() {
  return this.priority === NOTIFICATION_PRIORITIES.URGENT;
});

notificationSchema.virtual('timeAgo').get(function() {
  const seconds = Math.floor((new Date() - this.createdAt) / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months !== 1 ? 's' : ''} ago`;
});

// ============================================
// Instance Methods
// ============================================

notificationSchema.methods.markAsRead = async function() {
  if (this.status === NOTIFICATION_STATUS.UNREAD) {
    this.status = NOTIFICATION_STATUS.READ;
    this.readAt = new Date();
    await this.save();
  }
  return this;
};

notificationSchema.methods.markAsUnread = async function() {
  if (this.status === NOTIFICATION_STATUS.READ) {
    this.status = NOTIFICATION_STATUS.UNREAD;
    this.readAt = null;
    await this.save();
  }
  return this;
};

notificationSchema.methods.archive = async function() {
  this.status = NOTIFICATION_STATUS.ARCHIVED;
  await this.save();
  return this;
};

notificationSchema.methods.delete = async function() {
  this.status = NOTIFICATION_STATUS.DELETED;
  await this.save();
  return this;
};

// ============================================
// Static Methods
// ============================================

/**
 * Create a notification
 * @param {Object} data - Notification data
 * @returns {Promise<Object>} Created notification
 */
notificationSchema.statics.createNotification = async function(data) {
  const notification = new this(data);
  await notification.save();
  return notification;
};

/**
 * Get unread count for a user
 * @param {string} userId - User ID
 * @returns {Promise<number>} Unread count
 */
notificationSchema.statics.getUnreadCount = async function(userId) {
  return this.countDocuments({
    userId,
    status: NOTIFICATION_STATUS.UNREAD,
    expiresAt: { $gt: new Date() },
  });
};

/**
 * Get notifications for a user with pagination
 * @param {string} userId - User ID
 * @param {Object} options - Pagination options
 * @returns {Promise<Object>} Notifications and pagination
 */
notificationSchema.statics.getUserNotifications = async function(userId, options = {}) {
  const { page = 1, limit = 20, status = null, type = null } = options;
  const skip = (page - 1) * limit;
  const effectiveLimit = Math.min(limit, 100);
  
  const query = { userId, expiresAt: { $gt: new Date() } };
  if (status) query.status = status;
  if (type) query.type = type;
  
  const [notifications, total] = await Promise.all([
    this.find(query)
      .sort({ priority: -1, createdAt: -1 })
      .skip(skip)
      .limit(effectiveLimit)
      .populate('fromUserId', 'email uniqueCode profile.stageName profile.companyName profile.avatarUrl')
      .lean(),
    this.countDocuments(query),
  ]);
  
  return {
    notifications,
    unreadCount: await this.getUnreadCount(userId),
    pagination: {
      page,
      limit: effectiveLimit,
      total,
      pages: Math.ceil(total / effectiveLimit),
      hasMore: skip + notifications.length < total,
    },
  };
};

/**
 * Mark all notifications as read for a user
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Update result
 */
notificationSchema.statics.markAllAsRead = async function(userId) {
  const result = await this.updateMany(
    { userId, status: NOTIFICATION_STATUS.UNREAD },
    { status: NOTIFICATION_STATUS.READ, readAt: new Date() }
  );
  return result;
};

/**
 * Delete old notifications (older than days)
 * @param {number} days - Days to keep
 * @returns {Promise<number>} Deleted count
 */
notificationSchema.statics.deleteOldNotifications = async function(days = 30) {
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await this.deleteMany({
    createdAt: { $lt: cutoffDate },
    status: { $in: [NOTIFICATION_STATUS.READ, NOTIFICATION_STATUS.ARCHIVED] },
  });
  return result.deletedCount;
};

// ============================================
// Pre-save Hooks
// ============================================

notificationSchema.pre('save', function(next) {
  if (this.status === NOTIFICATION_STATUS.READ && !this.readAt) {
    this.readAt = new Date();
  }
  next();
});

// ============================================
// Exports
// ============================================

module.exports = {
  Notification: mongoose.model('Notification', notificationSchema),
  NOTIFICATION_TYPES,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_STATUS,
};
