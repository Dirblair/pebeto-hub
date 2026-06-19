/**
 * Environment Configuration Module for Pebeto Creator's Hub
 * 
 * Loads, validates, and exports environment variables with sensible defaults.
 * Throws clear errors when required configuration is missing.
 * 
 * @module env
 */

require('dotenv').config();

// ============================================
// Helper Functions
// ============================================

/**
 * Parse boolean environment variable
 * @param {string} value - Environment variable value
 * @param {boolean} defaultValue - Default value if not set
 * @returns {boolean}
 */
function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  const str = String(value).toLowerCase().trim();
  return str === 'true' || str === '1' || str === 'yes' || str === 'on';
}

/**
 * Parse integer environment variable
 * @param {string} value - Environment variable value
 * @param {number} defaultValue - Default value if not set
 * @param {Object} options - Min/max constraints
 * @returns {number}
 */
function parseInteger(value, defaultValue, options = {}) {
  if (value === undefined || value === null) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return defaultValue;
  
  const { min, max } = options;
  if (min !== undefined && parsed < min) return min;
  if (max !== undefined && parsed > max) return max;
  return parsed;
}

/**
 * Parse array from comma-separated string
 * @param {string} value - Environment variable value
 * @param {Array} defaultValue - Default value if not set
 * @returns {Array}
 */
function parseArray(value, defaultValue = []) {
  if (!value) return defaultValue;
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

/**
 * Validate required environment variable
 * @param {string} name - Variable name
 * @param {string} value - Variable value
 * @param {string} description - Human-readable description
 * @throws {Error} If variable is missing
 */
function requireEnv(name, value, description) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (${description})`);
  }
  return value;
}

/**
 * Sanitize value for logging (hide sensitive data)
 * @param {string} value - Value to sanitize
 * @returns {string} Sanitized value
 */
function sanitizeForLog(value, showFirst = 4, showLast = 4) {
  if (!value || value.length < 12) return '***';
  return value.substring(0, showFirst) + '...' + value.substring(value.length - showLast);
}

// ============================================
// Environment Detection
// ============================================

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const IS_DEVELOPMENT = NODE_ENV === 'development';
const IS_TEST = NODE_ENV === 'test';

// ============================================
// Server Configuration
// ============================================

const PORT = parseInteger(process.env.PORT, 3000, { min: 1000, max: 65535 });
const HOST = process.env.HOST || (IS_PRODUCTION ? '0.0.0.0' : 'localhost');

// ============================================
// Database Configuration
// ============================================

// Debug logging (only in development)
if (IS_DEVELOPMENT) {
  console.log('🔍 [ENV] process.env.MONGO_URI:', process.env.MONGO_URI ? '✅ EXISTS' : '❌ UNDEFINED');
  console.log('🔍 [ENV] process.env.MONGODB_URI:', process.env.MONGODB_URI ? '✅ EXISTS' : '❌ UNDEFINED');
}

// Try both MONGO_URI and MONGODB_URI (with priority to MONGO_URI)
let mongoUriValue = process.env.MONGO_URI || process.env.MONGODB_URI;

// ============================================
// FIXED: Add fallback for development
// ============================================
if (!mongoUriValue) {
  if (IS_PRODUCTION) {
    console.error('❌ [ENV] MONGO_URI is required in production!');
    // Don't throw - let the server handle it
  } else {
    // Development fallback
    mongoUriValue = 'mongodb://127.0.0.1:27017/pebeto-creators-hub';
    console.log('🔧 [ENV] Using default development MongoDB URI: mongodb://127.0.0.1:27017/pebeto-creators-hub');
    console.log('💡 [ENV] Set MONGO_URI in .env to use a different database');
  }
}

const MONGO_URI = mongoUriValue;

// Log status
if (!MONGO_URI) {
  console.error('❌ [ENV] MONGO_URI not set - database connection will fail!');
} else if (IS_DEVELOPMENT) {
  console.log('✅ [ENV] MongoDB URI configured');
}

const MONGO_OPTIONS = {
  maxPoolSize: parseInteger(process.env.MONGO_MAX_POOL_SIZE, 10, { min: 1, max: 100 }),
  minPoolSize: parseInteger(process.env.MONGO_MIN_POOL_SIZE, 2, { min: 1, max: 50 }),
  connectTimeoutMS: parseInteger(process.env.MONGO_CONNECT_TIMEOUT, 10000, { min: 1000, max: 60000 }),
  socketTimeoutMS: parseInteger(process.env.MONGO_SOCKET_TIMEOUT, 45000, { min: 5000, max: 120000 }),
};

// ============================================
// JWT Authentication
// ============================================

// ============================================
// FIXED: Add fallback for JWT_SECRET in development
// ============================================
let JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  if (IS_PRODUCTION) {
    console.error('❌ [ENV] JWT_SECRET is required in production!');
    // Don't throw - let the server handle it
  } else {
    // Development fallback
    JWT_SECRET = 'dev-secret-key-change-in-production';
    console.warn('⚠️ [ENV] Using default development JWT_SECRET - THIS IS INSECURE');
    console.warn('💡 [ENV] Set JWT_SECRET in .env for production');
  }
}

// JWT validation
if (JWT_SECRET && JWT_SECRET.length < 32 && IS_PRODUCTION) {
  console.warn('⚠️ WARNING: JWT_SECRET should be at least 32 characters long in production');
} else if (JWT_SECRET === 'your-super-secret-jwt-key-change-this-in-production') {
  console.warn('⚠️ WARNING: Using default JWT_SECRET. This is insecure!');
}

const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';
const JWT_EMAIL_VERIFY_EXPIRES_IN = process.env.JWT_EMAIL_VERIFY_EXPIRES_IN || '24h';
const JWT_PASSWORD_RESET_EXPIRES_IN = process.env.JWT_PASSWORD_RESET_EXPIRES_IN || '1h';

// ============================================
// CORS Configuration
// ============================================

const CLIENT_ORIGIN_RAW = process.env.CLIENT_ORIGIN || (IS_PRODUCTION ? '' : '*');
const CLIENT_ORIGINS = parseArray(CLIENT_ORIGIN_RAW, []);

// Auto-detect production URLs
let finalClientOrigins = CLIENT_ORIGINS;
if (IS_PRODUCTION && finalClientOrigins.length === 0) {
  // Try to auto-detect from various environment variables
  const renderUrl = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL || '';
  const herokuUrl = process.env.HEROKU_APP_URL || '';
  const vercelUrl = process.env.VERCEL_URL || '';
  const detectedUrl = renderUrl || herokuUrl || vercelUrl;
  
  if (detectedUrl) {
    finalClientOrigins = [detectedUrl];
    console.log(`🔧 Auto-configured CORS origin to: ${detectedUrl}`);
  } else {
    console.warn('⚠️ WARNING: No CLIENT_ORIGIN set and no platform URL detected. CORS may block requests.');
  }
}

const CORS_CONFIG = {
  origins: finalClientOrigins,
  credentials: true,
  allowAll: CLIENT_ORIGIN_RAW === '*',
};

// ============================================
// Cloudinary Configuration - NEW
// ============================================

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.warn('⚠️ [ENV] Cloudinary credentials not configured. Media uploads will not work.');
} else {
  console.log('✅ [ENV] Cloudinary configured');
}

// ============================================
// Rate Limiting Configuration
// ============================================

const RATE_LIMIT_WINDOW_MS = parseInteger(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000);
const RATE_LIMIT_MAX_REQUESTS = parseInteger(process.env.RATE_LIMIT_MAX_REQUESTS, 100);
const RATE_LIMIT_AUTH_WINDOW_MS = parseInteger(process.env.RATE_LIMIT_AUTH_WINDOW_MS, 15 * 60 * 1000);
const RATE_LIMIT_AUTH_MAX_REQUESTS = parseInteger(process.env.RATE_LIMIT_AUTH_MAX_REQUESTS, 10);

// ============================================
// Exchange Rate API
// ============================================

const EXCHANGE_RATE_API_KEY = process.env.EXCHANGE_RATE_API_KEY || '';
const EXCHANGE_RATE_API_URL = process.env.EXCHANGE_RATE_API_URL || 'https://v6.exchangerate-api.com/v6';
const EXCHANGE_RATE_CACHE_TTL = parseInteger(process.env.EXCHANGE_RATE_CACHE_TTL, 3600);

// ============================================
// M-Pesa Configuration (Kenya)
// ============================================

const MPESA_ENABLED = parseBoolean(process.env.MPESA_ENABLED, !IS_TEST);
const MPESA_ENVIRONMENT = process.env.MPESA_ENVIRONMENT || (IS_PRODUCTION ? 'production' : 'sandbox');
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || '';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || '';
const MPESA_INITIATOR_NAME = process.env.MPESA_INITIATOR_NAME || '';
const MPESA_PASSWORD = process.env.MPESA_PASSWORD || '';
const MPESA_SHORT_CODE = process.env.MPESA_SHORT_CODE || '';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '';
const MPESA_API_URL = process.env.MPESA_API_URL || 
  (MPESA_ENVIRONMENT === 'sandbox' 
    ? 'https://sandbox.safaricom.co.ke' 
    : 'https://api.safaricom.co.ke');
const MPESA_QUEUE_TIMEOUT_URL = process.env.MPESA_QUEUE_TIMEOUT_URL || '';
const MPESA_RESULT_URL = process.env.MPESA_RESULT_URL || '';
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL || 
  (finalClientOrigins[0] ? `${finalClientOrigins[0]}/api/wallet/mpesa-callback` : '');

// Validate M-Pesa config
if (MPESA_ENABLED) {
  const missingMpesaConfig = [];
  if (!MPESA_CONSUMER_KEY) missingMpesaConfig.push('MPESA_CONSUMER_KEY');
  if (!MPESA_CONSUMER_SECRET) missingMpesaConfig.push('MPESA_CONSUMER_SECRET');
  if (!MPESA_SHORT_CODE) missingMpesaConfig.push('MPESA_SHORT_CODE');
  if (!MPESA_PASSKEY) missingMpesaConfig.push('MPESA_PASSKEY');
  
  if (missingMpesaConfig.length > 0) {
    if (IS_PRODUCTION) {
      console.warn(`⚠️ WARNING: M-Pesa enabled but missing config: ${missingMpesaConfig.join(', ')}`);
    }
  }
}

// ============================================
// PayPal Configuration (Global)
// ============================================

const PAYPAL_ENABLED = parseBoolean(process.env.PAYPAL_ENABLED, true);
const PAYPAL_ENVIRONMENT = process.env.PAYPAL_ENVIRONMENT || (IS_PRODUCTION ? 'production' : 'sandbox');
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_API_URL = process.env.PAYPAL_API_URL ||
  (PAYPAL_ENVIRONMENT === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com');
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '';

const PAYPAL_MIN_AMOUNT = parseInteger(process.env.PAYPAL_MIN_AMOUNT, 1, { min: 1, max: 100 });
const PAYPAL_MAX_AMOUNT = parseInteger(process.env.PAYPAL_MAX_AMOUNT, 10000, { min: 100, max: 50000 });

if (PAYPAL_ENABLED && (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET)) {
  console.warn('⚠️ WARNING: PayPal credentials not configured. PayPal payments will be unavailable.');
}

// ============================================
// Wire Transfer Configuration (International)
// ============================================

const WIRE_ENABLED = parseBoolean(process.env.WIRE_ENABLED, true);
const WIRE_MIN_AMOUNT = parseInteger(process.env.WIRE_MIN_AMOUNT, 100, { min: 50, max: 1000 });
const WIRE_MAX_AMOUNT = parseInteger(process.env.WIRE_MAX_AMOUNT, 50000, { min: 10000, max: 500000 });
const WIRE_BANK_NAME = process.env.WIRE_BANK_NAME || 'Pebeto Partner Bank';
const WIRE_BANK_ADDRESS = process.env.WIRE_BANK_ADDRESS || '123 Financial District, New York, NY 10005, USA';
const WIRE_ACCOUNT_NAME = process.env.WIRE_ACCOUNT_NAME || 'Pebeto Global Holdings Ltd';
const WIRE_ACCOUNT_NUMBER = process.env.WIRE_ACCOUNT_NUMBER || '';
const WIRE_ROUTING_NUMBER = process.env.WIRE_ROUTING_NUMBER || '';
const WIRE_SWIFT_CODE = process.env.WIRE_SWIFT_CODE || '';
const WIRE_IBAN = process.env.WIRE_IBAN || '';
const WIRE_BANK_COUNTRY = process.env.WIRE_BANK_COUNTRY || 'USA';
const WIRE_CURRENCY = process.env.WIRE_CURRENCY || 'USD';

if (WIRE_ENABLED && (!WIRE_ACCOUNT_NUMBER || !WIRE_SWIFT_CODE)) {
  console.warn('⚠️ WARNING: Wire transfer configuration incomplete. Wire transfers will be unavailable.');
}

// ============================================
// Email Configuration
// ============================================

const EMAIL_ENABLED = parseBoolean(process.env.EMAIL_ENABLED, !IS_TEST);
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInteger(process.env.SMTP_PORT, 587, { min: 1, max: 65535 });
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || '';
const SMTP_SECURE = parseBoolean(process.env.SMTP_SECURE, SMTP_PORT === 465);
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@pebeto.com';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || 'support@pebeto.com';

if (EMAIL_ENABLED && (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD)) {
  console.warn('⚠️ WARNING: Email configuration incomplete. Email notifications will not work.');
}

// ============================================
// Redis Configuration (Optional)
// ============================================

const REDIS_ENABLED = parseBoolean(process.env.REDIS_ENABLED, false);
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';

if (REDIS_ENABLED && !REDIS_URL) {
  console.warn('⚠️ WARNING: Redis enabled but REDIS_URL not set');
}

// ============================================
// File Upload Configuration
// ============================================

const UPLOAD_MAX_SIZE_MB = parseInteger(process.env.UPLOAD_MAX_SIZE_MB, 100, { min: 1, max: 500 });
const UPLOAD_MAX_FILES = parseInteger(process.env.UPLOAD_MAX_FILES, 5, { min: 1, max: 20 });
const UPLOAD_ALLOWED_TYPES = parseArray(
  process.env.UPLOAD_ALLOWED_TYPES,
  ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']
);

// ============================================
// Logging Configuration
// ============================================

const LOG_LEVEL = process.env.LOG_LEVEL || (IS_PRODUCTION ? 'info' : 'debug');
const LOG_FORMAT = process.env.LOG_FORMAT || (IS_PRODUCTION ? 'json' : 'pretty');

// ============================================
// Feature Flags
// ============================================

const FEATURES = {
  COMMUNITY_ENABLED: parseBoolean(process.env.COMMUNITY_ENABLED, true),
  WITHDRAWALS_ENABLED: parseBoolean(process.env.WITHDRAWALS_ENABLED, true),
  TIPS_ENABLED: parseBoolean(process.env.TIPS_ENABLED, true),
  CREATOR_REGISTRATION_ENABLED: parseBoolean(process.env.CREATOR_REGISTRATION_ENABLED, true),
  BUSINESS_REGISTRATION_ENABLED: parseBoolean(process.env.BUSINESS_REGISTRATION_ENABLED, true),
};

// ============================================
// Build Config Object
// ============================================

const config = {
  // Environment
  nodeEnv: NODE_ENV,
  isProduction: IS_PRODUCTION,
  isDevelopment: IS_DEVELOPMENT,
  isTest: IS_TEST,
  
  // Server
  port: PORT,
  host: HOST,
  
  // Database
  mongoUri: MONGO_URI,
  mongoOptions: MONGO_OPTIONS,
  
  // JWT
  jwtSecret: JWT_SECRET,
  jwtAccessExpiresIn: JWT_ACCESS_EXPIRES_IN,
  jwtRefreshExpiresIn: JWT_REFRESH_EXPIRES_IN,
  jwtEmailVerifyExpiresIn: JWT_EMAIL_VERIFY_EXPIRES_IN,
  jwtPasswordResetExpiresIn: JWT_PASSWORD_RESET_EXPIRES_IN,
  
  // CORS
  clientOrigin: CLIENT_ORIGIN_RAW,
  clientOrigins: CORS_CONFIG.origins,
  corsAllowAll: CORS_CONFIG.allowAll,
  
  // Rate Limiting
  rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
  rateLimitMaxRequests: RATE_LIMIT_MAX_REQUESTS,
  rateLimitAuthWindowMs: RATE_LIMIT_AUTH_WINDOW_MS,
  rateLimitAuthMaxRequests: RATE_LIMIT_AUTH_MAX_REQUESTS,
  
  // Exchange Rates
  exchangeRateApiKey: EXCHANGE_RATE_API_KEY,
  exchangeRateApiUrl: EXCHANGE_RATE_API_URL,
  exchangeRateCacheTtl: EXCHANGE_RATE_CACHE_TTL,
  
  // M-Pesa
  mpesa: {
    enabled: MPESA_ENABLED,
    environment: MPESA_ENVIRONMENT,
    consumerKey: MPESA_CONSUMER_KEY,
    consumerSecret: MPESA_CONSUMER_SECRET,
    initiatorName: MPESA_INITIATOR_NAME,
    password: MPESA_PASSWORD,
    shortCode: MPESA_SHORT_CODE,
    passkey: MPESA_PASSKEY,
    apiUrl: MPESA_API_URL,
    queueTimeoutUrl: MPESA_QUEUE_TIMEOUT_URL,
    resultUrl: MPESA_RESULT_URL,
    callbackUrl: MPESA_CALLBACK_URL,
  },
  
  // PayPal
  paypal: {
    enabled: PAYPAL_ENABLED,
    environment: PAYPAL_ENVIRONMENT,
    clientId: PAYPAL_CLIENT_ID,
    clientSecret: PAYPAL_CLIENT_SECRET,
    apiUrl: PAYPAL_API_URL,
    webhookId: PAYPAL_WEBHOOK_ID,
    minAmount: PAYPAL_MIN_AMOUNT,
    maxAmount: PAYPAL_MAX_AMOUNT,
  },
  
  // Wire Transfer
  wire: {
    enabled: WIRE_ENABLED,
    minAmount: WIRE_MIN_AMOUNT,
    maxAmount: WIRE_MAX_AMOUNT,
    bankName: WIRE_BANK_NAME,
    bankAddress: WIRE_BANK_ADDRESS,
    accountName: WIRE_ACCOUNT_NAME,
    accountNumber: WIRE_ACCOUNT_NUMBER,
    routingNumber: WIRE_ROUTING_NUMBER,
    swiftCode: WIRE_SWIFT_CODE,
    iban: WIRE_IBAN,
    bankCountry: WIRE_BANK_COUNTRY,
    currency: WIRE_CURRENCY,
  },
  
  // Email
  email: {
    enabled: EMAIL_ENABLED,
    smtpHost: SMTP_HOST,
    smtpPort: SMTP_PORT,
    smtpUser: SMTP_USER,
    smtpPassword: SMTP_PASSWORD,
    smtpSecure: SMTP_SECURE,
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
  },
  
  // Redis
  redis: {
    enabled: REDIS_ENABLED,
    url: REDIS_URL,
    password: REDIS_PASSWORD,
  },
  
  // File Upload
  upload: {
    maxSizeMb: UPLOAD_MAX_SIZE_MB,
    maxSizeBytes: UPLOAD_MAX_SIZE_MB * 1024 * 1024,
    maxFiles: UPLOAD_MAX_FILES,
    allowedTypes: UPLOAD_ALLOWED_TYPES,
  },
  
  // Cloudinary
  cloudinary: {
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    apiSecret: CLOUDINARY_API_SECRET,
  },
  
  // Logging
  logLevel: LOG_LEVEL,
  logFormat: LOG_FORMAT,
  
  // Features
  features: FEATURES,
};

// ============================================
// Backward Compatibility Properties
// ============================================

// Add direct references to M-Pesa config for services that expect them
Object.assign(config, {
  MPESA_CONSUMER_KEY: config.mpesa.consumerKey,
  MPESA_CONSUMER_SECRET: config.mpesa.consumerSecret,
  MPESA_SHORT_CODE: config.mpesa.shortCode,
  MPESA_PASSKEY: config.mpesa.passkey,
  MPESA_API_URL: config.mpesa.apiUrl,
  MPESA_CALLBACK_URL: config.mpesa.callbackUrl,
  MPESA_INITIATOR_NAME: config.mpesa.initiatorName,
  MPESA_PASSWORD: config.mpesa.password,
  MPESA_ENVIRONMENT: config.mpesa.environment,
  MPESA_ENABLED: config.mpesa.enabled,
  
  PAYPAL_CLIENT_ID: config.paypal.clientId,
  PAYPAL_CLIENT_SECRET: config.paypal.clientSecret,
  PAYPAL_API_URL: config.paypal.apiUrl,
  
  WIRE_ACCOUNT_NUMBER: config.wire.accountNumber,
  WIRE_SWIFT_CODE: config.wire.swiftCode,
  
  // Cloudinary backward compatibility
  CLOUDINARY_CLOUD_NAME: config.cloudinary.cloudName,
  CLOUDINARY_API_KEY: config.cloudinary.apiKey,
  CLOUDINARY_API_SECRET: config.cloudinary.apiSecret,
});

// ============================================
// Sanitized Config for Logging
// ============================================

const configForLogging = {
  ...config,
  jwtSecret: JWT_SECRET ? sanitizeForLog(JWT_SECRET) : '***',
  mongoUri: MONGO_URI ? sanitizeForLog(MONGO_URI, 10, 10) : '***',
  mpesa: {
    ...config.mpesa,
    consumerKey: config.mpesa.consumerKey ? sanitizeForLog(config.mpesa.consumerKey) : '***',
    consumerSecret: config.mpesa.consumerSecret ? '***' : undefined,
    password: config.mpesa.password ? '***' : undefined,
    passkey: config.mpesa.passkey ? '***' : undefined,
  },
  paypal: {
    ...config.paypal,
    clientId: config.paypal.clientId ? sanitizeForLog(config.paypal.clientId) : '***',
    clientSecret: config.paypal.clientSecret ? '***' : undefined,
  },
  wire: {
    ...config.wire,
    accountNumber: config.wire.accountNumber ? sanitizeForLog(config.wire.accountNumber) : '***',
    routingNumber: config.wire.routingNumber ? sanitizeForLog(config.wire.routingNumber) : '***',
    swiftCode: config.wire.swiftCode ? sanitizeForLog(config.wire.swiftCode) : '***',
    iban: config.wire.iban ? sanitizeForLog(config.wire.iban) : '***',
  },
  email: {
    ...config.email,
    smtpPassword: config.email.smtpPassword ? '***' : undefined,
  },
  redis: {
    ...config.redis,
    password: config.redis.password ? '***' : undefined,
  },
  cloudinary: {
    cloudName: config.cloudinary.cloudName,
    apiKey: config.cloudinary.apiKey ? sanitizeForLog(config.cloudinary.apiKey) : '***',
    apiSecret: config.cloudinary.apiSecret ? '***' : undefined,
  },
};

// ============================================
// Validation Summary Function
// ============================================

function logConfigSummary() {
  console.log('\n📋 Configuration Summary:');
  console.log('═'.repeat(50));
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`🚀 Server: http://${HOST}:${PORT}`);
  console.log(`💾 MongoDB: ${MONGO_URI ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🔐 JWT Secret: ${JWT_SECRET && JWT_SECRET.length >= 32 ? '✅ Strong' : JWT_SECRET ? '⚠️ Weak' : '❌ Missing'}`);
  console.log(`☁️ Cloudinary: ${CLOUDINARY_CLOUD_NAME ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🌐 CORS Origins: ${finalClientOrigins.length > 0 ? finalClientOrigins.join(', ') : '⚠️ None set'}`);
  
  console.log(`\n💳 Payment Gateways:`);
  console.log(`   M-Pesa (Kenya): ${MPESA_ENABLED && MPESA_CONSUMER_KEY ? '✅ Enabled' : '❌ Disabled/Incomplete'}`);
  console.log(`   PayPal (Global): ${PAYPAL_ENABLED && PAYPAL_CLIENT_ID ? '✅ Enabled' : '❌ Disabled/Incomplete'}`);
  console.log(`   Wire Transfer: ${WIRE_ENABLED && WIRE_ACCOUNT_NUMBER ? '✅ Enabled' : '❌ Disabled/Incomplete'}`);
  
  console.log(`\n📧 Email Service: ${EMAIL_ENABLED && SMTP_HOST ? '✅ Configured' : '❌ Disabled'}`);
  console.log(`🗄️ Redis Cache: ${REDIS_ENABLED ? '✅ Enabled' : '❌ Disabled'}`);
  
  console.log(`\n🎯 Feature Flags:`);
  Object.entries(FEATURES).forEach(([key, value]) => {
    console.log(`   ${key}: ${value ? '✅' : '❌'}`);
  });
  console.log('═'.repeat(50) + '\n');
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Main config object
  ...config,
  
  // Utility exports
  configForLogging,
  logConfigSummary,
  sanitizeForLog,
  parseBoolean,
  parseInteger,
  parseArray,
  requireEnv,
  
  // Direct exports of critical config (for convenience)
  IS_PRODUCTION,
  IS_DEVELOPMENT,
  IS_TEST,
  PORT,
  HOST,
  MONGO_URI,
  JWT_SECRET,
};
