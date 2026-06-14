/**
 * Messages Routes for Pebeto Creator's Hub
 * 
 * Handles direct messaging between users:
 * - Send direct messages
 * - Get conversations
 * - Get conversation messages
 * - Mark messages as read
 * - Delete/recall messages
 * - Get unread counts
 * 
 * @module routes/messages
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { catchAsync } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const User = require('../models/User');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const { MESSAGE_TYPES, MESSAGE_STATUS } = require('../models/Message');
const { CONVERSATION_TYPES, CONVERSATION_STATUS } = require('../models/Conversation');

const router = express.Router();

// ============================================
// Validation Rules
// ============================================

const validateSendMessage = [
  body('recipientId').isMongoId().withMessage('Valid recipient ID required'),
  body('content').notEmpty().withMessage('Message content is required').isLength({ max: 5000 }).withMessage('Message too long'),
  body('clientMessageId').optional().isString().withMessage('Invalid client message ID')
];

const validateGetConversations = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('archived').optional().isBoolean().toBoolean()
];

const validateGetMessages = [
  param('conversationId').isMongoId().withMessage('Invalid conversation ID'),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('before').optional().isISO8601(),
  query('after').optional().isISO8601()
];

const validateMarkRead = [
  param('conversationId').isMongoId().withMessage('Invalid conversation ID')
];

const validateRecallMessage = [
  param('messageId').isMongoId().withMessage('Invalid message ID'),
  body('reason').optional().isString().isLength({ max: 200 })
];

const validateDeleteMessage = [
  param('messageId').isMongoId().withMessage('Invalid message ID')
];

const validateArchiveConversation = [
  param('conversationId').isMongoId().withMessage('Invalid conversation ID')
];

// ============================================
// Routes
// ============================================

/**
 * POST /api/messages/send
 * Send a direct message to another user
 */
router.post('/send', authenticate, validateSendMessage, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { recipientId, content, clientMessageId } = req.body;
  const senderId = req.user._id;
  
  // Don't allow sending to self
  if (senderId.toString() === recipientId.toString()) {
    throw new AppError('You cannot send a message to yourself', 400);
  }
  
  // Check if recipient exists
  const recipient = await User.findById(recipientId);
  if (!recipient) {
    throw new AppError('Recipient not found', 404);
  }
  
  // Check for duplicate message (idempotency)
  if (clientMessageId) {
    const existing = await Message.findByClientMessageId(clientMessageId);
    if (existing) {
      return res.json({
        success: true,
        data: {
          message: existing,
          isDuplicate: true,
          message: 'Message already sent'
        }
      });
    }
  }
  
  // Get or create conversation
  const { conversation, isNew } = await Conversation.getOrCreateDirectConversation(senderId, recipientId);
  
  // Create the message
  const message = await Message.createMessage({
    conversationId: conversation._id,
    senderId,
    recipientId,
    content,
    clientMessageId,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  });
  
  // Update conversation last message and increment unread count for recipient
  const sender = await User.findById(senderId).select('uniqueCode profile.stageName profile.companyName');
  const senderName = sender.profile?.stageName || sender.profile?.companyName || sender.uniqueCode || sender.email.split('@')[0];
  
  await conversation.updateLastMessage({
    content: content.substring(0, 200),
    senderId,
    senderName,
    type: MESSAGE_TYPES.TEXT
  });
  
  // Increment unread count for recipient only (not for sender)
  await conversation.incrementUnreadCount(senderId);
  
  // Emit real-time message via Socket.IO
  const io = req.app.get('io');
  if (io) {
    io.to(`user:${recipientId}`).emit('dm:new-message', {
      conversationId: conversation._id,
      message: {
        id: message._id,
        content: message.content,
        senderId,
        senderName,
        createdAt: message.createdAt
      }
    });
    
    // Send unread count update
    const unreadCount = await Message.getUnreadCount(recipientId);
    io.to(`user:${recipientId}`).emit('dm:unread-update', { count: unreadCount });
  }
  
  logger.info(`Message sent from ${senderId} to ${recipientId}`);
  
  res.status(201).json({
    success: true,
    data: {
      message,
      conversationId: conversation._id,
      isNewConversation: isNew
    }
  });
}));

/**
 * GET /api/messages/conversations
 * Get all conversations for the authenticated user
 */
router.get('/conversations', authenticate, validateGetConversations, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const archived = req.query.archived === 'true';
  
  const skip = (page - 1) * limit;
  
  const result = await Conversation.getUserConversations(req.user._id, {
    limit,
    skip,
    archived
  });
  
  // Get total unread count for user
  const totalUnread = await Conversation.getTotalUnreadCount(req.user._id);
  
  res.json({
    success: true,
    data: {
      conversations: result.conversations,
      totalUnread,
      pagination: result.pagination
    }
  });
}));

/**
 * GET /api/messages/conversations/:conversationId/messages
 * Get messages for a specific conversation
 */
router.get('/conversations/:conversationId/messages', authenticate, validateGetMessages, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { conversationId } = req.params;
  const { before, after, limit = 50 } = req.query;
  
  // Verify user is participant in this conversation
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    throw new AppError('Conversation not found', 404);
  }
  
  if (!conversation.isParticipant(req.user._id)) {
    throw new AppError('You are not a participant in this conversation', 403);
  }
  
  // Mark conversation as read for this user
  await Message.markConversationRead(conversationId, req.user._id);
  await conversation.markRead(req.user._id);
  
  // Update last seen timestamp
  await conversation.updateLastSeen(req.user._id);
  
  // Get messages
  const result = await Message.getConversationMessages(conversationId, req.user._id, {
    limit: parseInt(limit),
    before,
    after
  });
  
  // Get other participant info
  const otherParticipantId = conversation.participantIds.find(
    id => id.toString() !== req.user._id.toString()
  );
  
  let otherParticipant = null;
  if (otherParticipantId) {
    otherParticipant = await User.findById(otherParticipantId).select('_id email uniqueCode role profile.stageName profile.companyName profile.avatarUrl');
  }
  
  // Emit read receipts via socket
  const io = req.app.get('io');
  if (io && result.messages.length > 0) {
    io.to(`user:${otherParticipantId}`).emit('dm:messages-read', {
      conversationId,
      readBy: req.user._id,
      readAt: new Date()
    });
  }
  
  res.json({
    success: true,
    data: {
      conversation: {
        id: conversation._id,
        type: conversation.type,
        title: conversation.title,
        otherParticipant,
        lastMessage: conversation.lastMessage,
        isArchived: conversation.getParticipant(req.user._id)?.isArchived || false,
        isMuted: conversation.getParticipant(req.user._id)?.isMuted || false
      },
      messages: result.messages,
      hasMore: result.hasMore,
      count: result.count
    }
  });
}));

/**
 * PUT /api/messages/conversations/:conversationId/read
 * Mark all messages in a conversation as read
 */
router.put('/conversations/:conversationId/read', authenticate, validateMarkRead, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { conversationId } = req.params;
  
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    throw new AppError('Conversation not found', 404);
  }
  
  if (!conversation.isParticipant(req.user._id)) {
    throw new AppError('You are not a participant in this conversation', 403);
  }
  
  await Message.markConversationRead(conversationId, req.user._id);
  await conversation.markRead(req.user._id);
  
  // Get updated unread count
  const totalUnread = await Conversation.getTotalUnreadCount(req.user._id);
  
  // Emit unread update via socket
  const io = req.app.get('io');
  if (io) {
    io.to(`user:${req.user._id}`).emit('dm:unread-update', { count: totalUnread });
  }
  
  res.json({
    success: true,
    message: 'Conversation marked as read',
    data: { totalUnread }
  });
}));

/**
 * PUT /api/messages/conversations/:conversationId/archive
 * Archive conversation for the user
 */
router.put('/conversations/:conversationId/archive', authenticate, validateArchiveConversation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { conversationId } = req.params;
  
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    throw new AppError('Conversation not found', 404);
  }
  
  if (!conversation.isParticipant(req.user._id)) {
    throw new AppError('You are not a participant in this conversation', 403);
  }
  
  await conversation.archiveForUser(req.user._id);
  
  res.json({
    success: true,
    message: 'Conversation archived'
  });
}));

/**
 * PUT /api/messages/conversations/:conversationId/unarchive
 * Unarchive conversation for the user
 */
router.put('/conversations/:conversationId/unarchive', authenticate, validateArchiveConversation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { conversationId } = req.params;
  
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    throw new AppError('Conversation not found', 404);
  }
  
  if (!conversation.isParticipant(req.user._id)) {
    throw new AppError('You are not a participant in this conversation', 403);
  }
  
  await conversation.unarchiveForUser(req.user._id);
  
  res.json({
    success: true,
    message: 'Conversation unarchived'
  });
}));

/**
 * PUT /api/messages/conversations/:conversationId/mute
 * Mute conversation notifications for the user
 */
router.put('/conversations/:conversationId/mute', authenticate, validateArchiveConversation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { conversationId } = req.params;
  
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    throw new AppError('Conversation not found', 404);
  }
  
  if (!conversation.isParticipant(req.user._id)) {
    throw new AppError('You are not a participant in this conversation', 403);
  }
  
  await conversation.muteForUser(req.user._id);
  
  res.json({
    success: true,
    message: 'Conversation muted'
  });
}));

/**
 * PUT /api/messages/conversations/:conversationId/unmute
 * Unmute conversation notifications for the user
 */
router.put('/conversations/:conversationId/unmute', authenticate, validateArchiveConversation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { conversationId } = req.params;
  
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    throw new AppError('Conversation not found', 404);
  }
  
  if (!conversation.isParticipant(req.user._id)) {
    throw new AppError('You are not a participant in this conversation', 403);
  }
  
  await conversation.unmuteForUser(req.user._id);
  
  res.json({
    success: true,
    message: 'Conversation unmuted'
  });
}));

/**
 * PUT /api/messages/:messageId/recall
 * Recall a message (sender only, within 5 minutes)
 */
router.put('/messages/:messageId/recall', authenticate, validateRecallMessage, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { messageId } = req.params;
  const { reason } = req.body;
  
  const message = await Message.findById(messageId);
  if (!message) {
    throw new AppError('Message not found', 404);
  }
  
  // Only sender can recall
  if (message.senderId.toString() !== req.user._id.toString()) {
    throw new AppError('You can only recall your own messages', 403);
  }
  
  await message.recall(reason);
  
  // Notify recipient via socket
  const io = req.app.get('io');
  if (io) {
    io.to(`user:${message.recipientId}`).emit('dm:message-recalled', {
      messageId,
      conversationId: message.conversationId,
      recalledAt: message.recalledAt,
      reason
    });
  }
  
  logger.info(`Message ${messageId} recalled by user ${req.user._id}`);
  
  res.json({
    success: true,
    message: 'Message recalled successfully'
  });
}));

/**
 * DELETE /api/messages/:messageId
 * Delete a message (soft delete for user)
 */
router.delete('/messages/:messageId', authenticate, validateDeleteMessage, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { messageId } = req.params;
  
  const message = await Message.findById(messageId);
  if (!message) {
    throw new AppError('Message not found', 404);
  }
  
  // Only sender or recipient can delete
  if (message.senderId.toString() !== req.user._id.toString() && 
      message.recipientId.toString() !== req.user._id.toString()) {
    throw new AppError('You cannot delete this message', 403);
  }
  
  await message.deleteForUser(req.user._id);
  
  res.json({
    success: true,
    message: 'Message deleted'
  });
}));

/**
 * GET /api/messages/unread/count
 * Get total unread message count for the user
 */
router.get('/unread/count', authenticate, catchAsync(async (req, res) => {
  const unreadCount = await Conversation.getTotalUnreadCount(req.user._id);
  
  res.json({
    success: true,
    data: { count: unreadCount }
  });
}));

/**
 * GET /api/messages/search
 * Search messages by content
 */
router.get('/search', authenticate, catchAsync(async (req, res) => {
  const { q, limit = 20 } = req.query;
  
  if (!q || q.length < 2) {
    return res.json({
      success: true,
      data: { messages: [], hasMore: false }
    });
  }
  
  // Find all conversations user is in
  const conversations = await Conversation.find({
    participantIds: req.user._id,
    status: { $ne: CONVERSATION_STATUS.DELETED }
  }).select('_id');
  
  const conversationIds = conversations.map(c => c._id);
  
  // Search messages in those conversations
  const messages = await Message.find({
    conversationId: { $in: conversationIds },
    content: { $regex: q, $options: 'i' },
    deletedBy: { $ne: req.user._id },
    status: { $ne: MESSAGE_STATUS.RECALLED }
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(parseInt(limit), 100))
    .populate('senderId', 'email uniqueCode profile.stageName profile.companyName profile.avatarUrl');
  
  res.json({
    success: true,
    data: {
      messages,
      count: messages.length,
      searchTerm: q
    }
  });
}));

module.exports = router;
