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

// Verify critical environment variables before anything else
const requiredEnvVars = ['JWT_SECRET'];
const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);

if (missingEnvVars.length > 0) {
  console.error('❌ CRITICAL: Missing required environment variables:');
  missingEnvVars.forEach(key => console.error(`   - ${key}`));
  console.error('\n💡 Please set these variables in your Render dashboard or .env file');
  process.exit(1);
}

// Log startup environment (sanitized)
console.log('='.repeat(60));
console.log('🚀 PEBBETO CREATOR\'S HUB SERVER STARTING');
console.log('='.repeat(60));
console.log(`📁 Directory: ${__dirname}`);
console.log(`📦 Node Version: ${process.version}`);
console.log(`🔧 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`🔑 JWT_SECRET: ${process.env.JWT_SECRET ? '✅ Set' : '❌ Missing'}`);
console.log(`🗄️ MONGO_URI: ${process.env.MONGO_URI ? '✅ Set' : '❌ Missing'}`);
console.log(`🌐 PORT: ${process.env.PORT || '3000'}`);
console.log('='.repeat(60));

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
const { attachFeeService } = require('./services/feeService');
const { initSockets } = require('./sockets');
const logger = require('./utils/logger');

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
// CORS Configuration
// ============================================

const corsOptions = {
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl)
    if (!origin) return callback(null, true);
    
    // Check if origin is allowed
    if (env.corsAllowAll) {
      return callback(null, true);
    }
    
    if (env.clientOrigins.length === 0) {
      return callback(null, true);
    }
    
    if (env.clientOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    callback(new Error(`CORS policy does not allow origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
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
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.tailwindcss.com'],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net', 'https://cdn.socket.io', 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'https://ui-avatars.com', 'https://*.cloudinary.com'],
      connectSrc: ["'self'", 'https://*.safaricom.co.ke', 'https://api-m.paypal.com', 'https://api-m.sandbox.paypal.com'],
      frameSrc: ["'self'"],
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
    await connectDB(env.mongoUri, env.mongoOptions);
    logger.info('✅ Database connection established.');
    
    // 2. Create Express App
    const app = express();
    const server = http.createServer(app);
    
    // 3. Socket.IO Setup
    const io = new Server(server, {
      cors: {
        origin: env.clientOrigins,
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
        environment: env.nodeEnv
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
    
    // Community routes (optional - only if file exists)
    if (communityRoutes) {
      app.use('/api/community', communityRoutes);
      console.log('✅ Mounted community routes');
    } else {
      console.log('⚠️ Community routes skipped - file not found');
    }
    
    // Exchange rate routes (optional - only if file exists)
    if (exchangeRoutes) {
      app.use('/api/exchange', exchangeRoutes);
      console.log('✅ Mounted exchange routes');
    } else {
      console.log('⚠️ Exchange routes skipped - file not found');
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
        if (err) {
          // If index.html doesn't exist, send a simple message
          res.status(200).send(`
            <!DOCTYPE html>
            <html>
            <head><title>Pebeto Creator's Hub</title></head>
            <body>
              <h1>Pebeto Creator's Hub API</h1>
              <p>API is running. Visit <a href="/api/health">/api/health</a> to check status.</p>
            </body>
            </html>
          `);
        }
      });
    });
    
    // 13. 404 Handler (for unmatched routes)
    app.use(notFoundHandler);
    
    // 14. Global Error Handler (last!)
    app.use(errorHandler);
    
    // 15. Start Server
    const PORT = env.port || process.env.PORT || 3000;
    const HOST = env.host || '0.0.0.0';
    
    server.listen(PORT, HOST, () => {
      const startupTime = Date.now() - startTime;
      console.log('='.repeat(60));
      logger.info(`🚀 Pebeto Creator's Hub running on http://${HOST}:${PORT}`);
      logger.info(`   Environment: ${env.nodeEnv}`);
      logger.info(`   Startup time: ${startupTime}ms`);
      logger.info(`   API Health: http://${HOST}:${PORT}/api/health`);
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
      server.close(() => {
        console.log('✅ HTTP server closed');
        logger.info('HTTP server closed');
      });
      
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
    shutdown('uncaughtException');
  });
  
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit immediately, let the process continue
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
  process.exit(1);
});

// ============================================
// Exports (for testing)
// ============================================

module.exports = { bootstrap };
