/**
 * Pebeto Creator's Hub - Production Server
 * Complete working server with Cloudinary uploads
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

console.log('='.repeat(60));
console.log('🚀 PEBBETO CREATOR\'S HUB SERVER v3.0');
console.log('='.repeat(60));
console.log(`📡 PORT: ${PORT}`);
console.log(`🌍 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);

// ============================================
// CLOUDINARY CONFIG
// ============================================
console.log('\n☁️ CLOUDINARY STATUS:');
const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

console.log(`  CLOUDINARY_CLOUD_NAME: ${cloudName ? '✅ ' + cloudName : '❌ MISSING'}`);
console.log(`  CLOUDINARY_API_KEY: ${apiKey ? '✅ SET' : '❌ MISSING'}`);
console.log(`  CLOUDINARY_API_SECRET: ${apiSecret ? '✅ SET' : '❌ MISSING'}`);

if (!cloudName || !apiKey || !apiSecret) {
  console.log('\n⚠️ WARNING: Cloudinary not configured. Uploads will fail.');
  console.log('   Add these environment variables in Render dashboard:');
  console.log('   - CLOUDINARY_CLOUD_NAME');
  console.log('   - CLOUDINARY_API_KEY');
  console.log('   - CLOUDINARY_API_SECRET');
}

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret
});

// ============================================
// MULTER CONFIG
// ============================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp',
                     'video/mp4', 'video/quicktime', 'video/x-msvideo',
                     'audio/mpeg', 'audio/wav', 'audio/ogg'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Upload image, video, or audio.'));
    }
  }
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================
// ROUTES
// ============================================

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'pebeto-creators-hub',
    cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '3.0.0'
  });
});

// Community Test
app.get('/api/community/test', (req, res) => {
  res.json({
    success: true,
    message: '✅ Community routes are working!',
    cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME,
    cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || 'Not set',
    timestamp: new Date().toISOString()
  });
});

// ============================================
// UPLOAD ROUTE - THE ONE YOU NEED
// ============================================
app.post('/api/community/posts', upload.single('media'), async (req, res) => {
  console.log('\n📤 ===== UPLOAD REQUEST =====');
  console.log(`📁 File: ${req.file ? req.file.originalname : 'NO FILE'}`);
  console.log(`📏 Size: ${req.file ? req.file.size + ' bytes' : 'N/A'}`);
  console.log(`📋 Type: ${req.file ? req.file.mimetype : 'N/A'}`);

  try {
    // 1. Check file
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No media file uploaded'
      });
    }

    // 2. Check Cloudinary
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      return res.status(500).json({
        success: false,
        message: 'Cloudinary not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET to environment variables.'
      });
    }

    const file = req.file;
    const { caption = '', category = 'Other', tags = '' } = req.body;

    // 3. Determine media type
    let mediaType = 'video';
    if (file.mimetype.startsWith('image/')) mediaType = 'image';
    else if (file.mimetype.startsWith('audio/')) mediaType = 'audio';

    console.log(`📹 Media type: ${mediaType}`);
    console.log('☁️ Uploading to Cloudinary...');

    // 4. Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'auto',
          folder: 'pebeto/community',
          use_filename: true,
          unique_filename: true
        },
        (error, result) => {
          if (error) {
            console.error('❌ Cloudinary error:', error);
            reject(error);
          } else {
            console.log('✅ Cloudinary success:', result.public_id);
            resolve(result);
          }
        }
      );
      streamifier.createReadStream(file.buffer).pipe(stream);
    });

    // 5. Generate thumbnail for video
    let thumbnailUrl = result.secure_url;
    if (mediaType === 'video') {
      thumbnailUrl = cloudinary.url(result.public_id, {
        resource_type: 'video',
        format: 'jpg',
        transformation: [{ start_offset: '2' }, { width: 720, height: 720, crop: 'limit' }]
      });
    }

    // 6. Parse tags
    const tagArray = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];

    // 7. Response
    res.status(201).json({
      success: true,
      message: '✅ Upload successful!',
      data: {
        mediaUrl: result.secure_url,
        thumbnailUrl: thumbnailUrl,
        mediaType: mediaType,
        publicId: result.public_id,
        caption: caption || '',
        category: category || 'Other',
        tags: tagArray,
        duration: result.duration || 0,
        format: result.format || 'unknown',
        bytes: result.bytes || file.size,
        createdAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Upload failed: ' + error.message
    });
  }
});

// ============================================
// ECHO ROUTE
// ============================================
app.post('/api/community/echo', (req, res) => {
  res.json({
    success: true,
    message: '✅ Echo works!',
    received: req.body,
    timestamp: new Date().toISOString()
  });
});

// ============================================
// GET POSTS (placeholder)
// ============================================
app.get('/api/community/posts', (req, res) => {
  res.json({
    success: true,
    message: '📋 Posts endpoint - Add database integration',
    posts: [],
    pagination: { limit: 20, skip: 0, hasMore: false }
  });
});

app.get('/api/community/posts/:postId', (req, res) => {
  res.json({
    success: true,
    message: `📋 Post ${req.params.postId}`,
    post: {
      id: req.params.postId,
      caption: 'Sample post',
      mediaUrl: 'https://via.placeholder.com/400',
      mediaType: 'image'
    }
  });
});

// ============================================
// ROOT
// ============================================
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🚀 Pebeto Creator\'s Hub API',
    version: '3.0.0',
    cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME,
    endpoints: {
      health: 'GET /api/health',
      test: 'GET /api/community/test',
      upload: 'POST /api/community/posts (multipart/form-data with "media" field)',
      echo: 'POST /api/community/echo'
    }
  });
});

// ============================================
// 404 HANDLER
// ============================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `❌ Route not found: ${req.method} ${req.url}`,
    availableEndpoints: [
      'GET /',
      'GET /api/health',
      'GET /api/community/test',
      'POST /api/community/posts',
      'GET /api/community/posts',
      'GET /api/community/posts/:postId',
      'POST /api/community/echo'
    ]
  });
});

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 SERVER STARTED SUCCESSFULLY!');
  console.log('='.repeat(60));
  console.log(`📡 Port: ${PORT}`);
  console.log(`☁️ Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? '✅ Connected' : '❌ Not configured'}`);
  console.log(`🔗 Health: http://localhost:${PORT}/api/health`);
  console.log(`🔗 Test: http://localhost:${PORT}/api/community/test`);
  console.log(`🔗 Upload: POST http://localhost:${PORT}/api/community/posts`);
  console.log('='.repeat(60) + '\n');
});

module.exports = app;
