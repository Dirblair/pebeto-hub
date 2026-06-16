/**
 * Socket.IO Configuration for Pebeto Creator's Hub
 * 
 * Handles real-time features including:
 * - Authentication middleware
 * - User presence (online/offline)
 * - Direct messaging (fully implemented)
 * - Campaign notifications
 * - Platform activity broadcasts
 * - Live feed updates
 * 
 * @module sockets/index
 */

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const User = require('../models/User');
const Campaign = require('../models/Campaign');
const Transaction = require('../models/Transaction');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const logger = require('../utils/logger');

// ============================================
// Constants
// ============================================

const ROOMS = {
  GLOBAL_STATUS: 'status:global',
  GLOBAL_FEED: 'feed:global',
  PLATFORM_ACTIVITY: 'platform:activity',
};

// ============================================
// Socket.IO Authentication Middleware
// ============================================

/**
 * Authenticate socket connections using JWT
 * @param {Object} socket - Socket.IO socket
 * @param {Function} next - Next middleware function
 */
async function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
    
    if (!token) {
      logger.warn('Socket connection rejected: No token provided');
      return next(new Error('Authentication required'));
    }
    
    const decoded = jwt.verify(token, env.jwtSecret);
    const user = await User.findById(decoded.userId)
      .select('_id email role uniqueCode profile.stageName profile.companyName status');
    
    if (!user) {
      logger.warn('Socket connection rejected: User not found', { userId: decoded.userId });
      return next(new Error('Invalid user'));
    }
    
    if (user.status !== 'active') {
      logger.warn('Socket connection rejected: Inactive user', { userId: user._id, status: user.status });
      return next(new Error('Account is not active'));
    }
    
    // Attach user to socket
    socket.user = user;
    socket.userId = user._id.toString();
    
    logger.debug('Socket authenticated', { userId: user._id, role: user.role });
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      logger.warn('Socket connection rejected: Invalid token');
      return next(new Error('Invalid token'));
    }
    if (error.name === 'TokenExpiredError') {
      logger.warn('Socket connection rejected: Expired token');
      return next(new Error('Token expired'));
    }
    logger.error('Socket authentication error:', error);
    next(new Error('Authentication failed'));
  }
}

// ============================================
// Room Management Helpers
// ============================================

/**
 * Join user to their personal room
 * @param {Object} socket - Socket.IO socket
 */
function joinPersonalRoom(socket) {
  const personalRoom = `user:${socket.userId}`;
  socket.join(personalRoom);
  logger.debug(`User ${socket.userId} joined personal room: ${personalRoom}`);
}

/**
 * Join user to global rooms
 * @param {Object} socket - Socket.IO socket
 */
function joinGlobalRooms(socket) {
  socket.join(ROOMS.GLOBAL_STATUS);
  socket.join(ROOMS.GLOBAL_FEED);
  socket.join(ROOMS.PLATFORM_ACTIVITY);
  logger.debug(`User ${socket.userId} joined global rooms`);
}

/**
 * Leave all rooms on disconnect
 * @param {Object} socket - Socket.IO socket
 */
function leaveAllRooms(socket) {
  const rooms = [...socket.rooms];
  rooms.forEach(room => {
    if (room !== socket.id) {
      socket.leave(room);
    }
  });
  logger.debug(`User ${socket.userId} left all rooms`);
}

// ============================================
// Event Handlers
// ============================================

/**
 * Handle user presence (online)
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 */
function handlePresenceOnline(socket, io) {
  const presenceData = {
    userId: socket.userId,
    uniqueCode: socket.user.uniqueCode,
    displayName: socket.user.profile?.stageName || socket.user.profile?.companyName || socket.user.email,
    timestamp: new Date().toISOString(),
  };
  
  socket.broadcast.emit('presence:online', presenceData);
  logger.debug(`User ${socket.userId} came online`);
}

/**
 * Handle user presence (offline)
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 */
function handlePresenceOffline(socket, io) {
  const presenceData = {
    userId: socket.userId,
    uniqueCode: socket.user.uniqueCode,
    timestamp: new Date().toISOString(),
  };
  
  socket.broadcast.emit('presence:offline', presenceData);
  logger.debug(`User ${socket.userId} went offline`);
}

/**
 * Handle status subscription
 * @param {Object} socket - Socket.IO socket
 */
function handleStatusSubscribe(socket) {
  socket.join(ROOMS.GLOBAL_STATUS);
  logger.debug(`User ${socket.userId} subscribed to global status`);
  socket.emit('status:subscribed', { message: 'Subscribed to platform updates' });
}

/**
 * Handle direct message typing indicator
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 * @param {Object} payload - Typing event payload
 */
function handleDirectMessageTyping(socket, io, payload) {
  const { conversationId, recipientId, isTyping = true } = payload || {};
  
  if (conversationId) {
    socket.to(`conversation:${conversationId}`).emit('dm:typing', {
      userId: socket.userId,
      uniqueCode: socket.user.uniqueCode,
      displayName: socket.user.profile?.stageName || socket.user.profile?.companyName,
      isTyping,
      timestamp: new Date().toISOString(),
    });
  } else if (recipientId) {
    socket.to(`user:${recipientId}`).emit('dm:typing', {
      userId: socket.userId,
      uniqueCode: socket.user.uniqueCode,
      displayName: socket.user.profile?.stageName || socket.user.profile?.companyName,
      isTyping,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Handle direct message stop typing
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 * @param {Object} payload - Stop typing payload
 */
function handleDirectMessageStopTyping(socket, io, payload) {
  const { conversationId, recipientId } = payload || {};
  
  if (conversationId) {
    socket.to(`conversation:${conversationId}`).emit('dm:typing', {
      userId: socket.userId,
      uniqueCode: socket.user.uniqueCode,
      isTyping: false,
      timestamp: new Date().toISOString(),
    });
  } else if (recipientId) {
    socket.to(`user:${recipientId}`).emit('dm:typing', {
      userId: socket.userId,
      uniqueCode: socket.user.uniqueCode,
      isTyping: false,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Handle join conversation room
 * @param {Object} socket - Socket.IO socket
 * @param {Object} payload - Conversation data
 */
function handleJoinConversation(socket, payload) {
  const { conversationId } = payload;
  if (conversationId) {
    // Leave previous conversation rooms if any
    if (socket.currentConversation) {
      socket.leave(`conversation:${socket.currentConversation}`);
    }
    socket.join(`conversation:${conversationId}`);
    socket.currentConversation = conversationId;
    socket.emit('conversation:joined', { conversationId, success: true });
    logger.debug(`User ${socket.userId} joined conversation ${conversationId}`);
  }
}

/**
 * Handle leave conversation room
 * @param {Object} socket - Socket.IO socket
 * @param {Object} payload - Conversation data
 */
function handleLeaveConversation(socket, payload) {
  const { conversationId } = payload;
  if (conversationId) {
    socket.leave(`conversation:${conversationId}`);
    if (socket.currentConversation === conversationId) {
      socket.currentConversation = null;
    }
    socket.emit('conversation:left', { conversationId, success: true });
    logger.debug(`User ${socket.userId} left conversation ${conversationId}`);
  }
}

/**
 * Handle send direct message
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 * @param {Object} payload - Message payload
 */
async function handleSendDirectMessage(socket, io, payload) {
  const { recipientId, message, messageType = 'text', clientMessageId } = payload;
  
  if (!message || !message.trim()) {
    socket.emit('dm:error', { error: 'Message cannot be empty' });
    return;
  }
  
  if (!recipientId) {
    socket.emit('dm:error', { error: 'Recipient ID required' });
    return;
  }
  
  try {
    // Check for duplicate message
    if (clientMessageId) {
      const existing = await Message.findByClientMessageId(clientMessageId);
      if (existing) {
        socket.emit('dm:message-sent', {
          messageId: existing._id,
          clientMessageId,
          isDuplicate: true
        });
        return;
      }
    }
    
    // Get or create conversation
    const { conversation, isNew } = await Conversation.getOrCreateDirectConversation(
      socket.userId,
      recipientId
    );
    
    // Get sender info for display
    const senderName = socket.user.profile?.stageName || 
                       socket.user.profile?.companyName || 
                       socket.user.uniqueCode || 
                       socket.user.email.split('@')[0];
    
    // Create message in database
    const newMessage = await Message.createMessage({
      conversationId: conversation._id,
      senderId: socket.userId,
      recipientId,
      content: message.trim(),
      type: messageType,
      clientMessageId,
      ipAddress: socket.handshake.address,
      userAgent: socket.handshake.headers['user-agent']
    });
    
    // Update conversation last message
    await conversation.updateLastMessage({
      content: message.trim().substring(0, 200),
      senderId: socket.userId,
      senderName,
      type: messageType
    });
    
    // Increment unread count for recipient
    await conversation.incrementUnreadCount(socket.userId);
    
    // Get updated unread count for recipient
    const recipientUnreadCount = await Conversation.getTotalUnreadCount(recipientId);
    
    // Prepare message data for emission
    const messageData = {
      id: newMessage._id,
      conversationId: conversation._id,
      content: newMessage.content,
      senderId: socket.userId,
      senderName,
      type: newMessage.type,
      status: newMessage.status,
      createdAt: newMessage.createdAt,
      clientMessageId
    };
    
    // Emit to recipient's personal room
    io.to(`user:${recipientId}`).emit('dm:new-message', messageData);
    
    // Emit to conversation room
    io.to(`conversation:${conversation._id}`).emit('dm:message', messageData);
    
    // Acknowledge to sender
    socket.emit('dm:message-sent', {
      messageId: newMessage._id,
      conversationId: conversation._id,
      clientMessageId,
      status: 'sent'
    });
    
    // Send unread count update to recipient
    io.to(`user:${recipientId}`).emit('dm:unread-update', { 
      count: recipientUnreadCount,
      conversationId: conversation._id
    });
    
    logger.debug(`DM sent from ${socket.userId} to ${recipientId}`);
    
  } catch (error) {
    logger.error('Error sending direct message:', error);
    socket.emit('dm:error', { error: error.message || 'Failed to send message' });
  }
}

/**
 * Handle mark messages as read
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 * @param {Object} payload - Read receipt payload
 */
async function handleMarkRead(socket, io, payload) {
  const { conversationId } = payload;
  
  if (!conversationId) {
    socket.emit('dm:error', { error: 'Conversation ID required' });
    return;
  }
  
  try {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation || !conversation.isParticipant(socket.userId)) {
      socket.emit('dm:error', { error: 'Conversation not found' });
      return;
    }
    
    // Mark all messages in conversation as read
    await Message.markConversationRead(conversationId, socket.userId);
    await conversation.markRead(socket.userId);
    
    // Get other participant
    const otherParticipantId = conversation.participantIds.find(
      id => id.toString() !== socket.userId
    );
    
    // Notify the other participant that messages were read
    if (otherParticipantId) {
      io.to(`user:${otherParticipantId}`).emit('dm:read-receipt', {
        conversationId,
        readBy: socket.userId,
        readAt: new Date()
      });
    }
    
    // Get updated unread count for user
    const unreadCount = await Conversation.getTotalUnreadCount(socket.userId);
    socket.emit('dm:unread-update', { count: unreadCount });
    
  } catch (error) {
    logger.error('Error marking messages as read:', error);
    socket.emit('dm:error', { error: 'Failed to mark as read' });
  }
}

/**
 * Handle message recall
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 * @param {Object} payload - Recall payload
 */
async function handleRecallMessage(socket, io, payload) {
  const { messageId, reason } = payload;
  
  if (!messageId) {
    socket.emit('dm:error', { error: 'Message ID required' });
    return;
  }
  
  try {
    const message = await Message.findById(messageId);
    if (!message) {
      socket.emit('dm:error', { error: 'Message not found' });
      return;
    }
    
    // Only sender can recall
    if (message.senderId.toString() !== socket.userId) {
      socket.emit('dm:error', { error: 'You can only recall your own messages' });
      return;
    }
    
    await message.recall(reason);
    
    // Notify both participants
    io.to(`conversation:${message.conversationId}`).emit('dm:message-recalled', {
      messageId,
      conversationId: message.conversationId,
      recalledAt: message.recalledAt,
      reason
    });
    
    socket.emit('dm:recall-success', { messageId });
    
  } catch (error) {
    logger.error('Error recalling message:', error);
    socket.emit('dm:error', { error: error.message || 'Failed to recall message' });
  }
}

/**
 * Handle new post creation (Community feed)
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 * @param {Object} data - Post data
 */
function handleCreatePost(socket, io, data) {
  const { videoUrl, caption, mediaType, thumbnailUrl } = data;
  
  const postData = {
    id: `post_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    videoUrl,
    caption: caption || '',
    mediaType: mediaType || 'video',
    thumbnailUrl: thumbnailUrl || null,
    author: {
      id: socket.userId,
      uniqueCode: socket.user.uniqueCode,
      displayName: socket.user.profile?.stageName || socket.user.profile?.companyName || socket.user.email,
      role: socket.user.role,
      avatar: socket.user.profile?.avatarUrl,
    },
    likes: 0,
    comments: [],
    createdAt: new Date().toISOString(),
  };
  
  // Broadcast to all users in global feed room
  io.to(ROOMS.GLOBAL_FEED).emit('feed:new-post', postData);
  
  logger.info(`New post created by user ${socket.userId}`);
}

/**
 * Handle post like
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 * @param {Object} data - Like data
 */
function handlePostLike(socket, io, data) {
  const { postId, liked } = data;
  
  io.to(ROOMS.GLOBAL_FEED).emit('feed:post-liked', {
    postId,
    userId: socket.userId,
    liked,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Handle post comment
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 * @param {Object} data - Comment data
 */
function handlePostComment(socket, io, data) {
  const { postId, comment } = data;
  
  io.to(ROOMS.GLOBAL_FEED).emit('feed:new-comment', {
    postId,
    comment: {
      id: `comment_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      text: comment,
      author: {
        id: socket.userId,
        uniqueCode: socket.user.uniqueCode,
        displayName: socket.user.profile?.stageName || socket.user.profile?.companyName,
      },
      createdAt: new Date().toISOString(),
    },
  });
}

/**
 * Handle campaign updates
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 * @param {Object} data - Campaign update data
 */
function handleCampaignUpdate(socket, io, data) {
  const { campaignId, type, campaign } = data;
  
  // Notify the business that owns the campaign
  if (campaign?.businessId) {
    io.to(`user:${campaign.businessId}`).emit('campaign:updated', {
      campaignId,
      type,
      campaign,
      timestamp: new Date().toISOString(),
    });
  }
  
  // Notify the assigned creator
  if (campaign?.assignedCreatorId) {
    io.to(`user:${campaign.assignedCreatorId}`).emit('campaign:updated', {
      campaignId,
      type,
      campaign,
      timestamp: new Date().toISOString(),
    });
  }
  
  // Broadcast to platform activity room
  io.to(ROOMS.PLATFORM_ACTIVITY).emit('platform:activity', {
    type: 'campaign_update',
    campaignId,
    updateType: type,
    userId: socket.userId,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Handle platform activity broadcast
 * @param {Object} socket - Socket.IO socket
 * @param {Object} io - Socket.IO server
 * @param {Object} payload - Activity payload
 */
function handlePlatformActivity(socket, io, payload) {
  // Only admin can broadcast platform activities
  if (socket.user.role === 'admin') {
    io.to(ROOMS.PLATFORM_ACTIVITY).emit('platform:activity', {
      ...payload,
      timestamp: new Date().toISOString(),
      source: 'admin',
    });
    logger.info(`Admin ${socket.userId} broadcast platform activity`);
  } else {
    logger.warn(`Non-admin user ${socket.userId} attempted to broadcast platform activity`);
  }
}

// ============================================
// Main Socket.IO Initialization
// ============================================

/**
 * Initialize Socket.IO server
 * @param {Object} io - Socket.IO server instance
 */
function initSockets(io) {
  // Apply authentication middleware
  io.use(authenticateSocket);
  
  io.on('connection', (socket) => {
    const userId = socket.userId;
    
    logger.info(`Socket connected: ${socket.id} for user ${userId}`);
    
    // Join personal and global rooms
    joinPersonalRoom(socket);
    joinGlobalRooms(socket);
    
    // Broadcast presence online
    handlePresenceOnline(socket, io);
    
    // Send initial unread count
    (async () => {
      try {
        const unreadCount = await Conversation.getTotalUnreadCount(userId);
        socket.emit('dm:unread-update', { count: unreadCount });
      } catch (error) {
        logger.error('Error sending initial unread count:', error);
      }
    })();
    
    // ========================================
    // Event Handlers
    // ========================================
    
    // Status subscription
    socket.on('status:subscribe', () => handleStatusSubscribe(socket));
    
    // Direct messaging
    socket.on('dm:typing', (payload) => handleDirectMessageTyping(socket, io, payload));
    socket.on('dm:stop-typing', (payload) => handleDirectMessageStopTyping(socket, io, payload));
    socket.on('dm:send', (payload) => handleSendDirectMessage(socket, io, payload));
    socket.on('dm:mark-read', (payload) => handleMarkRead(socket, io, payload));
    socket.on('dm:recall', (payload) => handleRecallMessage(socket, io, payload));
    socket.on('conversation:join', (payload) => handleJoinConversation(socket, payload));
    socket.on('conversation:leave', (payload) => handleLeaveConversation(socket, payload));
    
    // Feed posts
    socket.on('create-post', (data) => handleCreatePost(socket, io, data));
    socket.on('post:like', (data) => handlePostLike(socket, io, data));
    socket.on('post:comment', (data) => handlePostComment(socket, io, data));
    
    // Campaign updates
    socket.on('campaign:update', (data) => handleCampaignUpdate(socket, io, data));
    
    // Platform activity (admin only)
    socket.on('platform:activity', (payload) => handlePlatformActivity(socket, io, payload));
    
    // Disconnect
    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id} for user ${userId}`);
      handlePresenceOffline(socket, io);
      leaveAllRooms(socket);
    });
    
    // Error handling
    socket.on('error', (error) => {
      logger.error(`Socket error for user ${userId}:`, error);
    });
  });
  
  logger.info('Socket.IO server initialized');
}

/**
 * Broadcast platform activity to all connected clients
 * @param {Object} io - Socket.IO server instance
 * @param {Object} payload - Activity payload
 */
function broadcastPlatformActivity(io, payload) {
  if (io) {
    io.to(ROOMS.PLATFORM_ACTIVITY).emit('platform:activity', {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Send notification to specific user
 * @param {Object} io - Socket.IO server instance
 * @param {string} userId - User ID
 * @param {Object} notification - Notification data
 */
function sendNotificationToUser(io, userId, notification) {
  if (io) {
    io.to(`user:${userId}`).emit('notification', {
      ...notification,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Send campaign update to relevant users
 * @param {Object} io - Socket.IO server instance
 * @param {string} campaignId - Campaign ID
 * @param {Object} update - Update data
 */
function sendCampaignUpdate(io, campaignId, update) {
  if (io) {
    io.to(ROOMS.PLATFORM_ACTIVITY).emit('campaign:update', {
      campaignId,
      ...update,
      timestamp: new Date().toISOString(),
    });
  }
}

// ============================================
// Exports
// ============================================

module.exports = {
  initSockets,
  broadcastPlatformActivity,
  sendNotificationToUser,
  sendCampaignUpdate,
  ROOMS,
};
