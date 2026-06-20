const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Cloudinary Config
console.log('☁️ Cloudinary Check:');
console.log('  CLOUDINARY_CLOUD_NAME:', process.env.CLOUDINARY_CLOUD_NAME || '❌ MISSING');
console.log('  CLOUDINARY_API_KEY:', process.env.CLOUDINARY_API_KEY ? '✅ SET' : '❌ MISSING');
console.log('  CLOUDINARY_API_SECRET:', process.env.CLOUDINARY_API_SECRET ? '✅ SET' : '❌ MISSING');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ============================================
// ROUTES - All Working
// ============================================

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    message: '🚀 Server is running!',
    cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME,
    timestamp: new Date().toISOString()
  });
});

// Community Test
app.get('/api/community/test', (req, res) => {
  res.json({
    success: true,
    message: '✅ Community routes work!',
    cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME,
    timestamp: new Date().toISOString()
  });
});

// ✅ UPLOAD ROUTE - This is what you need
app.post('/api/community/posts', upload.single('media'), async (req, res) => {
  try {
    console.log('📤 Upload Request:');
    console.log('  File:', req.file ? `${req.file.originalname} (${req.file.size} bytes)` : '❌ NO FILE');
    console.log('  Body:', req.body);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No media file uploaded'
      });
    }

    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      return res.status(500).json({
        success: false,
        message: 'Cloudinary not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET to Render env vars.'
      });
    }

    const file = req.file;
    const { caption = '', category = 'Other' } = req.body;

    // Upload to Cloudinary
    console.log('☁️ Uploading to Cloudinary...');
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: 'auto', folder: 'pebeto/community' },
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

    res.status(201).json({
      success: true,
      message: '✅ Upload successful!',
      data: {
        mediaUrl: result.secure_url,
        publicId: result.public_id,
        caption: caption,
        category: category
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

// Echo Route (for testing)
app.post('/api/community/echo', (req, res) => {
  res.json({
    success: true,
    message: '✅ Echo works!',
    received: req.body
  });
});

// Root
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🚀 Pebeto Creator\'s Hub API',
    cloudinaryConfigured: !!process.env.CLOUDINARY_CLOUD_NAME,
    endpoints: {
      health: '/api/health',
      test: '/api/community/test',
      upload: 'POST /api/community/posts',
      echo: 'POST /api/community/echo'
    }
  });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log('🚀 SERVER RUNNING!');
  console.log('='.repeat(60));
  console.log(`📡 Port: ${PORT}`);
  console.log(`☁️ Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🔗 Health: /api/health`);
  console.log(`🔗 Upload: POST /api/community/posts`);
  console.log('='.repeat(60));
});

module.exports = app;
