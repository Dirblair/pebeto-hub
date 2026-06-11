const express = require('express');
const router = express.Router();
const User = require('../models/User'); // Adjust path to your User model

// GET /api/creators - Fetch all creators with social links
router.get('/creators', async (req, res) => {
  try {
    // Find all users with role = 'creator'
    const creators = await User.find({ role: 'creator' })
      .select('email profile socialLinks createdAt')
      .sort({ createdAt: -1 });
    
    // Filter to only include creators who have connected social media
    const creatorsWithSocial = creators.filter(creator => 
      creator.socialLinks && (
        (creator.socialLinks.tiktok && creator.socialLinks.tiktok.trim() !== '') ||
        (creator.socialLinks.youtube && creator.socialLinks.youtube.trim() !== '')
      )
    );
    
    res.json({
      success: true,
      count: creatorsWithSocial.length,
      creators: creatorsWithSocial
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

// POST /api/creator/social-links - Save or update creator's social links
router.post('/creator/social-links', async (req, res) => {
  try {
    const userId = req.user.id; // From your auth middleware
    const { tiktokUrl, youtubeUrl } = req.body;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    if (user.role !== 'creator') {
      return res.status(403).json({ success: false, message: 'Only creators can set social links' });
    }
    
    // Update social links
    user.socialLinks = {
      tiktok: tiktokUrl || '',
      youtube: youtubeUrl || ''
    };
    
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
router.get('/creator/social-links', async (req, res) => {
  try {
    const userId = req.user.id;
    
    const user = await User.findById(userId).select('socialLinks');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    res.json({
      success: true,
      socialLinks: user.socialLinks || { tiktok: '', youtube: '' }
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
