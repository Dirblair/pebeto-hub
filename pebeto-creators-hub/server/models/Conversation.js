/**
 * Conversation Model for Pebeto Creator's Hub
 * 
 * Manages conversation threads between users (creators, businesses, admins).
 * Tracks participants, last message, unread counts, and conversation metadata.
 * 
 * @module models/Conversation
 */

const mongoose = require('mongoose');

// ============================================
// Constants
// ============================================

const CONVERSATION_TYPES = {
  DIRECT: 'direct',      // One-on-one conversation
  GROUP: 'group',        // Multi-participant conversation (future)
  CAMPAIGN: 'campaign'   // Campaign-related conversation
};

const CONVERSATION_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  MUTED: 'muted',
  DELETED: 'deleted'
};

// ============================================
// Participant Sub-Schema
// ============================================

const participantSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  role: {
    type: String,
    enum: ['creator', 'business', 'admin', 'member'],
    default: 'member'
  },
  joinedAt: {
    type: Date,
    default: Date.now
  },
  lastReadAt: {
    type: Date,
    default: Date.now
  },
  lastSeenAt: {
    type: Date,
    default: Date.now
  },
  unreadCount: {
    type: Number,
    default: 0,
    min: 0
  },
  isMuted: {
    type: Boolean,
    default: false
  },
  isArchived: {
    type: Boolean,
    default: false
  },
  leftAt: {
    type: Date
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { _id: false });

// ============================================
// Conversation Schema
// ============================================

const conversationSchema = new mongoose.Schema(
  {
    // Conversation type
    type: {
      type: String,
      enum: Object.values(CONVERSATION_TYPES),
      default: CONVERSATION_TYPES.DIRECT,
      index: true
    },
    
    // Participants in the conversation
    participants: [participantSchema],
    
    // For direct conversations: convenience fields for quick lookup
    participantIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true
    }],
    
    // Last message preview
    lastMessage: {
      content: { type: String, trim: true, maxlength: 200 },
      senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      senderName: { type: String, trim: true },
      sentAt: { type: Date, default: Date.now },
      type: { type: String, default: 'text' }
    },
    
    // Conversation metadata
    title: {
      type: String,
      trim: true,
      maxlength: 100
    },
    
    // For group conversations (future)
    groupAvatar: {
      type: String,
      trim: true
    },
    
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    
    // Campaign association (if campaign-related)
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      index: true,
      sparse: true
    },
    
    // Status
    status: {
      type: String,
      enum: Object.values(CONVERSATION_STATUS),
      default: CONVERSATION_STATUS.ACTIVE,
      index: true
    },
    
    // Message count statistics
    messageCount: {
      type: Number,
      default: 0,
      min: 0
    },
    
    // Last activity timestamp (updated on every message)
    lastActivityAt: {
      type: Date,
      default: Date.now,
      index: true
    },
    
    // Metadata
    metadata: {
      isEncrypted: { type: Boolean, default: false },
      pinnedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      labels: [{ type: String, trim: true }],
      notes: { type: String, trim: true, maxlength: 500 }
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

// Find conversations for a user (most common query)
conversationSchema.index({ participantIds: 1, lastActivityAt: -1 });
conversationSchema.index({ 'participants.userId': 1, lastActivityAt: -1 });

// Active conversations only
conversationSchema.index({ participantIds: 1, status: 1, lastActivityAt: -1 });

// Unread conversations query
conversationSchema.index({ 'participants.userId': 1, 'participants.unreadCount': 1 });

// Campaign conversations
conversationSchema.index({ campaignId: 1, type: 1 });

// Archived conversations cleanup
conversationSchema.index({ status: 1, lastActivityAt: 1 });

// ============================================
// Virtual Fields
// ============================================

/**
 * Get active participants (excluding those who left)
 */
conversationSchema.virtual('activeParticipants').get(function() {
  return this.participants.filter(p => p.isActive === true && !p.leftAt);
});

/**
 * Get participant count
 */
conversationSchema.virtual('participantCount').get(function() {
  return this.activeParticipants.length;
});

/**
 * Check if conversation is a direct conversation between two people
 */
conversationSchema.virtual('isDirect').get(function() {
  return this.type === CONVERSATION_TYPES.DIRECT && this.activeParticipants.length === 2;
});

/**
 * Check if conversation is archived
 */
conversationSchema.virtual('isArchived').get(function() {
  return this.status === CONVERSATION_STATUS.ARCHIVED;
});

/**
 * Get formatted last message time (relative)
 */
conversationSchema.virtual('lastMessageTimeAgo').get(function() {
  if (!this.lastMessage?.sentAt) return '';
  const seconds = Math.floor((new Date() - this.lastMessage.sentAt) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return this.lastMessage.sentAt.toLocaleDateString();
});

// ============================================
// Instance Methods
// ============================================

/**
 * Get participant data for a specific user
 * @param {string} userId - User ID
 * @returns {Object|null} Participant object or null
 */
conversationSchema.methods.getParticipant = function(userId) {
  return this.participants.find(p => p.userId.toString() === userId.toString());
};

/**
 * Check if user is a participant in this conversation
 * @param {string} userId - User ID
 * @returns {boolean}
 */
conversationSchema.methods.isParticipant = function(userId) {
  return this.participants.some(p => p.userId.toString() === userId.toString() && p.isActive === true);
};

/**
 * Add a participant to the conversation
 * @param {string} userId - User ID to add
 * @param {string} role - User role in conversation
 * @returns {Promise<Conversation>}
 */
conversationSchema.methods.addParticipant = async function(userId, role = 'member') {
  if (this.isParticipant(userId)) {
    return this;
  }
  
  this.participants.push({
    userId,
    role,
    joinedAt: new Date(),
    lastReadAt: new Date(),
    lastSeenAt: new Date(),
    isActive: true
  });
  
  if (!this.participantIds.includes(userId)) {
    this.participantIds.push(userId);
  }
  
  await this.save();
  return this;
};

/**
 * Remove a participant from the conversation
 * @param {string} userId - User ID to remove
 * @returns {Promise<Conversation>}
 */
conversationSchema.methods.removeParticipant = async function(userId) {
  const participant = this.getParticipant(userId);
  if (participant) {
    participant.isActive = false;
    participant.leftAt = new Date();
    this.participantIds = this.participantIds.filter(id => id.toString() !== userId.toString());
    await this.save();
  }
  return this;
};

/**
 * Update user's last read timestamp and reset unread count
 * @param {string} userId - User ID
 * @returns {Promise<Conversation>}
 */
conversationSchema.methods.markRead = async function(userId) {
  const participant = this.getParticipant(userId);
  if (participant) {
    participant.lastReadAt = new Date();
    participant.unreadCount = 0;
    await this.save();
  }
  return this;
};

/**
 * Increment unread count for a participant (except sender)
 * @param {string} senderId - ID of message sender
 * @returns {Promise<Conversation>}
 */
conversationSchema.methods.incrementUnreadCount = async function(senderId) {
  for (const participant of this.participants) {
    if (participant.userId.toString() !== senderId.toString() && participant.isActive) {
      participant.unreadCount += 1;
    }
  }
  await this.save();
  return this;
};

/**
 * Update last message preview
 * @param {Object} messageData - Last message data
 * @returns {Promise<Conversation>}
 */
conversationSchema.methods.updateLastMessage = async function(messageData) {
  this.lastMessage = {
    content: messageData.content.substring(0, 200),
    senderId: messageData.senderId,
    senderName: messageData.senderName,
    sentAt: new Date(),
    type: messageData.type || 'text'
  };
  this.lastActivityAt = new Date();
  this.messageCount += 1;
  await this.save();
  return this;
};

/**
 * Archive conversation for a user
 * @param {string} userId - User ID
 * @returns {Promise<Conversation>}
 */
conversationSchema.methods.archiveForUser = async function(userId) {
  const participant = this.getParticipant(userId);
  if (participant) {
    participant.isArchived = true;
    await this.save();
  }
  return this;
};

/**
 * Unarchive conversation for a user
 * @param {string} userId - User ID
 * @returns {Promise<Conversation>}
 */
conversationSchema.methods.unarchiveForUser = async function(userId) {
  const participant = this.getParticipant(userId);
  if (participant) {
    participant.isArchived = false;
    await this.save();
  }
  return this;
};

/**
 * Mute conversation for a user
 * @param {string} userId - User ID
 * @returns {Promise<Conversation>}
 */
conversationSchema.methods.muteForUser = async function(userId) {
  const participant = this.getParticipant(userId);
  if (participant) {
    participant.isMuted = true;
    await this.save();
  }
  return this;
};

/**
 * Unmute conversation for a user
 * @param {string} userId - User ID
 * @returns {Promise<Conversation>}
 */
conversationSchema.methods.unmuteForUser = async function(userId) {
  const participant = this.getParticipant(userId);
  if (participant) {
    participant.isMuted = false;
    await this.save();
  }
  return this;
};

/**
 * Update user's last seen timestamp
 * @param {string} userId - User ID
 * @returns {Promise<Conversation>}
 */
conversationSchema.methods.updateLastSeen = async function(userId) {
  const participant = this.getParticipant(userId);
  if (participant) {
    participant.lastSeenAt = new Date();
    await this.save();
  }
  return this;
};

// ============================================
// Static Methods
// ============================================

/**
 * Get or create a direct conversation between two users
 * @param {string} user1Id - First user ID
 * @param {string} user2Id - Second user ID
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} { conversation, isNew }
 */
conversationSchema.statics.getOrCreateDirectConversation = async function(user1Id, user2Id, options = {}) {
  // Check if conversation already exists
  let conversation = await this.findOne({
    type: CONVERSATION_TYPES.DIRECT,
    participantIds: { $all: [user1Id, user2Id], $size: 2 },
    status: { $ne: CONVERSATION_STATUS.DELETED }
  });
  
  if (conversation) {
    return { conversation, isNew: false };
  }
  
  // Create new conversation
  conversation = new this({
    type: CONVERSATION_TYPES.DIRECT,
    participants: [
      { userId: user1Id, role: 'member', joinedAt: new Date() },
      { userId: user2Id, role: 'member', joinedAt: new Date() }
    ],
    participantIds: [user1Id, user2Id],
    status: CONVERSATION_STATUS.ACTIVE,
    createdBy: user1Id
  });
  
  await conversation.save();
  return { conversation, isNew: true };
};

/**
 * Get conversations for a user with pagination
 * @param {string} userId - User ID
 * @param {Object} options - Pagination and filter options
 * @returns {Promise<Object>} Conversations and pagination
 */
conversationSchema.statics.getUserConversations = async function(userId, options = {}) {
  const { limit = 20, skip = 0, status = 'active', archived = false } = options;
  const effectiveLimit = Math.min(limit, 100);
  
  const matchCondition = {
    participantIds: userId,
    status: { $ne: CONVERSATION_STATUS.DELETED }
  };
  
  if (status !== 'all') {
    matchCondition.status = status;
  }
  
  // Filter archived for user
  const pipeline = [
    { $match: matchCondition },
    {
      $addFields: {
        isArchivedForUser: {
          $let: {
            vars: {
              participant: {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: '$participants',
                      as: 'p',
                      cond: { $eq: ['$$p.userId', userId] }
                    }
                  },
                  0
                ]
              }
            },
            in: '$$participant.isArchived'
          }
        }
      }
    }
  ];
  
  if (archived === false) {
    pipeline.push({ $match: { isArchivedForUser: { $ne: true } } });
  } else if (archived === true) {
    pipeline.push({ $match: { isArchivedForUser: true } });
  }
  
  pipeline.push(
    { $sort: { lastActivityAt: -1 } },
    { $skip: skip },
    { $limit: effectiveLimit },
    {
      $lookup: {
        from: 'users',
        localField: 'participantIds',
        foreignField: '_id',
        as: 'participantDetails'
      }
    }
  );
  
  const [conversations, total] = await Promise.all([
    this.aggregate(pipeline),
    this.countDocuments({ participantIds: userId, status: { $ne: CONVERSATION_STATUS.DELETED } })
  ]);
  
  // Get unread counts per conversation for this user
  const Message = require('./Message');
  const unreadCounts = await Message.getUnreadCountByConversation(userId);
  const unreadMap = new Map(unreadCounts.map(u => [u._id.toString(), u.count]));
  
  const enrichedConversations = conversations.map(conv => ({
    ...conv,
    unreadCount: unreadMap.get(conv._id.toString()) || 0,
    participantDetails: conv.participantDetails.filter(p => p._id.toString() !== userId)
  }));
  
  return {
    conversations: enrichedConversations,
    pagination: {
      skip,
      limit: effectiveLimit,
      total,
      hasMore: skip + conversations.length < total
    }
  };
};

/**
 * Get conversation by participants (direct conversation lookup)
 * @param {string} user1Id - First user ID
 * @param {string} user2Id - Second user ID
 * @returns {Promise<Object|null>}
 */
conversationSchema.statics.findDirectConversation = async function(user1Id, user2Id) {
  return this.findOne({
    type: CONVERSATION_TYPES.DIRECT,
    participantIds: { $all: [user1Id, user2Id], $size: 2 },
    status: { $ne: CONVERSATION_STATUS.DELETED }
  });
};

/**
 * Get total unread message count for a user across all conversations
 * @param {string} userId - User ID
 * @returns {Promise<number>}
 */
conversationSchema.statics.getTotalUnreadCount = async function(userId) {
  const Message = require('./Message');
  return Message.getUnreadCount(userId);
};

/**
 * Clean up stale conversations (no activity for 90 days)
 * @returns {Promise<number>} Number of conversations archived
 */
conversationSchema.statics.cleanupStaleConversations = async function() {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const result = await this.updateMany(
    {
      status: CONVERSATION_STATUS.ACTIVE,
      lastActivityAt: { $lt: ninetyDaysAgo },
      messageCount: { $gt: 0 }
    },
    { status: CONVERSATION_STATUS.ARCHIVED }
  );
  return result.modifiedCount;
};

// ============================================
// Pre-save Hooks
// ============================================

/**
 * Ensure participantIds array stays in sync with participants
 */
conversationSchema.pre('save', function(next) {
  // Update participantIds from active participants
  this.participantIds = this.participants
    .filter(p => p.isActive === true)
    .map(p => p.userId);
  next();
});

/**
 * Validate that direct conversations have exactly 2 participants
 */
conversationSchema.pre('save', function(next) {
  if (this.type === CONVERSATION_TYPES.DIRECT) {
    const activeParticipants = this.participants.filter(p => p.isActive === true);
    if (activeParticipants.length !== 2) {
      return next(new Error('Direct conversation must have exactly 2 active participants'));
    }
  }
  next();
});

// ============================================
// Exports
// ============================================

module.exports = mongoose.model('Conversation', conversationSchema);
module.exports.CONVERSATION_TYPES = CONVERSATION_TYPES;
module.exports.CONVERSATION_STATUS = CONVERSATION_STATUS;
