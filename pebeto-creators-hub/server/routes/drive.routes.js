/**
 * Google Drive Routes for Pebeto Creator's Hub
 * 
 * Handles Google Drive OAuth flow and file operations:
 * - Initiate OAuth connection
 * - OAuth callback handler
 * - Upload video to Drive
 * - Get user's uploaded videos
 * - Delete video from Drive
 * - Disconnect Drive account
 * 
 * @module routes/drive
 */

const express = require('express');
const multer = require('multer');
const { authenticate, authorize } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { catchAsync } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const User = require('../models/User');
const Campaign = require('../models/Campaign');

const {
  generateAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  uploadVideoToDrive,
  listUserVideos,
  deleteFile,
  verifyDriveConnection,
  getDriveQuota,
  validateFileSize,
  isValidVideoMimeType
} = require('../services/googleDriveService');

const router = express.Router();

// Configure multer for memory storage (file uploads)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB max
  },
  fileFilter: (req, file, cb) => {
    if (isValidVideoMimeType(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('Invalid file type. Please upload a video file (MP4, MOV, AVI, WEBM).', 400));
    }
  }
});

// ============================================
// OAuth Flow Routes
// ============================================

/**
 * GET /api/drive/auth
 * Initiate Google Drive OAuth connection
 * Redirects user to Google consent screen
 */
router.get('/auth', authenticate, catchAsync(async (req, res) => {
  const userId = req.user._id;
  const authUrl = generateAuthUrl(userId.toString());
  
  res.json({
    success: true,
    data: {
      authUrl,
      message: 'Redirect to this URL to connect your Google Drive'
    }
  });
}));

/**
 * GET /api/drive/callback
 * OAuth callback handler after user grants permission
 */
router.get('/callback', catchAsync(async (req, res) => {
  const { code, state: userId, error } = req.query;
  
  if (error) {
    logger.error('Google OAuth error:', error);
    return res.redirect(`${process.env.CLIENT_ORIGIN || 'https://pebeto.com'}/settings?drive_error=${error}`);
  }
  
  if (!code) {
    return res.redirect(`${process.env.CLIENT_ORIGIN || 'https://pebeto.com'}/settings?drive_error=no_code`);
  }
  
  if (!userId) {
    return res.redirect(`${process.env.CLIENT_ORIGIN || 'https://pebeto.com'}/settings?drive_error=no_user`);
  }
  
  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);
    
    // Find user and save tokens
    const user = await User.findById(userId);
    if (!user) {
      return res.redirect(`${process.env.CLIENT_ORIGIN || 'https://pebeto.com'}/settings?drive_error=user_not_found`);
    }
    
    await user.setGoogleDriveTokens({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn
    });
    
    logger.info(`Google Drive connected for user ${userId}`);
    
    res.redirect(`${process.env.CLIENT_ORIGIN || 'https://pebeto.com'}/creator-dashboard.html?drive=connected`);
    
  } catch (error) {
    logger.error('OAuth callback error:', error);
    res.redirect(`${process.env.CLIENT_ORIGIN || 'https://pebeto.com'}/settings?drive_error=token_exchange_failed`);
  }
}));

/**
 * GET /api/drive/status
 * Check if user has connected Google Drive
 */
router.get('/status', authenticate, catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select('googleDriveConnected googleDriveConnectedAt');
  
  let quota = null;
  let isConnected = false;
  let isValid = false;
  
  if (user?.googleDriveConnected) {
    // Get fresh user with tokens
    const fullUser = await User.findById(req.user._id).select('+googleDriveAccessToken +googleDriveTokenExpiresAt');
    
    if (fullUser.googleDriveAccessToken) {
      isValid = await verifyDriveConnection(fullUser.googleDriveAccessToken);
      if (isValid) {
        quota = await getDriveQuota(fullUser.googleDriveAccessToken);
      }
    }
    isConnected = true;
  }
  
  res.json({
    success: true,
    data: {
      isConnected,
      isValid,
      connectedAt: user?.googleDriveConnectedAt,
      quota
    }
  });
}));

/**
 * DELETE /api/drive/disconnect
 * Disconnect Google Drive account
 */
router.delete('/disconnect', authenticate, catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);
  
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  await user.clearGoogleDriveTokens();
  
  logger.info(`Google Drive disconnected for user ${req.user._id}`);
  
  res.json({
    success: true,
    message: 'Google Drive disconnected successfully'
  });
}));

// ============================================
// File Operations Routes
// ============================================

/**
 * POST /api/drive/upload
 * Upload a video file to Google Drive (creator only)
 */
router.post(
  '/upload',
  authenticate,
  authorize('creator'),
  upload.single('video'),
  catchAsync(async (req, res) => {
    const { campaignId } = req.body;
    
    if (!req.file) {
      throw new AppError('No video file uploaded', 400);
    }
    
    if (!campaignId) {
      throw new AppError('Campaign ID is required', 400);
    }
    
    // Verify campaign belongs to this creator
    const campaign = await Campaign.findOne({
      _id: campaignId,
      assignedCreatorId: req.user._id
    });
    
    if (!campaign) {
      throw new AppError('Campaign not found or you are not the assigned creator', 404);
    }
    
    // Validate file size
    validateFileSize(req.file.size);
    
    // Get user with tokens
    const user = await User.findById(req.user._id).select('+googleDriveAccessToken +googleDriveRefreshToken +googleDriveTokenExpiresAt');
    
    if (!user.googleDriveConnected || !user.googleDriveAccessToken) {
      throw new AppError('Google Drive not connected. Please connect your Google account first.', 400);
    }
    
    let accessToken = user.googleDriveAccessToken;
    
    // Check if token needs refresh
    if (user.needsGoogleDriveRefresh() && user.googleDriveRefreshToken) {
      const newTokens = await refreshAccessToken(user.googleDriveRefreshToken);
      await user.setGoogleDriveTokens({
        accessToken: newTokens.accessToken,
        refreshToken: user.googleDriveRefreshToken,
        expiresIn: newTokens.expiresIn
      });
      accessToken = newTokens.accessToken;
    }
    
    // Upload video to Drive
    const result = await uploadVideoToDrive({
      accessToken,
      fileBuffer: req.file.buffer,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      campaignId
    });
    
    // Store file info in campaign (optional - can be used for review)
    if (!campaign.driveFiles) {
      campaign.driveFiles = [];
    }
    
    campaign.driveFiles.push({
      fileId: result.fileId,
      fileName: result.fileName,
      fileUrl: result.fileUrl,
      embedUrl: result.embedUrl,
      uploadedAt: new Date(),
      size: result.size
    });
    
    await campaign.save();
    
    logger.info(`Video uploaded to Drive for campaign ${campaignId} by user ${req.user._id}`);
    
    res.json({
      success: true,
      message: 'Video uploaded successfully',
      data: {
        fileId: result.fileId,
        fileUrl: result.fileUrl,
        embedUrl: result.embedUrl,
        fileName: result.fileName,
        size: result.size
      }
    });
  })
);

/**
 * POST /api/drive/upload-url
 * Upload a video from a URL to Google Drive
 */
router.post(
  '/upload-url',
  authenticate,
  authorize('creator'),
  catchAsync(async (req, res) => {
    const { campaignId, videoUrl, fileName } = req.body;
    
    if (!campaignId) {
      throw new AppError('Campaign ID is required', 400);
    }
    
    if (!videoUrl) {
      throw new AppError('Video URL is required', 400);
    }
    
    // Verify campaign belongs to this creator
    const campaign = await Campaign.findOne({
      _id: campaignId,
      assignedCreatorId: req.user._id
    });
    
    if (!campaign) {
      throw new AppError('Campaign not found or you are not the assigned creator', 404);
    }
    
    // Get user with tokens
    const user = await User.findById(req.user._id).select('+googleDriveAccessToken +googleDriveRefreshToken +googleDriveTokenExpiresAt');
    
    if (!user.googleDriveConnected || !user.googleDriveAccessToken) {
      throw new AppError('Google Drive not connected. Please connect your Google account first.', 400);
    }
    
    let accessToken = user.googleDriveAccessToken;
    
    // Check if token needs refresh
    if (user.needsGoogleDriveRefresh() && user.googleDriveRefreshToken) {
      const newTokens = await refreshAccessToken(user.googleDriveRefreshToken);
      await user.setGoogleDriveTokens({
        accessToken: newTokens.accessToken,
        refreshToken: user.googleDriveRefreshToken,
        expiresIn: newTokens.expiresIn
      });
      accessToken = newTokens.accessToken;
    }
    
    // Import the upload from URL function
    const { uploadVideoFromUrl } = require('../services/googleDriveService');
    
    const result = await uploadVideoFromUrl({
      accessToken,
      videoUrl,
      fileName: fileName || `video_${Date.now()}.mp4`,
      campaignId
    });
    
    // Store file info in campaign
    if (!campaign.driveFiles) {
      campaign.driveFiles = [];
    }
    
    campaign.driveFiles.push({
      fileId: result.fileId,
      fileName: result.fileName,
      fileUrl: result.fileUrl,
      embedUrl: result.embedUrl,
      uploadedAt: new Date(),
      size: result.size
    });
    
    await campaign.save();
    
    res.json({
      success: true,
      message: 'Video uploaded successfully',
      data: {
        fileId: result.fileId,
        fileUrl: result.fileUrl,
        embedUrl: result.embedUrl,
        fileName: result.fileName,
        size: result.size
      }
    });
  })
);

/**
 * GET /api/drive/videos
 * List user's uploaded videos (optionally filtered by campaign)
 */
router.get('/videos', authenticate, catchAsync(async (req, res) => {
  const { campaignId, limit = 20, page = 1 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  
  // Get user with tokens
  const user = await User.findById(req.user._id).select('+googleDriveAccessToken +googleDriveRefreshToken +googleDriveTokenExpiresAt');
  
  if (!user.googleDriveConnected || !user.googleDriveAccessToken) {
    return res.json({
      success: true,
      data: {
        videos: [],
        isConnected: false,
        message: 'Google Drive not connected'
      }
    });
  }
  
  let accessToken = user.googleDriveAccessToken;
  
  // Check if token needs refresh
  if (user.needsGoogleDriveRefresh() && user.googleDriveRefreshToken) {
    const newTokens = await refreshAccessToken(user.googleDriveRefreshToken);
    await user.setGoogleDriveTokens({
      accessToken: newTokens.accessToken,
      refreshToken: user.googleDriveRefreshToken,
      expiresIn: newTokens.expiresIn
    });
    accessToken = newTokens.accessToken;
  }
  
  const videos = await listUserVideos(accessToken, campaignId, parseInt(limit));
  
  // Paginate
  const paginatedVideos = videos.slice(skip, skip + parseInt(limit));
  
  res.json({
    success: true,
    data: {
      videos: paginatedVideos,
      isConnected: true,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: videos.length,
        hasMore: skip + parseInt(limit) < videos.length
      }
    }
  });
}));

/**
 * GET /api/drive/video/:fileId
 * Get video details by file ID
 */
router.get('/video/:fileId', authenticate, catchAsync(async (req, res) => {
  const { fileId } = req.params;
  
  const user = await User.findById(req.user._id).select('+googleDriveAccessToken +googleDriveRefreshToken +googleDriveTokenExpiresAt');
  
  if (!user.googleDriveConnected || !user.googleDriveAccessToken) {
    throw new AppError('Google Drive not connected', 400);
  }
  
  let accessToken = user.googleDriveAccessToken;
  
  if (user.needsGoogleDriveRefresh() && user.googleDriveRefreshToken) {
    const newTokens = await refreshAccessToken(user.googleDriveRefreshToken);
    await user.setGoogleDriveTokens({
      accessToken: newTokens.accessToken,
      refreshToken: user.googleDriveRefreshToken,
      expiresIn: newTokens.expiresIn
    });
    accessToken = newTokens.accessToken;
  }
  
  const { getFileMetadata } = require('../services/googleDriveService');
  const metadata = await getFileMetadata(accessToken, fileId);
  
  res.json({
    success: true,
    data: metadata
  });
}));

/**
 * DELETE /api/drive/video/:fileId
 * Delete a video from Google Drive (creator only)
 */
router.delete('/video/:fileId', authenticate, authorize('creator'), catchAsync(async (req, res) => {
  const { fileId } = req.params;
  const { campaignId } = req.body;
  
  const user = await User.findById(req.user._id).select('+googleDriveAccessToken +googleDriveRefreshToken +googleDriveTokenExpiresAt');
  
  if (!user.googleDriveConnected || !user.googleDriveAccessToken) {
    throw new AppError('Google Drive not connected', 400);
  }
  
  let accessToken = user.googleDriveAccessToken;
  
  if (user.needsGoogleDriveRefresh() && user.googleDriveRefreshToken) {
    const newTokens = await refreshAccessToken(user.googleDriveRefreshToken);
    await user.setGoogleDriveTokens({
      accessToken: newTokens.accessToken,
      refreshToken: user.googleDriveRefreshToken,
      expiresIn: newTokens.expiresIn
    });
    accessToken = newTokens.accessToken;
  }
  
  // Delete from Drive
  await deleteFile(accessToken, fileId);
  
  // Remove from campaign if campaignId provided
  if (campaignId) {
    const campaign = await Campaign.findOne({
      _id: campaignId,
      assignedCreatorId: req.user._id
    });
    
    if (campaign && campaign.driveFiles) {
      campaign.driveFiles = campaign.driveFiles.filter(f => f.fileId !== fileId);
      await campaign.save();
    }
  }
  
  logger.info(`Video ${fileId} deleted from Drive by user ${req.user._id}`);
  
  res.json({
    success: true,
    message: 'Video deleted successfully'
  });
}));

/**
 * GET /api/drive/quota
 * Get user's Drive storage quota
 */
router.get('/quota', authenticate, catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select('+googleDriveAccessToken +googleDriveRefreshToken +googleDriveTokenExpiresAt');
  
  if (!user.googleDriveConnected || !user.googleDriveAccessToken) {
    throw new AppError('Google Drive not connected', 400);
  }
  
  let accessToken = user.googleDriveAccessToken;
  
  if (user.needsGoogleDriveRefresh() && user.googleDriveRefreshToken) {
    const newTokens = await refreshAccessToken(user.googleDriveRefreshToken);
    await user.setGoogleDriveTokens({
      accessToken: newTokens.accessToken,
      refreshToken: user.googleDriveRefreshToken,
      expiresIn: newTokens.expiresIn
    });
    accessToken = newTokens.accessToken;
  }
  
  const quota = await getDriveQuota(accessToken);
  
  res.json({
    success: true,
    data: quota
  });
}));

module.exports = router;
