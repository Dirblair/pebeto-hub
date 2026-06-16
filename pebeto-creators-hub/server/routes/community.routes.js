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

// Configure Cloudinary (add to env.js)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure multer for memory storage
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
    
    // Determine media type
    const mediaType = file.mimetype.startsWith('video/') ? 'video' : 'image';
    
    // Upload to Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: mediaType === 'video' ? 'video' : 'image',
          folder: 'pebeto/community',
          transformation: mediaType === 'video' ? [{ width: 720, height: 1280, crop: 'limit' }] : []
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
    
    // Create thumbnail for video
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

// POST /api/community/posts/:postId/like - Toggle like on a post
router.post('/posts/:postId/like', authenticate, async (req, res, next) => {
  try {
    const { postId } = req.params;
    const userId = req.user._id;
    
    const post = await CommunityPost.findById(postId);
    if (!post) throw new AppError('Post not found', 404);
    
    const hasLiked = post.likes.includes(userId);
    
    if (hasLiked) {
      post.likes = post.likes.filter(id => id.toString() !== userId.toString());
      post.likeCount = Math.max(0, post.likeCount - 1);
    } else {
      post.likes.push(userId);
      post.likeCount += 1;
    }
    
    await post.save();
    
    res.json({ success: true, liked: !hasLiked, likeCount: post.likeCount });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/community/posts/:postId - Delete a post (owner or admin only)
router.delete('/posts/:postId', authenticate, async (req, res, next) => {
  try {
    const { postId } = req.params;
    const post = await CommunityPost.findById(postId);
    if (!post) throw new AppError('Post not found', 404);
    
    if (post.authorId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      throw new AppError('You can only delete your own posts', 403);
    }
    
    await CommunityComment.deleteMany({ postId });
    await post.deleteOne();
    
    res.json({ success: true, message: 'Post deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/community/posts/:postId/save - Save post to user's saved list
router.post('/posts/:postId/save', authenticate, async (req, res, next) => {
  try {
    const { postId } = req.params;
    const user = await User.findById(req.user._id);
    if (!user) throw new AppError('User not found', 404);
    
    if (!user.metadata) user.metadata = {};
    if (!user.metadata.savedPosts) user.metadata.savedPosts = [];
    
    const alreadySaved = user.metadata.savedPosts.includes(postId);
    
    if (alreadySaved) {
      user.metadata.savedPosts = user.metadata.savedPosts.filter(id => id.toString() !== postId);
    } else {
      user.metadata.savedPosts.push(postId);
    }
    
    await user.save();
    
    res.json({ success: true, saved: !alreadySaved });
  } catch (err) {
    next(err);
  }
});

// ============================================
// COMMENTS (for Posts)
// ============================================

// GET /api/community/posts/:postId/comments - Get comments for a post
router.get('/posts/:postId/comments', optionalAuthenticate, async (req, res, next) => {
  try {
    const { postId } = req.params;
    const { limit = 50 } = req.query;
    
    const comments = await CommunityComment.find({ postId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl');
    
    res.json({ success: true, comments });
  } catch (err) {
    next(err);
  }
});

// POST /api/community/posts/:postId/comments - Add a comment
router.post('/posts/:postId/comments', authenticate, async (req, res, next) => {
  try {
    const { postId } = req.params;
    const { text } = req.body;
    
    if (!text || !text.trim()) throw new AppError('Comment text is required', 400);
    
    const post = await CommunityPost.findById(postId);
    if (!post) throw new AppError('Post not found', 404);
    
    const comment = await CommunityComment.create({
      postId,
      authorId: req.user._id,
      text: text.trim()
    });
    
    post.commentCount += 1;
    await post.save();
    
    const populatedComment = await CommunityComment.findById(comment._id).populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl');
    
    res.status(201).json({ success: true, comment: populatedComment });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/community/comments/:commentId - Delete a comment
router.delete('/comments/:commentId', authenticate, async (req, res, next) => {
  try {
    const { commentId } = req.params;
    const comment = await CommunityComment.findById(commentId);
    if (!comment) throw new AppError('Comment not found', 404);
    
    const post = await CommunityPost.findById(comment.postId);
    
    if (comment.authorId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      throw new AppError('You can only delete your own comments', 403);
    }
    
    await comment.deleteOne();
    
    if (post) {
      post.commentCount = Math.max(0, post.commentCount - 1);
      await post.save();
    }
    
    res.json({ success: true, message: 'Comment deleted' });
  } catch (err) {
    next(err);
  }
});

// ============================================
// CREATOR COMMENTS & LIKES (Direct Creator Engagement)
// ============================================

// GET /api/community/creators/:creatorId/comments - Get comments for a creator
router.get('/creators/:creatorId/comments', optionalAuthenticate, async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const { limit = 50 } = req.query;
    
    // Check if creator exists
    const creator = await User.findById(creatorId);
    if (!creator || creator.role !== 'creator') {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    // Find comments for this creator
    const comments = await CommunityComment.find({ creatorId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl');
    
    res.json({ success: true, comments });
  } catch (err) {
    next(err);
  }
});

// POST /api/community/creators/:creatorId/comments - Add a comment to a creator
router.post('/creators/:creatorId/comments', authenticate, async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const { text } = req.body;
    
    if (!text || !text.trim()) {
      throw new AppError('Comment text is required', 400);
    }
    
    // Check if creator exists
    const creator = await User.findById(creatorId);
    if (!creator || creator.role !== 'creator') {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    // Create comment with creatorId
    const comment = await CommunityComment.create({
      creatorId: creatorId,
      authorId: req.user._id,
      text: text.trim()
    });
    
    const populatedComment = await CommunityComment.findById(comment._id).populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl');
    
    res.status(201).json({ success: true, comment: populatedComment });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/community/creators/:creatorId/comments/:commentId - Delete a comment from a creator
router.delete('/creators/:creatorId/comments/:commentId', authenticate, async (req, res, next) => {
  try {
    const { creatorId, commentId } = req.params;
    
    const comment = await CommunityComment.findById(commentId);
    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }
    
    // Check if comment belongs to this creator
    if (comment.creatorId && comment.creatorId.toString() !== creatorId) {
      return res.status(403).json({ success: false, message: 'Comment does not belong to this creator' });
    }
    
    // Check if user is author or admin
    if (comment.authorId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'You can only delete your own comments' });
    }
    
    await comment.deleteOne();
    
    res.json({ success: true, message: 'Comment deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/community/creators/:creatorId/like - Like a creator
router.post('/creators/:creatorId/like', authenticate, async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const userId = req.user._id;
    
    // Check if creator exists
    const creator = await User.findById(creatorId);
    if (!creator || creator.role !== 'creator') {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    // Initialize likedBy array if not exists
    if (!creator.likedBy) creator.likedBy = [];
    if (creator.likeCount === undefined) creator.likeCount = 0;
    
    const hasLiked = creator.likedBy.includes(userId);
    
    if (hasLiked) {
      creator.likedBy = creator.likedBy.filter(id => id.toString() !== userId.toString());
      creator.likeCount = Math.max(0, creator.likeCount - 1);
    } else {
      creator.likedBy.push(userId);
      creator.likeCount += 1;
    }
    
    await creator.save();
    
    res.json({ 
      success: true, 
      liked: !hasLiked, 
      likeCount: creator.likeCount || 0 
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/community/creators/:creatorId/like - Unlike a creator (alternative method)
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

// GET /api/community/creators/:creatorId/like - Check if user liked a creator
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

// GET /api/community/creators/:creatorId/stats - Get creator engagement stats
router.get('/creators/:creatorId/stats', optionalAuthenticate, async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const userId = req.user?._id;
    
    const creator = await User.findById(creatorId).select('likedBy likeCount');
    const commentCount = await CommunityComment.countDocuments({ creatorId });
    
    const isLiked = userId && creator?.likedBy ? creator.likedBy.includes(userId) : false;
    
    res.json({ 
      success: true, 
      likeCount: creator?.likeCount || 0,
      commentCount: commentCount,
      isLiked: isLiked
    });
  } catch (err) {
    next(err);
  }
});

// ============================================
// NEW: GET /api/community/creators-with-open-campaigns
// Get creators who have open campaigns (for Bid tab)
// ============================================
router.get('/creators-with-open-campaigns', optionalAuthenticate, async (req, res, next) => {
  try {
    const userId = req.user?._id;
    
    // Get all open campaigns with no assigned creator
    const campaigns = await Campaign.find({ 
      status: 'open',
      assignedCreatorId: { $exists: false }
    }).populate('businessId', 'email profile.companyName profile.stageName');
    
    // Get creator IDs from campaigns
    const creatorIds = campaigns.map(c => c.businessId?._id).filter(Boolean);
    const uniqueCreatorIds = [...new Set(creatorIds.map(id => id.toString()))];
    
    // Get creators with open campaigns
    const creators = await User.find({
      _id: { $in: uniqueCreatorIds },
      role: 'creator',
      status: 'active'
    }).select('_id email uniqueCode profile socialLinks social createdAt status');
    
    // Add hasOpenCampaigns flag
    const creatorsWithCampaigns = creators.map(creator => {
      const creatorObj = creator.toObject();
      creatorObj.hasOpenCampaigns = true;
      // Find the campaign for this creator
      const campaign = campaigns.find(c => c.businessId?._id.toString() === creator._id.toString());
      creatorObj.openCampaignId = campaign?._id;
      creatorObj.campaignTitle = campaign?.title;
      creatorObj.campaignBudget = campaign?.budget;
      return creatorObj;
    });
    
    res.json({
      success: true,
      creators: creatorsWithCampaigns
    });
  } catch (err) {
    logger.error('Error fetching creators with open campaigns:', err);
    next(err);
  }
});

// ============================================
// TRENDING & SEARCH
// ============================================

// GET /api/community/trending - Get trending posts
router.get('/trending', optionalAuthenticate, async (req, res, next) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const posts = await CommunityPost.find({
      createdAt: { $gte: sevenDaysAgo },
      likeCount: { $gt: 10 }
    })
      .sort({ likeCount: -1, views: -1 })
      .limit(20)
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl profile.niche');
    
    res.json({ success: true, posts });
  } catch (err) {
    next(err);
  }
});

// GET /api/community/search - Search users and posts
router.get('/search', optionalAuthenticate, async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.json({ success: true, users: [], posts: [] });
    }
    
    const searchRegex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    
    const users = await User.find({
      $or: [
        { email: searchRegex },
        { uniqueCode: searchRegex },
        { 'profile.stageName': searchRegex },
        { 'profile.companyName': searchRegex },
        { 'profile.displayName': searchRegex }
      ]
    })
      .select('email uniqueCode role profile.stageName profile.companyName profile.avatarUrl profile.niche')
      .limit(20);
    
    const posts = await CommunityPost.find({
      $or: [
        { caption: searchRegex },
        { sound: searchRegex }
      ]
    })
      .sort({ likeCount: -1 })
      .limit(20)
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl');
    
    res.json({ success: true, users, posts });
  } catch (err) {
    next(err);
  }
});

// GET /api/community/user/:userId/posts - Get posts by specific user
router.get('/user/:userId/posts', optionalAuthenticate, async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { limit = 20 } = req.query;
    
    const posts = await CommunityPost.find({ authorId: userId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl');
    
    res.json({ success: true, posts });
  } catch (err) {
    next(err);
  }
});

// ============================================
// REPORT Endpoint
// ============================================

/**
 * POST /api/community/report
 * Report a user or post for inappropriate content
 */
router.post('/report', authenticate, [
  body('reportedUserId').optional().isMongoId().withMessage('Invalid user ID'),
  body('reportedPostId').optional().isMongoId().withMessage('Invalid post ID'),
  body('creatorId').optional().isMongoId().withMessage('Invalid creator ID'),
  body('reason').isIn(['spam', 'inappropriate', 'harassment', 'fake_account', 'copyright', 'other']).withMessage('Invalid report reason'),
  body('description').optional().isString().trim().isLength({ max: 1000 }).withMessage('Description too long')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }
    
    const { reportedUserId, reportedPostId, creatorId, reason, description } = req.body;
    
    // Must report either a user or a post
    if (!reportedUserId && !reportedPostId && !creatorId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Must report either a user, creator, or a post' 
      });
    }
    
    const Report = require('../models/Report');
    
    // Check for duplicate report (same reporter, same target, pending)
    const existingReport = await Report.findOne({
      reporterId: req.user._id,
      reportedUserId: reportedUserId || creatorId || null,
      reportedPostId: reportedPostId || null,
      status: { $in: ['pending', 'reviewing'] }
    });
    
    if (existingReport) {
      return res.status(400).json({ 
        success: false, 
        message: 'You have already reported this content. It is under review.' 
      });
    }
    
    // Verify the reported user exists (if provided)
    if (reportedUserId || creatorId) {
      const targetId = reportedUserId || creatorId;
      const reportedUser = await User.findById(targetId);
      if (!reportedUser) {
        return res.status(404).json({ success: false, message: 'Reported user not found' });
      }
    }
    
    // Verify the reported post exists (if provided)
    if (reportedPostId) {
      const reportedPost = await CommunityPost.findById(reportedPostId);
      if (!reportedPost) {
        return res.status(404).json({ success: false, message: 'Reported post not found' });
      }
    }
    
    // Create the report
    const report = await Report.create({
      reporterId: req.user._id,
      reportedUserId: reportedUserId || creatorId || null,
      reportedPostId: reportedPostId || null,
      reason,
      description: description || null,
      status: 'pending'
    });
    
    logger.info(`Report created by user ${req.user._id}`, {
      reason,
      reportId: report._id
    });
    
    // Notify admins via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.to('status:global').emit('moderation:new-report', {
        reportId: report._id,
        reason,
        createdAt: report.createdAt
      });
    }
    
    res.status(201).json({
      success: true,
      message: 'Report submitted. Our moderation team will review it shortly.',
      data: { reportId: report._id }
    });
    
  } catch (err) {
    logger.error('Report creation error:', err);
    next(err);
  }
});

module.exports = router;
