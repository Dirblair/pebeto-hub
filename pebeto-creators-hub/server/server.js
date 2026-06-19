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
const cron = require('node-cron');

// Config and Middleware imports
const env = require('./config/env');
const { connectDB, disconnectDB, getDatabaseHealth } = require('./config/db');
const { errorHandler, notFoundHandler, catchAsync } = require('./middleware/errorHandler');
const attachFeeService = require('./middleware/feeService');
const { initSockets } = require('./sockets');
const logger = require('./utils/logger');

// ============================================
// DEBUG: Check service imports
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
// Route imports with error handling
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

// Optional routes
const communityRoutes = safeRequire('./routes/community.routes', 'community.routes');
const exchangeRoutes = safeRequire('./routes/exchange.routes', 'exchange.routes');
const withdrawalRoutes = safeRequire('./routes/withdrawal.routes', 'withdrawal.routes');
const creatorRoutes = safeRequire('./routes/creator.routes', 'creator.routes');
const userRoutes = safeRequire('./routes/user.routes', 'user.routes');
const driveRoutes = safeRequire('./routes/drive.routes', 'drive.routes');
const messagesRoutes = safeRequire('./routes/messages.routes', 'messages.routes');

// ============================================
// Request ID Middleware
// ============================================

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

morgan.token('request-id', (req) => req.id || '-');
morgan.token('user-id', (req) => req.user?._id || '-');
morgan.token('user-role', (req) => req.user?.role || '-');

const morganFormat = env.isProduction
  ? ':remote-addr - :request-id [:date[clf]] ":method :url" :status :response-time ms - :res[content-length] :user-id :user-role'
  : 'dev';

// ============================================
// CORS Configuration
// ============================================

const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    
    if (origin.includes('.onrender.com')) {
      console.log(`✅ CORS allowed: ${origin}`);
      return callback(null, true);
    }
    
    const allowedOrigins = [
      'https://pebeto-new.onrender.com',
      'https://pebeto-hub-1-v7pq.onrender.com',
      'https://pebeto-hub-1.onrender.com',
      'https://pebeto-creators-hub.onrender.com',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500'
    ];
    
    if (allowedOrigins.includes(origin)) {
      console.log(`✅ CORS allowed (exact match): ${origin}`);
      return callback(null, true);
    }
    
    if (env.clientOrigins && env.clientOrigins.includes(origin)) {
      console.log(`✅ CORS allowed (env): ${origin}`);
      return callback(null, true);
    }
    
    if (env.corsAllowAll) {
      console.log(`⚠️ CORS allowed all: ${origin}`);
      return callback(null, true);
    }
    
    console.log(`🔒 CORS blocked: ${origin}`);
    callback(new Error(`CORS policy does not allow origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'Accept', 'Origin', 'X-Requested-With'],
  exposedHeaders: ['X-Request-ID'],
  maxAge: 86400
};

// ============================================
// Security Headers Configuration
// ============================================

const helmetConfig = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net'],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", 'https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net', 'https://cdn.socket.io', 'https://fonts.googleapis.com', 'https://www.tiktok.com', 'https://www.youtube.com', 'https://unpkg.com', 'https://cdn.socket.io', 'blob:'],
      scriptSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'https://ui-avatars.com', 'https://*.cloudinary.com', 'https://*.tiktok.com', 'https://*.ytimg.com', 'https://*.googleusercontent.com', 'blob:'],
      connectSrc: ["'self'", 'https://*.safaricom.co.ke', 'https://api-m.paypal.com', 'https://api-m.sandbox.paypal.com', 'https://*.tiktok.com', 'https://*.youtube.com', 'https://pebeto-creators-hub.onrender.com', 'ws://localhost:3000', 'wss://pebeto-creators-hub.onrender.com'],
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.tiktok.com', 'https://drive.google.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: env.isProduction ? [] : null,
      workerSrc: ["'self'", 'blob:'],
      childSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: false,
};

// ============================================
// Bootstrap Function
// ============================================

async function bootstrap() {
  const startTime = Date.now();
  
  try {
    // 1. Database Connection
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
    
    // 5. Request ID Middleware
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
    app.options('*', cors(corsOptions));
    app.use(compression());
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    
    // 8. Fee Service Middleware
    app.use(attachFeeService);
    
    // 9. Health Check Endpoint
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

    // ============================================
    // DIRECT TEST ROUTE - EMERGENCY FIX
    // ============================================
    app.get('/api/community-test', (req, res) => {
      res.json({ 
        success: true, 
        message: '✅ Server is alive! Community test route works!',
        timestamp: new Date().toISOString()
      });
    });

    // ============================================
    // 10. API Routes
    // ============================================
    logger.info('Mounting routes...');
    
    // Auth routes
    app.use('/api/auth', authRoutes);
    
    // Wallet routes
    if (walletRoutes && walletRoutes.publicRouter) {
      app.use('/api/wallet', walletRoutes.publicRouter);
    }
    if (walletRoutes && walletRoutes.router) {
      app.use('/api/wallet', walletRoutes.router);
    }
    
    // Admin routes
    app.use('/api/admin', adminRoutes);
    
    // Campaign routes
    app.use('/api/campaigns', campaignRoutes);
    
    // User routes
    if (userRoutes) {
      app.use('/api/user', userRoutes);
      console.log('✅ Mounted user routes (/api/user/*)');
    } else {
      console.log('⚠️ User routes skipped - file not found');
    }
    
    // Creator routes
    if (creatorRoutes) {
      app.use('/api', creatorRoutes);
      console.log('✅ Mounted creator routes (/api/creators, /api/creator/social-links)');
    } else {
      console.log('⚠️ Creator routes skipped - file not found');
    }
    
    // Google Drive routes
    if (driveRoutes) {
      app.use('/api/drive', driveRoutes);
      console.log('✅ Mounted Google Drive routes (/api/drive/*)');
    } else {
      console.log('⚠️ Google Drive routes skipped - file not found');
    }
    
    // Messages routes
    if (messagesRoutes) {
      app.use('/api/messages', messagesRoutes);
      console.log('✅ Mounted messages routes (/api/messages/*)');
    } else {
      console.log('⚠️ Messages routes skipped - file not found');
    }
    
    // Community routes (from file)
    if (communityRoutes) {
      app.use('/api/community', communityRoutes);
      console.log('✅ Mounted community routes from file');
    } else {
      console.log('⚠️ Community routes from file skipped - file not found');
    }
    
    // Exchange routes
    if (exchangeRoutes) {
      app.use('/api/exchange', exchangeRoutes);
      console.log('✅ Mounted exchange routes');
    } else {
      console.log('⚠️ Exchange routes skipped - file not found');
    }
    
    // Withdrawal routes
    if (withdrawalRoutes) {
      app.use('/api/withdrawals', withdrawalRoutes);
      console.log('✅ Mounted withdrawal routes');
    } else {
      console.log('⚠️ Withdrawal routes skipped - file not found');
    }

    // ============================================
    // EMERGENCY COMMUNITY ROUTES - ALWAYS WORKS
    // ============================================
    console.log('🚨 MOUNTING EMERGENCY COMMUNITY ROUTES...');
    try {
      const emergencyRouter = require('express').Router();
      
      emergencyRouter.get('/test', (req, res) => {
        res.json({ 
          success: true, 
          message: '✅ EMERGENCY community routes are working!',
          timestamp: new Date().toISOString()
        });
      });
      
      emergencyRouter.post('/echo', (req, res) => {
        res.json({ 
          success: true, 
          message: '✅ Echo route works!',
          received: req.body,
          timestamp: new Date().toISOString()
        });
      });
      
      app.use('/api/community', emergencyRouter);
      console.log('✅✅✅ EMERGENCY community routes MOUNTED at /api/community');
      console.log('   📍 GET  /api/community/test - Test endpoint');
      console.log('   📍 POST /api/community/echo - Echo endpoint');
    } catch (error) {
      console.error('❌ EMERGENCY routes failed:', error.message);
    }
    
    // 11. Static Files
    app.use(express.static(path.join(__dirname, '..'), {
      index: false,
      maxAge: env.isProduction ? '1d' : 0
    }));
    
    const publicPath = path.join(__dirname, '..', 'public');
    app.use('/public', express.static(publicPath, {
      maxAge: env.isProduction ? '30d' : 0
    }));
    
    // 12. SPA Fallback
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        return next();
      }
      const indexPath = path.join(__dirname, '..', 'index.html');
      res.sendFile(indexPath, (err) => {
        if (err && err.code === 'ENOENT') {
          res.status(200).send(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Pebeto Creator's Hub</title>
              <style>
                body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
                h1 { color: #333; }
                .status { background: #e8f5e9; padding: 15px; border-radius: 8px; border-left: 4px solid #4caf50; }
              </style>
            </head>
            <body>
              <h1>🚀 Pebeto Creator's Hub API</h1>
              <div class="status">✅ API is running in ${env.nodeEnv} mode</div>
              <h2>Available Endpoints:</h2>
              <ul>
                <li><a href="/api/health">GET /api/health</a> - Health check</li>
                <li><a href="/api/community/test">GET /api/community/test</a> - Community test</li>
                <li><a href="/api/community-test">GET /api/community-test</a> - Direct test</li>
              </ul>
            </body>
            </html>
          `);
        } else if (err) {
          next(err);
        }
      });
    });
    
    // 13. 404 Handler
    app.use(notFoundHandler);
    
    // 14. Global Error Handler
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
      logger.info(`   Community Test: http://${HOST}:${PORT}/api/community/test`);
      console.log('='.repeat(60));
      
      if (env.logConfigSummary) {
        env.logConfigSummary();
      }
    });
    
    // Auto-release cron job
    try {
      const { processAutoReleaseQueue } = require('./services/autoReleaseService');
      const cronSchedule = process.env.AUTO_RELEASE_CRON_SCHEDULE || '0 * * * *';
      
      cron.schedule(cronSchedule, async () => {
        logger.info('⏰ Running auto-release cron job...');
        try {
          const results = await processAutoReleaseQueue();
          if (results && (results.autoReleased > 0 || results.remindersSent > 0)) {
            logger.info(`Auto-release cron completed: ${results.autoReleased} released, ${results.remindersSent} reminders sent`);
          }
        } catch (error) {
          logger.error('Auto-release cron job failed:', error.message);
        }
      });
      
      logger.info(`✅ Auto-release cron job scheduled: ${cronSchedule}`);
      
      setTimeout(async () => {
        try {
          logger.info('🔄 Running initial auto-release check on startup...');
          const results = await processAutoReleaseQueue();
          if (results && (results.autoReleased > 0 || results.remindersSent > 0)) {
            logger.info(`Initial auto-release check: ${results.autoReleased} released, ${results.remindersSent} reminders sent`);
          }
        } catch (error) {
          logger.error('Initial auto-release check failed:', error.message);
        }
      }, 10000);
      
    } catch (error) {
      logger.error('Failed to initialize auto-release service:', error.message);
      logger.warn('⚠️ Auto-release service disabled - server will continue running');
    }
    
    // Graceful Shutdown
    setupGracefulShutdown(server);
    
    return { app, server, io };
    
  } catch (error) {
    console.error('='.repeat(60));
    logger.error('🚨 CRITICAL STARTUP ERROR:');
    console.error(error);
    console.error('='.repeat(60));
    
    if (error.message.includes('MONGO_URI')) {
      console.error('\n💡 Database Configuration Error:');
      console.error('   Please ensure MONGO_URI is set in your environment variables');
    } else if (error.message.includes('JWT_SECRET')) {
      console.error('\n💡 JWT Configuration Error:');
      console.error('   Please set JWT_SECRET in your environment variables');
    }
    
    process.exit(1);
  }
}

// ============================================
// Graceful Shutdown Handler
// ============================================

let isShuttingDown = false;

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
    }, 30000);
    
    try {
      await new Promise((resolve) => {
        server.close(resolve);
      });
      console.log('✅ HTTP server closed');
      logger.info('HTTP server closed');
      
      await disconnectDB();
      console.log('✅ Database connection closed');
      logger.info('Database connection closed');
      
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
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    logger.error('Uncaught Exception:', error);
    setTimeout(() => {
      shutdown('uncaughtException');
    }, 1000);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise);
    console.error('   Reason:', reason);
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
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

bootstrap().catch((err) => {
  console.error('='.repeat(60));
  console.error('--- FATAL STARTUP ERROR ---');
  console.error(err);
  console.error('='.repeat(60));
  
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

module.exports = { bootstrap };
