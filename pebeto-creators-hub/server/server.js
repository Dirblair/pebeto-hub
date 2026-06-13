/**
 * Pebeto Creator's Hub - Main Server Entry Point
 * 
 * Initializes Express server, database connection, Socket.IO,
 * and all API routes. Handles graceful shutdown and error management.
 * 
 * @module server
 */

// ============================================
// PRE-START CHECKS (Must run first)
// ============================================

// Log startup environment (sanitized)
console.log('='.repeat(60));
console.log('🚀 PEBBETO CREATOR\'S HUB SERVER STARTING');
console.log('='.repeat(60));
console.log(`📁 Directory: ${__dirname}`);
console.log(`📦 Node Version: ${process.version}`);
console.log(`🔧 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);

// Load environment configuration (this will validate critical vars)
try {
  // Import env config - this will throw if critical vars are missing in production
  const env = require('./config/env');
  
  console.log(`🔑 JWT_SECRET: ${env.jwtSecret ? '✅ Set' : '❌ Missing'}`);
  console.log(`🗄️ MONGO_URI: ${env.mongoUri ? '✅ Set' : '❌ Missing'}`);
  console.log(`🌐 PORT: ${env.port || '3000'}`);
  console.log('='.repeat(60));
  
  // Exit if critical configuration is missing in production
  if (env.isProduction) {
    if (!env.jwtSecret) {
      console.error('❌ CRITICAL: JWT_SECRET is required in production');
      process.exit(1);
    }
    if (!env.mongoUri) {
      console.error('❌ CRITICAL: MONGO_URI is required in production');
      console.error('💡 Please set MONGO_URI in your environment variables');
      process.exit(1);
    }
  }
} catch (error) {
  console.error('❌ Failed to load environment configuration:', error.message);
  console.error('💡 Please check your .env file or environment variables');
  process.exit(1);
}

// ============================================
// Module Imports
// ============================================

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const { Server } = require('socket.io');
const crypto = require('crypto');

// Config and Middleware imports
const env = require('./config/env');
const { connectDB, disconnectDB, getDatabaseHealth } = require('./config/db');
const { errorHandler, notFoundHandler, catchAsync } = require('./middleware/errorHandler');
// ============================================
// CHANGED: Now importing from middleware/feeService.js instead of services/feeService.js
// ============================================
const attachFeeService = require('./middleware/feeService');
const { initSockets } = require('./sockets');
const logger = require('./utils/logger');

// ============================================
// DEBUG: Check service imports (ADDED)
// ============================================
console.log('\n🔍 CHECKING SERVICE IMPORTS...');
console.log('='.repeat(40));

try { require('./services/walletService'); console.log('✅ walletService OK'); } 
catch(e) { console.error('❌ walletService FAILED:', e.message); process.exit(1); }

try { require('./services/withdrawalService'); console.log('✅ withdrawalService OK'); } 
catch(e) { console.error('❌ withdrawalService FAILED:', e.message); process.exit(1); }

try { require('./services/depositService'); console.log('✅ depositService OK'); } 
catch(e) { console.error('❌ depositService FAILED:', e.message); process.exit(1); }

try { require('./services/exchangeRateService'); console.log('✅ exchangeRateService OK'); } 
catch(e) { console.error('❌ exchangeRateService FAILED:', e.message); process.exit(1); }

console.log('='.repeat(40));
console.log('✅ All service imports verified!\n');

// ============================================
// Helper function to safely require routes
// ============================================

function safeRequire(modulePath, moduleName) {
  try {
    const module = require(modulePath);
    console.log(`✅ Loaded ${moduleName}`);
    return module;
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      console.warn(`⚠️ ${moduleName} not found - skipping (${modulePath})`);
      return null;
    }
    console.error(`❌ Error loading ${moduleName}:`, error.message);
    return null;
  }
}

// ============================================
// Route imports with error handling (non-critical routes are optional)
// ============================================

// Critical routes (must exist)
let authRoutes, walletRoutes, adminRoutes, campaignRoutes;

try {
  authRoutes = require('./routes/auth.routes');
  console.log('✅ Loaded auth.routes');
  
  walletRoutes = require('./routes/wallet.routes');
  console.log('✅ Loaded wallet.routes');
  
  adminRoutes = require('./routes/admin.routes');
  console.log('✅ Loaded admin.routes');
  
  campaignRoutes = require('./routes/campaign.routes');
  console.log('✅ Loaded campaign.routes');
} catch (error) {
  console.error('❌ Failed to load critical route module:', error.message);
  console.error('💡 Make sure all critical route files exist');
  process.exit(1);
}

// Optional routes (may not exist yet)
const communityRoutes = safeRequire('./routes/community.routes', 'community.routes');
const exchangeRoutes = safeRequire('./routes/exchange.routes', 'exchange.routes');
const withdrawalRoutes = safeRequire('./routes/withdrawal.routes', 'withdrawal.routes');

// ============================================
// NEW: Creator Routes Import
// ============================================
const creatorRoutes = safeRequire('./routes/creator.routes', 'creator.routes');

// ============================================
// Request ID Middleware
// ============================================

/**
 * Generate unique request ID for each request
 * Used for tracing and logging
 */
const requestIdMiddleware = (req, res, next) => {
  const requestId = crypto.randomBytes(8).toString('hex');
  req.id = requestId;
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
};

// ============================================
// Logging Middleware
// ============================================

/**
 * Custom morgan format with request ID and user info
 */
morgan.token('request-id', (req) => req.id || '-');
morgan.token('user-id', (req) => req.user?._id || '-');
morgan.token('user-role', (req) => req.user?.role || '-');

const morganFormat = env.isProduction
  ? ':remote-addr - :request-id [:date[clf]] ":method :url" :status :response-time ms - :res[content-length] :user-id :user-role'
  : 'dev';

// ============================================
// CORS Configuration (FIXED)
// ============================================

const corsOptions = {
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl)
    if (!origin) {
      return callback(null, true);
    }
    
    // List of allowed origins (add your frontend URLs here)
    const allowedOrigins = [
      'https://pebeto-new.onrender.com',
      'https://pebeto-hub-1-v7pq.onrender.com',
      'https://pebeto-hub-1.onrender.com',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500'
    ];
    
    // Allow any .onrender.com subdomain
    if (origin.includes('.onrender.com')) {
      console.log(`✅ CORS allowed: ${origin}`);
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      console.log(`✅ CORS allowed: ${origin}`);
      return callback(null, true);
    }
    
    // For production, also check env.clientOrigins
    if (env.clientOrigins && env.clientOrigins.includes(origin)) {
      console.log(`✅ CORS allowed (env): ${origin}`);
      return callback(null, true);
    }
    
    // If corsAllowAll is true, allow everything
    if (env.corsAllowAll) {
      console.log(`⚠️ CORS allowed all: ${origin}`);
      return callback(null, true);
    }
    
    console.log(`🔒 CORS blocked: ${origin}`);
    callback(new Error(`CORS policy does not allow origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'Accept'],
  exposedHeaders: ['X-Request-ID'],
  maxAge: 86400 // 24 hours
};

// ============================================
// Security Headers Configuration
// ============================================

const helmetConfig = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net'],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", 'https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net', 'https://cdn.socket.io', 'https://fonts.googleapis.com', 'https://www.tiktok.com', 'https://www.youtube.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'https://ui-avatars.com', 'https://*.cloudinary.com', 'https://*.tiktok.com', 'https://*.ytimg.com'],
      connectSrc: ["'self'", 'https://*.safaricom.co.ke', 'https://api-m.paypal.com', 'https://api-m.sandbox.paypal.com', 'https://*.tiktok.com', 'https://*.youtube.com'],
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.tiktok.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: env.isProduction ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
};

// ============================================
// Bootstrap Function
// ============================================

async function bootstrap() {
  const startTime = Date.now();
  
  try {
    // 1. Database Connection (Critical first step)
    logger.info('Connecting to database...');
    
    if (!env.mongoUri) {
      throw new Error('MONGO_URI is not configured. Please check your environment variables.');
    }
    
    await connectDB(env.mongoUri, env.mongoOptions);
    logger.info('✅ Database connection established.');
    
    // 2. Create Express App
    const app = express();
    const server = http.createServer(app);
    
    // 3. Socket.IO Setup
    const io = new Server(server, {
      cors: {
        origin: env.clientOrigins.length > 0 ? env.clientOrigins : true,
        credentials: true,
        methods: ['GET', 'POST']
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000,
    });
    
    // 4. Initialize Sockets
    initSockets(io);
    app.set('io', io);
    
    // 5. Request ID Middleware (first!)
    app.use(requestIdMiddleware);
    
    // 6. Logging Middleware
    if (!env.isTest) {
      app.use(morgan(morganFormat, {
        stream: {
          write: (message) => logger.info(message.trim())
        }
      }));
    }
    
    // 7. Security and Standard Middleware
    app.use(helmet(helmetConfig));
    app.use(cors(corsOptions));
    app.use(compression());
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    
    // 8. Fee Service Middleware
    app.use(attachFeeService);
    
    // 9. Health Check Endpoint (before auth)
    app.get('/api/health', (req, res) => {
      const dbHealth = getDatabaseHealth();
      res.json({
        success: true,
        status: 'ok',
        service: 'pebeto-creators-hub',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        requestId: req.id,
        database: dbHealth,
        environment: env.nodeEnv,
        version: '1.0.0'
      });
    });
    
    // 10. API Routes
    logger.info('Mounting routes...');
    
    // Auth routes (public)
    app.use('/api/auth', authRoutes);
    
    // Wallet routes (mix of public and protected)
    if (walletRoutes && walletRoutes.publicRouter) {
      app.use('/api/wallet', walletRoutes.publicRouter);
    }
    if (walletRoutes && walletRoutes.router) {
      app.use('/api/wallet', walletRoutes.router);
    }
    
    // Admin routes (protected)
    app.use('/api/admin', adminRoutes);
    
    // Campaign routes
    app.use('/api/campaigns', campaignRoutes);
    
    // ============================================
    // NEW: Creator Routes (Social Media Links)
    // ============================================
    if (creatorRoutes) {
      app.use('/api', creatorRoutes);
      console.log('✅ Mounted creator routes (/api/creators, /api/creator/social-links)');
    } else {
      console.log('⚠️ Creator routes skipped - file not found');
    }
    
    // Community routes (optional)
    if (communityRoutes) {
      app.use('/api/community', communityRoutes);
      console.log('✅ Mounted community routes');
    } else {
      console.log('⚠️ Community routes skipped - file not found');
    }
    
    // Exchange rate routes (optional)
    if (exchangeRoutes) {
      app.use('/api/exchange', exchangeRoutes);
      console.log('✅ Mounted exchange routes');
    } else {
      console.log('⚠️ Exchange routes skipped - file not found');
    }
    
    // Withdrawal routes (optional)
    if (withdrawalRoutes) {
      app.use('/api/withdrawals', withdrawalRoutes);
      console.log('✅ Mounted withdrawal routes');
    } else {
      console.log('⚠️ Withdrawal routes skipped - file not found');
    }
    
    // 11. Static Files (Client UI)
    // Serve HTML files from root directory
    app.use(express.static(path.join(__dirname, '..'), {
      index: false, // Don't serve index.html automatically
      maxAge: env.isProduction ? '1d' : 0
    }));
    
    // Serve static assets from public directory if exists
    const publicPath = path.join(__dirname, '..', 'public');
    app.use('/public', express.static(publicPath, {
      maxAge: env.isProduction ? '30d' : 0
    }));
    
    // 12. SPA Fallback (for client-side routing)
    // But exclude API routes
    app.get('*', (req, res, next) => {
      // Skip API routes
      if (req.path.startsWith('/api/')) {
        return next();
      }
      // Serve index.html for all other routes (SPA support)
      const indexPath = path.join(__dirname, '..', 'index.html');
      res.sendFile(indexPath, (err) => {
        if (err && err.code === 'ENOENT') {
          // If index.html doesn't exist, send a simple message
          res.status(200).send(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Pebeto Creator's Hub</title>
              <style>
                body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
                h1 { color: #333; }
                .status { background: #e8f5e9; padding: 15px; border-radius: 8px; border-left: 4px solid #4caf50; }
                .endpoint { background: #f5f5f5; padding: 10px; border-radius: 4px; font-family: monospace; }
              </style>
            </head>
            <body>
              <h1>🚀 Pebeto Creator's Hub API</h1>
              <div class="status">
                ✅ API is running in ${env.nodeEnv} mode
              </div>
              <h2>Available Endpoints:</h2>
              <ul>
                <li><a href="/api/health">GET /api/health</a> - Health check</li>
                <li><a href="/api/creators">GET /api/creators</a> - View all creators</li>
                <li>POST /api/auth/register - User registration</li>
                <li>POST /api/auth/login - User login</li>
              </ul>
              <p>For full API documentation, please refer to the API docs.</p>
            </body>
            </html>
          `);
        } else if (err) {
          next(err);
        }
      });
    });
    
    // 13. 404 Handler (for unmatched routes)
    app.use(notFoundHandler);
    
    // 14. Global Error Handler (last!)
    app.use(errorHandler);
    
    // 15. Start Server
    const PORT = env.port;
    const HOST = env.host;
    
    server.listen(PORT, HOST, () => {
      const startupTime = Date.now() - startTime;
      console.log('='.repeat(60));
      logger.info(`🚀 Pebeto Creator's Hub running on http://${HOST}:${PORT}`);
      logger.info(`   Environment: ${env.nodeEnv}`);
      logger.info(`   Startup time: ${startupTime}ms`);
      logger.info(`   API Health: http://${HOST}:${PORT}/api/health`);
      logger.info(`   Creators API: http://${HOST}:${PORT}/api/creators`);
      console.log('='.repeat(60));
      
      // Log configuration summary (sanitized)
      if (env.logConfigSummary) {
        env.logConfigSummary();
      }
    });
    
    // 16. Graceful Shutdown
    setupGracefulShutdown(server);
    
    return { app, server, io };
    
  } catch (error) {
    console.error('='.repeat(60));
    logger.error('🚨 CRITICAL STARTUP ERROR:');
    console.error(error);
    console.error('='.repeat(60));
    
    // Provide helpful messages for common errors
    if (error.message.includes('MONGO_URI')) {
      console.error('\n💡 Database Configuration Error:');
      console.error('   Please ensure MONGO_URI is set in your environment variables');
      console.error('   Example: MONGO_URI=mongodb://localhost:27017/pebeto');
      console.error('   Or use MongoDB Atlas: mongodb+srv://<user>:<password>@cluster.mongodb.net/pebeto');
    } else if (error.message.includes('JWT_SECRET')) {
      console.error('\n💡 JWT Configuration Error:');
      console.error('   Please set JWT_SECRET in your environment variables');
      console.error('   Generate a secure key using: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
    }
    
    process.exit(1);
  }
}

// ============================================
// Graceful Shutdown Handler
// ============================================

let isShuttingDown = false;

/**
 * Setup graceful shutdown handlers for SIGTERM and SIGINT
 * @param {http.Server} server - HTTP server instance
 */
function setupGracefulShutdown(server) {
  const shutdown = async (signal) => {
    if (isShuttingDown) {
      logger.warn(`Already shutting down, ignoring ${signal}`);
      return;
    }
    
    isShuttingDown = true;
    console.log(`\n⚠️ Received ${signal}. Starting graceful shutdown...`);
    logger.warn(`Received ${signal}. Starting graceful shutdown...`);
    
    const shutdownTimeout = setTimeout(() => {
      console.error('❌ Forced shutdown due to timeout');
      logger.error('Forced shutdown due to timeout');
      process.exit(1);
    }, 30000); // 30 seconds timeout
    
    try {
      // Stop accepting new connections
      await new Promise((resolve) => {
        server.close(resolve);
      });
      console.log('✅ HTTP server closed');
      logger.info('HTTP server closed');
      
      // Close database connection
      await disconnectDB();
      console.log('✅ Database connection closed');
      logger.info('Database connection closed');
      
      // Clear timeout
      clearTimeout(shutdownTimeout);
      
      console.log('✅ Graceful shutdown completed');
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      console.error('❌ Error during graceful shutdown:', error);
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  };
  
  // Handle process termination signals
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  
  // Handle uncaught exceptions (as a last resort)
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    logger.error('Uncaught Exception:', error);
    // Give it a moment to log before shutting down
    setTimeout(() => {
      shutdown('uncaughtException');
    }, 1000);
  });
  
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise);
    console.error('   Reason:', reason);
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit immediately in development, but log clearly
    if (env.isProduction) {
      setTimeout(() => {
        shutdown('unhandledRejection');
      }, 1000);
    }
  });
}

// ============================================
// Start Application
// ============================================

// Handle startup errors outside bootstrap
bootstrap().catch((err) => {
  console.error('='.repeat(60));
  console.error('--- FATAL STARTUP ERROR ---');
  console.error(err);
  console.error('='.repeat(60));
  
  // Provide helpful messages for common errors
  if (err.code === 'ECONNREFUSED') {
    console.error('\n💡 Database connection refused. Please check:');
    console.error('   1. MongoDB is running (mongod)');
    console.error('   2. MONGO_URI is correct');
    console.error('   3. Network/firewall allows the connection');
  } else if (err.name === 'MongoNetworkError') {
    console.error('\n💡 MongoDB network error. Please check:');
    console.error('   1. Internet connection (for Atlas)');
    console.error('   2. IP whitelist in MongoDB Atlas');
    console.error('   3. Username/password are correct');
  }
  
  process.exit(1);
});

// ============================================
// Exports (for testing)
// ============================================

module.exports = { bootstrap };
