/**
 * Pebeto Creator's Hub - Production Server
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

console.log('='.repeat(60));
console.log('🚀 PEBBETO CREATOR\'S HUB SERVER');
console.log('='.repeat(60));

// ============================================
// CLOUDINARY CONFIG
// ============================================
console.log('\n☁️ CLOUDINARY:');
console.log(`  CLOUD_NAME: ${process.env.CLOUDINARY_CLOUD_NAME || '❌ MISSING'}`);
console.log(`  API_KEY: ${process.env.CLOUDINARY_API_KEY ? '✅ SET' : '❌ MISSING'}`);
console.log(`  API_SECRET: ${process.env.CLOUDINARY_API_SECRET ? '✅ SET' : '❌ MISSING'}`);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ============================================
// MULTER
// ============================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================
// ROUTES
// ============================================

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/community/test', (req, res) => {
  res.json({
    success: true,
    message: '✅ Community routes work!',
    cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME
  });
});

// ============================================
// UPLOAD ROUTE
// ============================================
app.post('/api/community/posts', upload.single('media'), async (req, res) => {
  try {
    console.log('📤 Upload:', req.file ? req.file.originalname : 'NO FILE');

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      return res.status(500).json({
        success: false,
        message: 'Cloudinary not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.'
      });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: 'auto', folder: 'pebeto/community' },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });

    res.status(201).json({
      success: true,
      message: '✅ Upload successful!',
      data: {
        mediaUrl: result.secure_url,
        publicId: result.public_id,
        caption: req.body.caption || '',
        category: req.body.category || 'Other'
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

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🚀 Pebeto Creator\'s Hub API',
    cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME,
    endpoints: {
      health: '/api/health',
      test: '/api/community/test',
      upload: 'POST /api/community/posts'
    }
  });
});

// ============================================
// START
// ============================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 SERVER RUNNING!');
  console.log('='.repeat(60));
  console.log(`📡 Port: ${PORT}`);
  console.log(`☁️ Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? '✅ Connected' : '❌ Not configured'}`);
  console.log('='.repeat(60));
});

module.exports = app;
