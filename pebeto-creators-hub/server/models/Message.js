/**
 * Message Model for Pebeto Creator's Hub
 * 
 * Manages direct messages between users (creators, businesses, admins).
 * Supports private conversations with read receipts and message history.
 * Messages are stored encrypted for confidentiality.
 * 
 * @module models/Message
 */

const mongoose = require('mongoose');

// ============================================
// Constants
// ============================================

const MESSAGE_TYPES = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  FILE: 'file',
  SYSTEM: 'system'
};

const MESSAGE_STATUS = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  DELETED: 'deleted',
  RECALLED: 'recalled'
};

// ============================================
// Message Schema
// ============================================

const messageSchema = new mongoose.Schema(
  {
    // Conversation this message belongs to
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true
    },
    
    // Sender of the message
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    
    // Recipient of the message (for quick lookup)
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    
    // Message content (encrypted in production)
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: [5000, 'Message cannot exceed 5000 characters']
    },
    
    // Message type
    type: {
      type: String,
      enum: Object.values(MESSAGE_TYPES),
      default: MESSAGE_TYPES.TEXT
    },
    
    // Status of the message
    status: {
      type: String,
      enum: Object.values(MESSAGE_STATUS),
      default: MESSAGE_STATUS.SENT,
      index: true
    },
    
    // Media attachment (if any)
    attachment: {
      url: { type: String, trim: true },
      type: { type: String, enum: ['image', 'video', 'file', 'document'] },
      name: { type: String, trim: true },
      size: { type: Number, default: 0 },
      mimeType: { type: String, trim: true }
    },
    
    // Read receipt tracking
    readAt: {
      type: Date
    },
    
    deliveredAt: {
      type: Date
    },
    
    // For message recall (within 5 minutes)
    recalledAt: {
      type: Date
    },
    
    recalledReason: {
      type: String,
      trim: true,
      maxlength: 200
    },
    
    // For deleted messages (soft delete)
    deletedBy: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    
    // Reply to a specific message (threading)
    replyToId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message'
    },
    
    // Message metadata
    metadata: {
      ipAddress: { type: String },
      userAgent: { type: String },
      isEncrypted: { type: Boolean, default: false },
      clientMessageId: { type: String, index: true } // For deduplication
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

// Conversation message retrieval (most important)
messageSchema.index({ conversationId: 1, createdAt: -1 });

// User's messages (for inbox)
messageSchema.index({ senderId: 1, createdAt: -1 });
messageSchema.index({ recipientId: 1, createdAt: -1 });

// Unread messages count query
messageSchema.index({ conversationId: 1, recipientId: 1, status: 1 });

// Delete old messages cleanup
messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }); // 90 days

// Client message ID for deduplication
messageSchema.index({ 'metadata.clientMessageId': 1 }, { sparse: true });

// Recall/delete queries
messageSchema.index({ recalledAt: 1 });
messageSchema.index({ deletedBy: 1 });

// ============================================
// Virtual Fields
// ============================================

/**
 * Check if message is read
 */
messageSchema.virtual('isRead').get(function() {
  return this.status === MESSAGE_STATUS.READ;
});

/**
 * Check if message is delivered
 */
messageSchema.virtual('isDelivered').get(function() {
  return this.status === MESSAGE_STATUS.DELIVERED || this.status === MESSAGE_STATUS.READ;
});

/**
 * Check if message was recalled
 */
messageSchema.virtual('isRecalled').get(function() {
  return this.status === MESSAGE_STATUS.RECALLED && this.recalledAt !== null;
});

/**
 * Check if message can be recalled (within 5 minutes of sending)
 */
messageSchema.virtual('canBeRecalled').get(function() {
  if (this.status !== MESSAGE_STATUS.SENT && this.status !== MESSAGE_STATUS.DELIVERED) {
    return false;
  }
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  return this.createdAt > fiveMinutesAgo;
});

/**
 * Get message age in minutes
 */
messageSchema.virtual('ageInMinutes').get(function() {
  return Math.floor((Date.now() - this.createdAt) / (1000 * 60));
});

/**
 * Get preview of message (truncated)
 */
messageSchema.virtual('preview').get(function() {
  if (this.type !== MESSAGE_TYPES.TEXT) return `[${this.type}]`;
  if (this.content.length <= 100) return this.content;
  return this.content.substring(0, 97) + '...';
});

// ============================================
// Instance Methods
// ============================================

/**
 * Mark message as delivered
 * @returns {Promise<Message>}
 */
messageSchema.methods.markDelivered = async function() {
  if (this.status === MESSAGE_STATUS.SENT) {
    this.status = MESSAGE_STATUS.DELIVERED;
    this.deliveredAt = new Date();
    await this.save();
  }
  return this;
};

/**
 * Mark message as read
 * @returns {Promise<Message>}
 */
messageSchema.methods.markRead = async function() {
  if (this.status !== MESSAGE_STATUS.READ) {
    this.status = MESSAGE_STATUS.READ;
    this.readAt = new Date();
    await this.save();
  }
  return this;
};

/**
 * Recall a message (sender only, within 5 minutes)
 * @param {string} reason - Reason for recall
 * @returns {Promise<Message>}
 */
messageSchema.methods.recall = async function(reason = null) {
  if (!this.canBeRecalled) {
    throw new Error('Message can only be recalled within 5 minutes of sending');
  }
  
  this.status = MESSAGE_STATUS.RECALLED;
  this.recalledAt = new Date();
  this.recalledReason = reason || 'Message recalled by sender';
  
  // Clear content for privacy (but keep metadata)
  this.content = '[This message was recalled by the sender]';
  
  await this.save();
  return this;
};

/**
 * Soft delete message for a specific user
 * @param {string} userId - ID of user deleting the message
 * @returns {Promise<Message>}
 */
messageSchema.methods.deleteForUser = async function(userId) {
  if (!this.deletedBy.includes(userId)) {
    this.deletedBy.push(userId);
    await this.save();
  }
  return this;
};

/**
 * Check if message is visible to a specific user
 * @param {string} userId - User ID to check
 * @returns {boolean}
 */
messageSchema.methods.isVisibleToUser = function(userId) {
  return !this.deletedBy.includes(userId);
};

// ============================================
// Static Methods
// ============================================

/**
 * Create a new message
 * @param {Object} data - Message data
 * @returns {Promise<Message>}
 */
messageSchema.statics.createMessage = async function(data) {
  const message = new this({
    conversationId: data.conversationId,
    senderId: data.senderId,
    recipientId: data.recipientId,
    content: data.content,
    type: data.type || MESSAGE_TYPES.TEXT,
    attachment: data.attachment || null,
    replyToId: data.replyToId || null,
    metadata: {
      clientMessageId: data.clientMessageId,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent
    }
  });
  
  await message.save();
  return message;
};

/**
 * Get messages for a conversation with pagination
 * @param {string} conversationId - Conversation ID
 * @param {string} userId - User ID requesting messages
 * @param {Object} options - Pagination options
 * @returns {Promise<Object>} Messages and pagination
 */
messageSchema.statics.getConversationMessages = async function(conversationId, userId, options = {}) {
  const { limit = 50, before = null, after = null } = options;
  const effectiveLimit = Math.min(limit, 100);
  
  const query = {
    conversationId,
    deletedBy: { $ne: userId },
    status: { $ne: MESSAGE_STATUS.DELETED }
  };
  
  if (before) {
    query.createdAt = { $lt: new Date(before) };
  }
  
  if (after) {
    query.createdAt = { $gt: new Date(after) };
  }
  
  const messages = await this.find(query)
    .sort({ createdAt: -1 })
    .limit(effectiveLimit)
    .populate('senderId', '_id email uniqueCode role profile.stageName profile.companyName profile.avatarUrl')
    .populate('replyToId', 'content senderId type createdAt');
  
  // Mark unread messages as delivered for recipient
  await this.updateMany(
    {
      conversationId,
      recipientId: userId,
      status: MESSAGE_STATUS.SENT
    },
    { status: MESSAGE_STATUS.DELIVERED, deliveredAt: new Date() }
  );
  
  return {
    messages: messages.reverse(), // Return in chronological order
    hasMore: messages.length === effectiveLimit,
    count: messages.length
  };
};

/**
 * Get unread message count for a user
 * @param {string} userId - User ID
 * @returns {Promise<number>} Unread count
 */
messageSchema.statics.getUnreadCount = async function(userId) {
  return this.countDocuments({
    recipientId: userId,
    status: { $in: [MESSAGE_STATUS.SENT, MESSAGE_STATUS.DELIVERED] },
    deletedBy: { $ne: userId }
  });
};

/**
 * Get unread count per conversation for a user
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Unread counts by conversation
 */
messageSchema.statics.getUnreadCountByConversation = async function(userId) {
  return this.aggregate([
    {
      $match: {
        recipientId: userId,
        status: { $in: [MESSAGE_STATUS.SENT, MESSAGE_STATUS.DELIVERED] },
        deletedBy: { $ne: userId }
      }
    },
    {
      $group: {
        _id: '$conversationId',
        count: { $sum: 1 },
        lastMessageAt: { $max: '$createdAt' }
      }
    },
    { $sort: { lastMessageAt: -1 } }
  ]);
};

/**
 * Mark all messages in a conversation as read for a user
 * @param {string} conversationId - Conversation ID
 * @param {string} userId - User ID marking as read
 * @returns {Promise<Object>} Update result
 */
messageSchema.statics.markConversationRead = async function(conversationId, userId) {
  const result = await this.updateMany(
    {
      conversationId,
      recipientId: userId,
      status: { $in: [MESSAGE_STATUS.SENT, MESSAGE_STATUS.DELIVERED] }
    },
    {
      status: MESSAGE_STATUS.READ,
      readAt: new Date()
    }
  );
  return result;
};

/**
 * Delete old messages (older than days)
 * @param {number} days - Days to keep
 * @returns {Promise<number>} Number of deleted messages
 */
messageSchema.statics.deleteOldMessages = async function(days = 90) {
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await this.deleteMany({
    createdAt: { $lt: cutoffDate },
    status: { $in: [MESSAGE_STATUS.READ, MESSAGE_STATUS.DELIVERED] }
  });
  return result.deletedCount;
};

/**
 * Find duplicate message by client message ID
 * @param {string} clientMessageId - Client-generated message ID
 * @returns {Promise<Message|null>}
 */
messageSchema.statics.findByClientMessageId = async function(clientMessageId) {
  return this.findOne({ 'metadata.clientMessageId': clientMessageId });
};

// ============================================
// Pre-save Hooks
// ============================================

/**
 * Auto-truncate content if too long
 */
messageSchema.pre('save', function(next) {
  if (this.content && this.content.length > 5000) {
    this.content = this.content.substring(0, 4997) + '...';
  }
  next();
});

/**
 * Set delivered timestamp when status changes to delivered
 */
messageSchema.pre('save', function(next) {
  if (this.isModified('status') && this.status === MESSAGE_STATUS.DELIVERED && !this.deliveredAt) {
    this.deliveredAt = new Date();
  }
  if (this.isModified('status') && this.status === MESSAGE_STATUS.READ && !this.readAt) {
    this.readAt = new Date();
  }
  next();
});

// ============================================
// Exports
// ============================================

module.exports = mongoose.model('Message', messageSchema);
module.exports.MESSAGE_TYPES = MESSAGE_TYPES;
module.exports.MESSAGE_STATUS = MESSAGE_STATUS;
