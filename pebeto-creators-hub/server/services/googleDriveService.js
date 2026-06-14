/**
 * Google Drive Service for Pebeto Creator's Hub
 * 
 * Handles Google Drive OAuth and file operations:
 * - OAuth authentication flow
 * - Upload videos to creator's own Google Drive
 * - Generate view-only shareable links
 * - Refresh expired access tokens
 * - Get file metadata and streaming URLs
 * 
 * @module services/googleDriveService
 */

const { google } = require('googleapis');
const { Readable } = require('stream');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

// ============================================
// Constants
// ============================================

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata.readonly'
];

const DEFAULT_MIME_TYPES = {
  VIDEO: 'video/mp4',
  IMAGE: 'image/jpeg',
  DOCUMENT: 'application/pdf'
};

const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB (Google Drive limit for free tier)

// ============================================
// OAuth Configuration
// ============================================

/**
 * Get OAuth2 client instance
 * @param {string} accessToken - Optional existing access token
 * @returns {google.auth.OAuth2} OAuth2 client
 */
function getOAuthClient(accessToken = null) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI_DEV
  );
  
  if (accessToken) {
    oauth2Client.setCredentials({ access_token: accessToken });
  }
  
  return oauth2Client;
}

/**
 * Generate OAuth URL for user authorization
 * @param {string} userId - User ID to store in state parameter
 * @returns {string} Authorization URL
 */
function generateAuthUrl(userId) {
  const oauth2Client = getOAuthClient();
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    include_granted_scopes: true,
    state: userId,
    prompt: 'consent' // Force to get refresh token
  });
  
  return authUrl;
}

/**
 * Exchange authorization code for tokens
 * @param {string} code - Authorization code from OAuth callback
 * @returns {Promise<Object>} Token object
 */
async function exchangeCodeForTokens(code) {
  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expiry_date ? (tokens.expiry_date - Date.now()) / 1000 : 3600,
      scope: tokens.scope
    };
  } catch (error) {
    logger.error('Google OAuth token exchange failed:', error.message);
    throw new AppError('Failed to authenticate with Google Drive', 500);
  }
}

/**
 * Refresh access token using refresh token
 * @param {string} refreshToken - Refresh token
 * @returns {Promise<Object>} New tokens
 */
async function refreshAccessToken(refreshToken) {
  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    
    const { credentials } = await oauth2Client.refreshAccessToken();
    
    return {
      accessToken: credentials.access_token,
      expiresIn: credentials.expiry_date ? (credentials.expiry_date - Date.now()) / 1000 : 3600
    };
  } catch (error) {
    logger.error('Google Drive token refresh failed:', error.message);
    throw new AppError('Failed to refresh Google Drive access. Please reconnect your Google account.', 401);
  }
}

// ============================================
// Drive Operations
// ============================================

/**
 * Get authenticated Drive instance
 * @param {string} accessToken - Access token
 * @returns {google.drive_v3.Drive} Drive instance
 */
function getDriveInstance(accessToken) {
  const oauth2Client = getOAuthClient(accessToken);
  return google.drive({ version: 'v3', auth: oauth2Client });
}

/**
 * Create a folder in Google Drive (or get existing)
 * @param {string} accessToken - Access token
 * @param {string} folderName - Name of the folder
 * @param {string} parentFolderId - Optional parent folder ID
 * @returns {Promise<string>} Folder ID
 */
async function createOrGetFolder(accessToken, folderName, parentFolderId = null) {
  const drive = getDriveInstance(accessToken);
  
  // Search for existing folder
  const query = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    pageSize: 1
  });
  
  if (response.data.files && response.data.files.length > 0) {
    return response.data.files[0].id;
  }
  
  // Create new folder
  const fileMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder'
  };
  
  if (parentFolderId) {
    fileMetadata.parents = [parentFolderId];
  }
  
  const folder = await drive.files.create({
    resource: fileMetadata,
    fields: 'id'
  });
  
  return folder.data.id;
}

/**
 * Upload a video file to Google Drive
 * @param {Object} params - Upload parameters
 * @param {string} params.accessToken - User's access token
 * @param {Buffer|Stream} params.fileBuffer - File buffer or stream
 * @param {string} params.fileName - Original file name
 * @param {string} params.mimeType - MIME type of the file
 * @param {string} params.campaignId - Campaign ID for folder organization
 * @returns {Promise<Object>} Upload result with file ID and web view link
 */
async function uploadVideoToDrive({
  accessToken,
  fileBuffer,
  fileName,
  mimeType = 'video/mp4',
  campaignId
}) {
  try {
    const drive = getDriveInstance(accessToken);
    
    // Create folder structure: Pebeto/Campaigns/{campaignId}
    const pebetoFolderId = await createOrGetFolder(accessToken, 'Pebeto');
    const campaignsFolderId = await createOrGetFolder(accessToken, 'Campaigns', pebetoFolderId);
    const campaignFolderId = await createOrGetFolder(accessToken, `Campaign_${campaignId}`, campaignsFolderId);
    
    // Prepare file metadata
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.\-_,()]/g, '_');
    const fileMetadata = {
      name: `${Date.now()}_${sanitizedFileName}`,
      parents: [campaignFolderId],
      description: `Uploaded from Pebeto Creator Hub for campaign ${campaignId}`
    };
    
    // Convert buffer to stream if needed
    const media = {
      mimeType: mimeType,
      body: fileBuffer instanceof Buffer ? bufferToStream(fileBuffer) : fileBuffer
    };
    
    // Upload file
    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, size, mimeType, webViewLink, createdTime'
    });
    
    // Make file sharable with view-only link (anyone with link can view)
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
        allowFileDiscovery: false
      }
    });
    
    // Get the sharable link
    const webViewLink = file.data.webViewLink || `https://drive.google.com/file/d/${file.data.id}/view`;
    
    logger.info('Video uploaded to Google Drive', {
      fileId: file.data.id,
      campaignId,
      fileName: sanitizedFileName,
      size: file.data.size
    });
    
    return {
      success: true,
      fileId: file.data.id,
      fileUrl: webViewLink,
      embedUrl: `https://drive.google.com/file/d/${file.data.id}/preview`,
      fileName: file.data.name,
      size: file.data.size,
      mimeType: file.data.mimeType,
      createdAt: file.data.createdTime
    };
    
  } catch (error) {
    logger.error('Google Drive upload failed:', error.message);
    throw new AppError(`Failed to upload video to Google Drive: ${error.message}`, 500);
  }
}

/**
 * Upload video from a URL to Google Drive
 * @param {Object} params - Upload parameters
 * @param {string} params.accessToken - User's access token
 * @param {string} params.videoUrl - URL of the video to upload
 * @param {string} params.fileName - Desired file name
 * @param {string} params.campaignId - Campaign ID
 * @returns {Promise<Object>} Upload result
 */
async function uploadVideoFromUrl({
  accessToken,
  videoUrl,
  fileName,
  campaignId
}) {
  try {
    const axios = require('axios');
    
    // Download video from URL
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      timeout: 120000 // 2 minute timeout
    });
    
    return uploadVideoToDrive({
      accessToken,
      fileBuffer: response.data,
      fileName,
      mimeType: response.headers['content-type'] || 'video/mp4',
      campaignId
    });
    
  } catch (error) {
    logger.error('Failed to download video from URL:', error.message);
    throw new AppError('Failed to download video from provided URL', 500);
  }
}

/**
 * Get file metadata from Google Drive
 * @param {string} accessToken - Access token
 * @param {string} fileId - Google Drive file ID
 * @returns {Promise<Object>} File metadata
 */
async function getFileMetadata(accessToken, fileId) {
  try {
    const drive = getDriveInstance(accessToken);
    const file = await drive.files.get({
      fileId: fileId,
      fields: 'id, name, size, mimeType, webViewLink, createdTime, modifiedTime'
    });
    
    return {
      fileId: file.data.id,
      fileName: file.data.name,
      size: file.data.size,
      mimeType: file.data.mimeType,
      fileUrl: file.data.webViewLink,
      embedUrl: `https://drive.google.com/file/d/${file.data.id}/preview`,
      createdAt: file.data.createdTime,
      modifiedAt: file.data.modifiedTime
    };
  } catch (error) {
    logger.error('Failed to get file metadata:', error.message);
    throw new AppError('Failed to retrieve video information', 500);
  }
}

/**
 * Delete a file from Google Drive
 * @param {string} accessToken - Access token
 * @param {string} fileId - Google Drive file ID
 * @returns {Promise<boolean>}
 */
async function deleteFile(accessToken, fileId) {
  try {
    const drive = getDriveInstance(accessToken);
    await drive.files.delete({ fileId });
    
    logger.info('File deleted from Google Drive', { fileId });
    return true;
    
  } catch (error) {
    logger.error('Failed to delete file:', error.message);
    throw new AppError('Failed to delete video from Google Drive', 500);
  }
}

/**
 * List user's files in Pebeto folder
 * @param {string} accessToken - Access token
 * @param {string} campaignId - Optional campaign ID filter
 * @param {number} limit - Max files to return
 * @returns {Promise<Array>} List of files
 */
async function listUserVideos(accessToken, campaignId = null, limit = 20) {
  try {
    const drive = getDriveInstance(accessToken);
    
    const pebetoFolderId = await createOrGetFolder(accessToken, 'Pebeto');
    
    let query = `'${pebetoFolderId}' in parents and trashed = false`;
    
    if (campaignId) {
      const campaignsFolderId = await createOrGetFolder(accessToken, 'Campaigns', pebetoFolderId);
      const campaignFolderId = await createOrGetFolder(accessToken, `Campaign_${campaignId}`, campaignsFolderId);
      query = `'${campaignFolderId}' in parents and trashed = false`;
    }
    
    const response = await drive.files.list({
      q: query,
      fields: 'files(id, name, size, mimeType, webViewLink, createdTime)',
      pageSize: limit,
      orderBy: 'createdTime desc'
    });
    
    return (response.data.files || []).map(file => ({
      fileId: file.id,
      fileName: file.name,
      size: file.size,
      mimeType: file.mimeType,
      fileUrl: file.webViewLink,
      embedUrl: `https://drive.google.com/file/d/${file.id}/preview`,
      createdAt: file.createdTime
    }));
    
  } catch (error) {
    logger.error('Failed to list files:', error.message);
    throw new AppError('Failed to list videos', 500);
  }
}

/**
 * Check if user has valid Google Drive connection
 * @param {string} accessToken - Access token
 * @returns {Promise<boolean>}
 */
async function verifyDriveConnection(accessToken) {
  try {
    const drive = getDriveInstance(accessToken);
    await drive.about.get({ fields: 'user' });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get user's Drive quota information
 * @param {string} accessToken - Access token
 * @returns {Promise<Object>} Quota info
 */
async function getDriveQuota(accessToken) {
  try {
    const drive = getDriveInstance(accessToken);
    const about = await drive.about.get({
      fields: 'storageQuota'
    });
    
    const quota = about.data.storageQuota;
    const limit = parseInt(quota.limit) || 15 * 1024 * 1024 * 1024; // 15GB default
    const usage = parseInt(quota.usage) || 0;
    
    return {
      totalBytes: limit,
      usedBytes: usage,
      freeBytes: limit - usage,
      totalGB: (limit / (1024 * 1024 * 1024)).toFixed(2),
      usedGB: (usage / (1024 * 1024 * 1024)).toFixed(2),
      freeGB: ((limit - usage) / (1024 * 1024 * 1024)).toFixed(2),
      percentageUsed: ((usage / limit) * 100).toFixed(1)
    };
  } catch (error) {
    logger.error('Failed to get quota:', error.message);
    return null;
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Convert Buffer to Readable Stream
 * @param {Buffer} buffer - Buffer to convert
 * @returns {Readable} Readable stream
 */
function bufferToStream(buffer) {
  const readable = new Readable();
  readable._read = () => {};
  readable.push(buffer);
  readable.push(null);
  return readable;
}

/**
 * Validate file size
 * @param {number} size - File size in bytes
 * @throws {AppError} If file is too large
 */
function validateFileSize(size) {
  if (size > MAX_FILE_SIZE) {
    throw new AppError(`File size exceeds maximum allowed (${MAX_FILE_SIZE / (1024 * 1024 * 1024)}GB)`, 400);
  }
}

/**
 * Validate MIME type
 * @param {string} mimeType - File MIME type
 * @returns {boolean}
 */
function isValidVideoMimeType(mimeType) {
  const validTypes = [
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/x-msvideo',
    'video/webm',
    'video/avi'
  ];
  return validTypes.includes(mimeType);
}

// ============================================
// Exports
// ============================================

module.exports = {
  // OAuth
  generateAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getOAuthClient,
  
  // Drive Operations
  uploadVideoToDrive,
  uploadVideoFromUrl,
  getFileMetadata,
  deleteFile,
  listUserVideos,
  verifyDriveConnection,
  getDriveQuota,
  createOrGetFolder,
  
  // Utilities
  bufferToStream,
  validateFileSize,
  isValidVideoMimeType,
  
  // Constants
  SCOPES,
  MAX_FILE_SIZE
};
