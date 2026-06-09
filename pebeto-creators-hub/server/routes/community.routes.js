/**
 * Community Routes for Pebeto Creator's Hub
 * 
 * Handles community feed posts, likes, and comments
 * 
 * @module routes/community
 */

const express = require('express');
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const { catchAsync } = require('../middleware/errorHandler');
const { AppError } = require('../utils/errors');

const router = express.Router();

// Temporary mock data store (replace with database later)
let posts = [];

/**
 * GET /api/community/posts
 * Get all community posts
 */
router.get('/posts', optionalAuthenticate, catchAsync(async (req, res) => {
  res.json({
    success: true,
    data: {
      posts: posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    }
  });
}));

/**
 * POST /api/community/posts
 * Create a new post
 */
router.post('/posts', authenticate, catchAsync(async (req, res) => {
  const { videoUrl, caption, mediaType, thumbnailUrl } = req.body;
  
  if (!videoUrl) {
    throw new AppError('Video URL is required', 400);
  }
  
  const newPost = {
    _id: `post_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    videoUrl,
    caption: caption || '',
    mediaType: mediaType || 'video',
    thumbnailUrl: thumbnailUrl || null,
    author: {
      id: req.user._id,
      uniqueCode: req.user.uniqueCode || 'USER',
      displayName: req.user.profile?.stageName || req.user.profile?.companyName || req.user.email,
      role: req.user.role,
    },
    likeCount: 0,
    commentCount: 0,
    isLikedByCurrentUser: false,
    createdAt: new Date().toISOString()
  };
  
  posts.unshift(newPost);
  
  // Emit via socket if available
  const io = req.app.get('io');
  if (io) {
    io.to('feed:global').emit('feed:new-post', newPost);
  }
  
  res.status(201).json({
    success: true,
    data: newPost
  });
}));

/**
 * POST /api/community/posts/:postId/like
 * Like or unlike a post
 */
router.post('/posts/:postId/like', authenticate, catchAsync(async (req, res) => {
  const { postId } = req.params;
  const post = posts.find(p => p._id === postId);
  
  if (!post) {
    throw new AppError('Post not found', 404);
  }
  
  const userId = req.user._id.toString();
  const wasLiked = post.isLikedByCurrentUser;
  
  post.isLikedByCurrentUser = !wasLiked;
  post.likeCount += wasLiked ? -1 : 1;
  
  res.json({
    success: true,
    data: {
      liked: post.isLikedByCurrentUser,
      likeCount: post.likeCount
    }
  });
}));

/**
 * POST /api/community/posts/:postId/comments
 * Add a comment to a post
 */
router.post('/posts/:postId/comments', authenticate, catchAsync(async (req, res) => {
  const { postId } = req.params;
  const { text } = req.body;
  
  if (!text || !text.trim()) {
    throw new AppError('Comment text is required', 400);
  }
  
  const post = posts.find(p => p._id === postId);
  if (!post) {
    throw new AppError('Post not found', 404);
  }
  
  const newComment = {
    id: `comment_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    text: text.trim(),
    author: {
      id: req.user._id,
      uniqueCode: req.user.uniqueCode || 'USER',
      displayName: req.user.profile?.stageName || req.user.profile?.companyName || req.user.email,
    },
    createdAt: new Date().toISOString()
  };
  
  if (!post.comments) post.comments = [];
  post.comments.unshift(newComment);
  post.commentCount = (post.commentCount || 0) + 1;
  
  res.status(201).json({
    success: true,
    data: newComment
  });
}));

/**
 * GET /api/community/posts/:postId/comments
 * Get comments for a post
 */
router.get('/posts/:postId/comments', optionalAuthenticate, catchAsync(async (req, res) => {
  const { postId } = req.params;
  const post = posts.find(p => p._id === postId);
  
  if (!post) {
    throw new AppError('Post not found', 404);
  }
  
  res.json({
    success: true,
    data: {
      comments: post.comments || []
    }
  });
}));

/**
 * DELETE /api/community/posts/:postId
 * Delete a post (owner or admin only)
 */
router.delete('/posts/:postId', authenticate, catchAsync(async (req, res) => {
  const { postId } = req.params;
  const postIndex = posts.findIndex(p => p._id === postId);
  
  if (postIndex === -1) {
    throw new AppError('Post not found', 404);
  }
  
  const post = posts[postIndex];
  const isOwner = post.author.id === req.user._id.toString();
  const isAdmin = req.user.role === 'admin';
  
  if (!isOwner && !isAdmin) {
    throw new AppError('You do not have permission to delete this post', 403);
  }
  
  posts.splice(postIndex, 1);
  
  res.json({
    success: true,
    message: 'Post deleted successfully'
  });
}));

module.exports = router;
