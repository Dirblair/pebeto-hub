const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const CommunityPost = require('../models/CommunityPost');
const CommunityComment = require('../models/CommunityComment');
const User = require('../models/User');
const { AppError } = require('../utils/errors');
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');

const router = express.Router();

// ============================================
// TEST ROUTE - Verify routes are working
// ============================================
router.get('/test', (req, res) => {
  res.json({ 
    success: true, 
    message: '✅ Community routes are working!',
    cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME,
    timestamp: new Date().toISOString()
  });
});

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure multer for memory storage
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// ============================================
// NEW: FEED ENDPOINT - The main feed with tab filtering
// ============================================

/**
 * GET /api/community/feed
 * Get feed posts with tab filtering (For You, What's New, Following, Friends)
 */
router.get('/feed', optionalAuthenticate, async (req, res, next) => {
  try {
    const { tab = 'foryou', limit = 20, skip = 0 } = req.query;
    const userId = req.user?._id;
    
    let following = [];
    let mutualFollows = [];
    
    // If user is authenticated, get their following and mutual follows
    if (userId) {
      const user = await User.findById(userId).select('following likedBy');
      following = user?.following || [];
      // Mutual follows: users who follow you AND you follow them
      const userFollowing = user?.following || [];
      const userFollowers = user?.likedBy || [];
      mutualFollows = userFollowing.filter(id => userFollowers.includes(id));
    }
    
    // Get feed using the static method
    const posts = await CommunityPost.getFeed({
      userId,
      tab,
      limit: parseInt(limit),
      skip: parseInt(skip),
      following,
      mutualFollows
    });
    
    // Enrich posts with user interaction data
    const enrichedPosts = posts.map(post => {
      const postObj = post.toObject ? post.toObject() : post;
      if (userId) {
        postObj.isLikedByCurrentUser = postObj.likes?.some(id => id.toString() === userId.toString()) || false;
      }
      return postObj;
    });
    
    res.json({
      success: true,
      posts: enrichedPosts,
      pagination: {
        limit: parseInt(limit),
        skip: parseInt(skip),
        hasMore: enrichedPosts.length === parseInt(limit)
      }
    });
  } catch (err) {
    logger.error('Feed error:', err);
    next(err);
  }
});

// ============================================
// POSTS - Enhanced
// ============================================

// GET /api/community/posts - Get all posts (with optional filters)
router.get('/posts', optionalAuthenticate, async (req, res, next) => {
  try {
    const { limit = 20, skip = 0, authorId, category, search } = req.query;
    const userId = req.user?._id;
    
    let query = { isDeleted: false };
    
    // Filter by author
    if (authorId) {
      query.authorId = authorId;
    }
    
    // Filter by category
    if (category) {
      query.category = category;
    }
    
    // Filter by visibility
    if (userId) {
      query.$or = [
        { visibility: 'public' },
        { authorId: userId }
      ];
    } else {
      query.visibility = 'public';
    }
    
    // Search
    if (search && search.length >= 2) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { caption: searchRegex },
        { tags: searchRegex },
        { sound: searchRegex }
      ];
    }
    
    const posts = await CommunityPost.find(query)
      .sort({ createdAt: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl profile.niche');
    
    const enrichedPosts = posts.map(post => {
      const postObj = post.toObject();
      postObj.isLikedByCurrentUser = userId ? post.likes?.some(id => id.toString() === userId.toString()) : false;
      return postObj;
    });
    
    res.json({ success: true, posts: enrichedPosts });
  } catch (err) {
    logger.error('Get posts error:', err);
    next(err);
  }
});

// GET /api/community/posts/:postId - Get single post
router.get('/posts/:postId', optionalAuthenticate, async (req, res, next) => {
  try {
    const { postId } = req.params;
    const userId = req.user?._id;
    
    const post = await CommunityPost.findOne({ _id: postId, isDeleted: false })
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl profile.niche');
    
    if (!post) {
      throw new AppError('Post not found', 404);
    }
    
    // Increment views
    await post.incrementViews();
    
    const postObj = post.toObject();
    postObj.isLikedByCurrentUser = userId ? post.likes?.some(id => id.toString() === userId.toString()) : false;
    
    res.json({ success: true, post: postObj });
  } catch (err) {
    next(err);
  }
});

// POST /api/community/posts - Create a new post (upload video/image/audio)
router.post('/posts', authenticate, upload.single('media'), async (req, res, next) => {
  try {
    console.log('📤 Upload request received');
    console.log('User:', req.user?._id);
    console.log('File:', req.file ? `${req.file.originalname} (${req.file.size} bytes)` : 'NO FILE');
    console.log('Body:', req.body);

    if (!req.file) {
      throw new AppError('No media file uploaded', 400);
    }
    
    const { caption, category, tags, sound, visibility = 'public' } = req.body;
    const file = req.file;
    
    // Determine media type
    let mediaType = 'video';
    if (file.mimetype.startsWith('image/')) mediaType = 'image';
    else if (file.mimetype.startsWith('audio/')) mediaType = 'audio';
    else if (file.mimetype.startsWith('video/')) mediaType = 'video';
    
    // Determine resource type for Cloudinary
    let resourceType = 'auto';
    if (mediaType === 'image') resourceType = 'image';
    else if (mediaType === 'video') resourceType = 'video';
    else if (mediaType === 'audio') resourceType = 'video'; // Audio is treated as video by Cloudinary
    
    // Upload to Cloudinary
    console.log('☁️ Uploading to Cloudinary...');
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: resourceType,
          folder: 'pebeto/community',
          transformation: mediaType === 'video' ? [{ width: 720, height: 1280, crop: 'limit' }] : [],
          ...(mediaType === 'video' && { eager: [{ format: 'jpg', width: 720, height: 1280, crop: 'limit' }] })
        },
        (error, result) => {
          if (error) {
            console.error('Cloudinary error:', error);
            reject(error);
          } else {
            console.log('✅ Cloudinary upload success:', result.public_id);
            resolve(result);
          }
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
    } else if (mediaType === 'image') {
      thumbnailUrl = uploadResult.secure_url;
    }
    
    // Parse tags
    const tagArray = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];
    
    // Create post
    const post = await CommunityPost.create({
      authorId: req.user._id,
      mediaUrl: uploadResult.secure_url,
      mediaType,
      thumbnailUrl: thumbnailUrl || uploadResult.secure_url,
      caption: caption || '',
      category: category || 'Other',
      tags: tagArray,
      sound: sound || 'Original Sound',
      duration: uploadResult.duration || 0,
      visibility: visibility || 'public',
      likes: [],
      likeCount: 0,
      commentCount: 0,
      views: 0
    });
    
    console.log('✅ Post created successfully:', post._id);
    
    const populatedPost = await CommunityPost.findById(post._id)
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl profile.niche');
    
    // Emit real-time event via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.to('status:global').emit('post:new', {
        postId: post._id,
        authorId: req.user._id,
        authorName: req.user.profile?.stageName || req.user.email
      });
    }
    
    res.status(201).json({ success: true, post: populatedPost });
  } catch (err) {
    logger.error('Upload error:', err);
    next(err);
  }
});

// PUT /api/community/posts/:postId - Update post
router.put('/posts/:postId', authenticate, async (req, res, next) => {
  try {
    const { postId } = req.params;
    const { caption, category, tags, sound, visibility } = req.body;
    
    const post = await CommunityPost.findById(postId);
    if (!post) {
      throw new AppError('Post not found', 404);
    }
    
    // Check ownership
    if (post.authorId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      throw new AppError('You can only edit your own posts', 403);
    }
    
    // Update fields
    if (caption !== undefined) post.caption = caption;
    if (category) post.category = category;
    if (sound) post.sound = sound;
    if (visibility) post.visibility = visibility;
    if (tags !== undefined) {
      post.tags = tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    }
    
    await post.save();
    
    const updatedPost = await CommunityPost.findById(postId)
      .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl profile.niche');
    
    res.json({ success: true, post: updatedPost });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/community/posts/:postId - Delete a post (soft delete)
router.delete('/posts/:postId', authenticate, async (req, res, next) => {
  try {
    const { postId } = req.params;
    const post = await CommunityPost.findById(postId);
    if (!post) {
      throw new AppError('Post not found', 404);
    }
    
    if (post.authorId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      throw new AppError('You can only delete your own posts', 403);
    }
    
    await post.softDelete();
    
    // Also delete associated comments
    await CommunityComment.deleteMany({ postId });
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.to('status:global').emit('post:deleted', { postId });
    }
    
    res.json({ success: true, message: 'Post deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /api/community/posts/:postId/like - Toggle like on a post
router.post('/posts/:postId/like', authenticate, async (req, res, next) => {
  try {
    const { postId } = req.params;
    const userId = req.user._id;
    
    const post = await CommunityPost.findById(postId);
    if (!post) {
      throw new AppError('Post not found', 404);
    }
    
    const result = await post.toggleLike(userId);
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.to('status:global').emit('post:like', {
        postId,
        userId,
        liked: result.liked,
        likeCount: result.likeCount
      });
    }
    
    res.json({ success: true, liked: result.liked, likeCount: result.likeCount });
  } catch (err) {
    next(err);
  }
});

// POST /api/community/posts/:postId/view - Increment view count
router.post('/posts/:postId/view', optionalAuthenticate, async (req, res, next) => {
  try {
    const { postId } = req.params;
    
    const post = await CommunityPost.findById(postId);
    if (!post) {
      throw new AppError('Post not found', 404);
    }
    
    const views = await post.incrementViews();
    
    res.json({ success: true, views });
  } catch (err) {
    next(err);
  }
});

// POST /api/community/posts/:postId/share - Increment share count
router.post('/posts/:postId/share', authenticate, async (req, res, next) => {
  try {
    const { postId } = req.params;
    
    const post = await CommunityPost.findById(postId);
    if (!post) {
      throw new AppError('Post not found', 404);
    }
    
    const shares = await post.incrementShares();
    
    res.json({ success: true, shares });
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
    
    const alreadySaved = user.metadata.savedPosts.some(id => id.toString() === postId);
    
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
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.to('status:global').emit('post:comment', {
        postId,
        commentId: comment._id,
        authorId: req.user._id,
        authorName: req.user.profile?.stageName || req.user.email
      });
    }
    
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
// TRENDING & SEARCH (Enhanced)
// ============================================

// GET /api/community/trending - Get trending posts
router.get('/trending', optionalAuthenticate, async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const posts = await CommunityPost.getTrending(parseInt(limit));
    
    const userId = req.user?._id;
    const enrichedPosts = posts.map(post => {
      const postObj = post.toObject();
      postObj.isLikedByCurrentUser = userId ? post.likes?.some(id => id.toString() === userId.toString()) : false;
      return postObj;
    });
    
    res.json({ success: true, posts: enrichedPosts });
  } catch (err) {
    next(err);
  }
});

// GET /api/community/search - Search users and posts
router.get('/search', optionalAuthenticate, async (req, res, next) => {
  try {
    const { q, type = 'all' } = req.query;
    if (!q || q.length < 2) {
      return res.json({ success: true, users: [], posts: [] });
    }
    
    const searchRegex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    
    let users = [];
    let posts = [];
    
    // Search users if type is 'all' or 'users'
    if (type === 'all' || type === 'users') {
      users = await User.find({
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
    }
    
    // Search posts if type is 'all' or 'posts'
    if (type === 'all' || type === 'posts') {
      posts = await CommunityPost.searchPosts(q, { limit: 20 })
        .populate('authorId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl');
    }
    
    res.json({ success: true, users, posts });
  } catch (err) {
    next(err);
  }
});

// GET /api/community/user/:userId/posts - Get posts by specific user
router.get('/user/:userId/posts', optionalAuthenticate, async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { limit = 20, skip = 0 } = req.query;
    
    const posts = await CommunityPost.getByAuthor(userId, {
      limit: parseInt(limit),
      skip: parseInt(skip)
    });
    
    const userIdCurrent = req.user?._id;
    const enrichedPosts = posts.map(post => {
      const postObj = post.toObject();
      postObj.isLikedByCurrentUser = userIdCurrent ? post.likes?.some(id => id.toString() === userIdCurrent.toString()) : false;
      return postObj;
    });
    
    res.json({ success: true, posts: enrichedPosts });
  } catch (err) {
    next(err);
  }
});

// GET /api/community/categories - Get all categories
router.get('/categories', async (req, res, next) => {
  try {
    const categories = [
      'Music', 'Art', 'Fitness', 'Gaming', 'Tech',
      'Comedy', 'Education', 'Lifestyle', 'Dance',
      'Sports', 'Food', 'Fashion', 'Travel', 'Other'
    ];
    res.json({ success: true, categories });
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

// POST /api/community/creators/:creatorId/comments - Add a comment to a creator
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
    
    if (comment.creatorId && comment.creatorId.toString() !== creatorId) {
      return res.status(403).json({ success: false, message: 'Comment does not belong to this creator' });
    }
    
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
    
    const creator = await User.findById(creatorId);
    if (!creator || creator.role !== 'creator') {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    if (!creator.likedBy) creator.likedBy = [];
    if (creator.likeCount === undefined) creator.likeCount = 0;
    
    const hasLiked = creator.likedBy.some(id => id.toString() === userId.toString());
    
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

// DELETE /api/community/creators/:creatorId/like - Unlike a creator
router.delete('/creators/:creatorId/like', authenticate, async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const userId = req.user._id;
    
    const creator = await User.findById(creatorId);
    if (!creator || creator.role !== 'creator') {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    if (!creator.likedBy) creator.likedBy = [];
    
    const hadLiked = creator.likedBy.some(id => id.toString() === userId.toString());
    
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
    
    const isLiked = creator.likedBy ? creator.likedBy.some(id => id.toString() === userId.toString()) : false;
    
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
    
    const isLiked = userId && creator?.likedBy ? creator.likedBy.some(id => id.toString() === userId.toString()) : false;
    
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
// REPORT Endpoint
// ============================================

/**
 * POST /api/community/report
 * Report a user or post for inappropriate content
 */
router.post('/report', authenticate, [
  body('reportedUserId').optional().isMongoId().withMessage('Invalid user ID'),
  body('reportedPostId').optional().isMongoId().withMessage('Invalid post ID'),
  body('reason').isIn(['spam', 'inappropriate', 'harassment', 'fake_account', 'copyright', 'other']).withMessage('Invalid report reason'),
  body('description').optional().isString().trim().isLength({ max: 1000 }).withMessage('Description too long')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }
    
    const { reportedUserId, reportedPostId, reason, description } = req.body;
    
    if (!reportedUserId && !reportedPostId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Must report either a user or a post' 
      });
    }
    
    const Report = require('../models/Report');
    
    const existingReport = await Report.findOne({
      reporterId: req.user._id,
      reportedUserId: reportedUserId || null,
      reportedPostId: reportedPostId || null,
      status: { $in: ['pending', 'reviewing'] }
    });
    
    if (existingReport) {
      return res.status(400).json({ 
        success: false, 
        message: 'You have already reported this content. It is under review.' 
      });
    }
    
    if (reportedUserId) {
      const reportedUser = await User.findById(reportedUserId);
      if (!reportedUser) {
        return res.status(404).json({ success: false, message: 'Reported user not found' });
      }
    }
    
    if (reportedPostId) {
      const reportedPost = await CommunityPost.findById(reportedPostId);
      if (!reportedPost) {
        return res.status(404).json({ success: false, message: 'Reported post not found' });
      }
    }
    
    const report = await Report.create({
      reporterId: req.user._id,
      reportedUserId: reportedUserId || null,
      reportedPostId: reportedPostId || null,
      reason,
      description: description || null,
      status: 'pending'
    });
    
    logger.info(`Report created by user ${req.user._id}`, {
      reason,
      reportId: report._id
    });
    
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
