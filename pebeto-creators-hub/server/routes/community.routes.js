const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const CommunityPost = require('../models/CommunityPost');
const CommunityComment = require('../models/CommunityComment');
const User = require('../models/User');
const Campaign = require('../models/Campaign');
const { AppError } = require('../utils/errors');
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');

const router = express.Router();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dummy',
  api_key: process.env.CLOUDINARY_API_KEY || 'dummy',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'dummy'
});

const upload = multer({ storage: multer.memoryStorage() });

// ============================================
// POSTS
// ============================================

// GET /api/community/posts - Get all posts
router.get('/posts', optionalAuthenticate, async (req, res, next) => {
  try {
    const { limit = 20, skip = 0 } = req.query;
    const posts = await CommunityPost.find()
      .sort({ createdAt: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl profile.niche');
    
    const userId = req.user?._id;
    const enrichedPosts = posts.map(post => {
      const postObj = post.toObject();
      postObj.isLikedByCurrentUser = userId ? post.likes.includes(userId) : false;
      return postObj;
    });
    
    res.json({ success: true, posts: enrichedPosts });
  } catch (err) {
    next(err);
  }
});

// POST /api/community/posts - Create a new post (upload video/image)
router.post('/posts', authenticate, upload.single('media'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new AppError('No media file uploaded', 400);
    }
    
    const { caption } = req.body;
    const file = req.file;
    
    const mediaType = file.mimetype.startsWith('video/') ? 'video' : 'image';
    
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: mediaType === 'video' ? 'video' : 'image',
          folder: 'pebeto/community',
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
    
    let thumbnailUrl = null;
    if (mediaType === 'video') {
      thumbnailUrl = cloudinary.url(uploadResult.public_id, {
        resource_type: 'video',
        format: 'jpg',
        transformation: [{ start_offset: '2' }, { width: 720, height: 1280, crop: 'limit' }]
      });
    }
    
    const post = await CommunityPost.create({
      authorId: req.user._id,
      mediaUrl: uploadResult.secure_url,
      mediaType,
      thumbnailUrl: thumbnailUrl || uploadResult.secure_url,
      caption: caption || '',
      likes: [],
      likeCount: 0,
      commentCount: 0
    });
    
    const populatedPost = await CommunityPost.findById(post._id).populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl profile.niche');
    
    res.status(201).json({ success: true, post: populatedPost });
  } catch (err) {
    console.error('Upload error:', err);
    next(err);
  }
});

// ============================================
// LIKES (PLATFORM-ONLY - FIXED)
// ============================================

/**
 * POST /api/community/creators/:creatorId/like
 * Toggle like on a creator (platform-only, not sent to TikTok/YouTube)
 */
router.post('/creators/:creatorId/like', authenticate, async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const userId = req.user._id;
    
    const creator = await User.findById(creatorId);
    if (!creator || creator.role !== 'creator') {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    // Initialize arrays if not exists
    if (!creator.likedBy) creator.likedBy = [];
    if (creator.likeCount === undefined) creator.likeCount = 0;
    
    const hasLiked = creator.likedBy.includes(userId);
    
    if (hasLiked) {
      // Unlike
      creator.likedBy = creator.likedBy.filter(id => id.toString() !== userId.toString());
      creator.likeCount = Math.max(0, (creator.likeCount || 0) - 1);
    } else {
      // Like
      creator.likedBy.push(userId);
      creator.likeCount = (creator.likeCount || 0) + 1;
    }
    
    await creator.save();
    
    res.json({
      success: true,
      liked: !hasLiked,
      likeCount: creator.likeCount || 0
    });
  } catch (err) {
    console.error('Error toggling like:', err);
    next(err);
  }
});

/**
 * DELETE /api/community/creators/:creatorId/like
 * Unlike a creator (alternative method)
 */
router.delete('/creators/:creatorId/like', authenticate, async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const userId = req.user._id;
    
    const creator = await User.findById(creatorId);
    if (!creator || creator.role !== 'creator') {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    if (!creator.likedBy) creator.likedBy = [];
    
    const hadLiked = creator.likedBy.includes(userId);
    
    if (hadLiked) {
      creator.likedBy = creator.likedBy.filter(id => id.toString() !== userId.toString());
      creator.likeCount = Math.max(0, (creator.likeCount || 0) - 1);
      await creator.save();
    }
    
    res.json({
      success: true,
      liked: false,
      likeCount: creator.likeCount || 0
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/community/creators/:creatorId/like
 * Check if user liked a creator
 */
router.get('/creators/:creatorId/like', authenticate, async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const userId = req.user._id;
    
    const creator = await User.findById(creatorId).select('likedBy likeCount');
    if (!creator) {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    const isLiked = creator.likedBy ? creator.likedBy.includes(userId) : false;
    
    res.json({
      success: true,
      isLiked,
      likeCount: creator.likeCount || 0
    });
  } catch (err) {
    next(err);
  }
});

// ============================================
// COMMENTS (PLATFORM-ONLY - FIXED)
// ============================================

/**
 * GET /api/community/creators/:creatorId/comments
 * Get comments for a creator (platform-only)
 */
router.get('/creators/:creatorId/comments', optionalAuthenticate, async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const { limit = 50 } = req.query;
    
    const creator = await User.findById(creatorId);
    if (!creator || creator.role !== 'creator') {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    const comments = await CommunityComment.find({ creatorId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl');
    
    res.json({ success: true, comments });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/community/creators/:creatorId/comments
 * Add a comment to a creator (platform-only)
 */
router.post('/creators/:creatorId/comments', authenticate, async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const { text } = req.body;
    
    if (!text || !text.trim()) {
      throw new AppError('Comment text is required', 400);
    }
    
    const creator = await User.findById(creatorId);
    if (!creator || creator.role !== 'creator') {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    const comment = await CommunityComment.create({
      creatorId: creatorId,
      authorId: req.user._id,
      text: text.trim()
    });
    
    const populatedComment = await CommunityComment.findById(comment._id)
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl');
    
    // Update comment count on creator
    const commentCount = await CommunityComment.countDocuments({ creatorId });
    creator.commentCount = commentCount;
    await creator.save();
    
    res.status(201).json({ success: true, comment: populatedComment });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/community/comments/:commentId
 * Delete a comment (platform-only)
 */
router.delete('/comments/:commentId', authenticate, async (req, res, next) => {
  try {
    const { commentId } = req.params;
    const comment = await CommunityComment.findById(commentId);
    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }
    
    if (comment.authorId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'You can only delete your own comments' });
    }
    
    await comment.deleteOne();
    
    // Update comment count
    if (comment.creatorId) {
      const commentCount = await CommunityComment.countDocuments({ creatorId: comment.creatorId });
      await User.findByIdAndUpdate(comment.creatorId, { commentCount });
    }
    
    res.json({ success: true, message: 'Comment deleted' });
  } catch (err) {
    next(err);
  }
});

// ============================================
// CREATOR STATS
// ============================================

/**
 * GET /api/community/creators/:creatorId/stats
 * Get creator engagement stats
 */
router.get('/creators/:creatorId/stats', optionalAuthenticate, async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const userId = req.user?._id;
    
    const creator = await User.findById(creatorId).select('likedBy likeCount commentCount');
    if (!creator) {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    const commentCount = await CommunityComment.countDocuments({ creatorId });
    
    res.json({
      success: true,
      likeCount: creator.likeCount || 0,
      commentCount: commentCount,
      isLiked: userId ? creator.likedBy?.includes(userId) || false : false
    });
  } catch (err) {
    next(err);
  }
});

// ============================================
// REPORTS
// ============================================

router.post('/report', authenticate, [
  body('creatorId').optional().isMongoId().withMessage('Invalid creator ID'),
  body('reason').isIn(['spam', 'inappropriate', 'harassment', 'fake', 'other']).withMessage('Invalid report reason'),
  body('description').optional().isString().trim().isLength({ max: 1000 })
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }
    
    const { creatorId, reason, description } = req.body;
    
    if (!creatorId) {
      return res.status(400).json({ success: false, message: 'Creator ID required' });
    }
    
    const Report = require('../models/Report');
    
    const existingReport = await Report.findOne({
      reporterId: req.user._id,
      reportedUserId: creatorId,
      status: { $in: ['pending', 'reviewing'] }
    });
    
    if (existingReport) {
      return res.status(400).json({ success: false, message: 'You have already reported this creator' });
    }
    
    const reportedUser = await User.findById(creatorId);
    if (!reportedUser) {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    const report = await Report.create({
      reporterId: req.user._id,
      reportedUserId: creatorId,
      reason,
      description: description || null,
      status: 'pending'
    });
    
    logger.info(`Report created by user ${req.user._id} for creator ${creatorId}`);
    
    res.status(201).json({
      success: true,
      message: 'Report submitted. Our team will review it.',
      data: { reportId: report._id }
    });
  } catch (err) {
    next(err);
  }
});

// ============================================
// BID CAMPAIGNS (For Bid Tab)
// ============================================

/**
 * GET /api/community/bids
 * Get campaigns that are open for bidding (unbidded by current user)
 */
router.get('/bids', authenticate, async (req, res, next) => {
  try {
    const campaigns = await Campaign.find({ 
      status: 'open',
      assignedCreatorId: { $exists: false }
    })
    .populate('businessId', 'email profile.companyName')
    .sort({ createdAt: -1 });
    
    // Filter out campaigns where user has already bid
    const userId = req.user._id;
    const unbiddedCampaigns = campaigns.filter(c => {
      const userBid = c.bids?.find(b => b.creatorId && b.creatorId.toString() === userId.toString());
      return !userBid;
    });
    
    res.json({
      success: true,
      data: unbiddedCampaigns
    });
  } catch (err) {
    next(err);
  }
});

// ============================================
// EXPORTS
// ============================================

module.exports = router;
