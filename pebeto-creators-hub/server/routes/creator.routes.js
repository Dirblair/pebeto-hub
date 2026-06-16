const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');

// GET /api/creators - Fetch ALL creators (with or without social links)
router.get('/creators', async (req, res) => {
  try {
    const { search, niche, limit = 50 } = req.query;
    
    let query = { role: 'creator', status: 'active' };
    
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { email: searchRegex },
        { uniqueCode: searchRegex },
        { 'profile.stageName': searchRegex },
        { 'profile.displayName': searchRegex }
      ];
    }
    
    if (niche && niche !== '') {
      query['profile.niche'] = niche;
    }
    
    const creators = await User.find(query)
      .select('_id email uniqueCode profile socialLinks social createdAt status likeCount likedBy')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    
    const CommunityComment = require('../models/CommunityComment');
    
    const creatorsWithStats = await Promise.all(creators.map(async (creator) => {
      const likeCount = creator.likeCount || 0;
      const commentCount = await CommunityComment.countDocuments({ creatorId: creator._id });
      
      return {
        _id: creator._id,
        email: creator.email,
        uniqueCode: creator.uniqueCode,
        profile: creator.profile,
        socialLinks: creator.socialLinks || { tiktok: '', youtube: '', instagram: '', twitter: '' },
        social: creator.social || { followerCount: 0 },
        status: creator.status,
        likeCount,
        commentCount,
        isLiked: creator.likedBy ? creator.likedBy.includes(req.user?._id) : false,
        createdAt: creator.createdAt,
        hasSocialMedia: !!(creator.socialLinks?.tiktok || creator.socialLinks?.youtube)
      };
    }));
    
    res.json({
      success: true,
      count: creatorsWithStats.length,
      creators: creatorsWithStats
    });
    
  } catch (error) {
    console.error('Error fetching creators:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch creators',
      error: error.message
    });
  }
});

// GET /api/creators/:id - Get single creator by ID
router.get('/creators/:id', async (req, res) => {
  try {
    const creator = await User.findOne({ _id: req.params.id, role: 'creator' })
      .select('_id email uniqueCode profile socialLinks social createdAt status likeCount likedBy');
    
    if (!creator) {
      return res.status(404).json({ success: false, message: 'Creator not found' });
    }
    
    const CommunityComment = require('../models/CommunityComment');
    const likeCount = creator.likeCount || 0;
    const commentCount = await CommunityComment.countDocuments({ creatorId: creator._id });
    
    res.json({
      success: true,
      creator: {
        ...creator.toObject(),
        likeCount,
        commentCount,
        isLiked: creator.likedBy ? creator.likedBy.includes(req.user?._id) : false
      }
    });
  } catch (error) {
    console.error('Error fetching creator:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch creator' });
  }
});

// POST /api/creator/social-links - Save or update creator's social links
router.post('/creator/social-links', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const { tiktokUrl, youtubeUrl } = req.body;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    if (user.role !== 'creator') {
      return res.status(403).json({ success: false, message: 'Only creators can set social links' });
    }
    
    // Initialize socialLinks if not exists
    if (!user.socialLinks) {
      user.socialLinks = {};
    }
    
    // Update only the fields provided
    if (tiktokUrl !== undefined) user.socialLinks.tiktok = tiktokUrl || '';
    if (youtubeUrl !== undefined) user.socialLinks.youtube = youtubeUrl || '';
    
    await user.save();
    
    res.json({
      success: true,
      message: 'Social links saved successfully',
      socialLinks: user.socialLinks
    });
  } catch (error) {
    console.error('Error saving social links:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save social links',
      error: error.message
    });
  }
});

// GET /api/creator/social-links - Get creator's social links
router.get('/creator/social-links', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    
    const user = await User.findById(userId).select('socialLinks');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    res.json({
      success: true,
      socialLinks: user.socialLinks || { tiktok: '', youtube: '', instagram: '', twitter: '' }
    });
  } catch (error) {
    console.error('Error fetching social links:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch social links'
    });
  }
});

module.exports = router;
