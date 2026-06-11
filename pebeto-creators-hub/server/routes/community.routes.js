const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const CommunityPost = require('../models/CommunityPost');
const CommunityComment = require('../models/CommunityComment');
const User = require('../models/User');
const { AppError } = require('../utils/errors');

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
// COMMENTS
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

module.exports = router;
