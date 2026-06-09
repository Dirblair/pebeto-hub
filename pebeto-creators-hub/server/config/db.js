/**
 * MongoDB Database Connection Module for Pebeto Creator's Hub
 * 
 * Handles database connections, reconnection logic, connection pooling,
 * and graceful shutdown for production environments.
 * 
 * @module db
 */

const mongoose = require('mongoose');

// ============================================
// HARDCODED MONGODB URI - TEMPORARY FIX
// ============================================
// TODO: Remove this hardcode once environment variable is fixed
const HARDCODED_MONGO_URI = 'mongodb+srv://pebeto:DebbyJenn123%21@pebeto.yggha0f.mongodb.net/pebeto?retryWrites=true&w=majority';

// ============================================
// Configuration
// ============================================

const DEFAULT_OPTIONS = {
  // Connection Pool Settings
  maxPoolSize: 10,           // Maximum number of connections in the pool
  minPoolSize: 2,            // Minimum number of connections to keep open
  maxIdleTimeMS: 30000,      // How long a connection can stay idle before being closed
  waitQueueTimeoutMS: 30000, // How long a operation will wait for a connection
  
  // Socket Settings
  socketTimeoutMS: 45000,     // How long a socket can stay open without activity
  connectTimeoutMS: 10000,    // How long to wait for a connection to be established
  heartbeatFrequencyMS: 10000, // How often to check the health of the connection
  
  // Server Selection
  serverSelectionTimeoutMS: 15000, // How long to wait for server selection
  
  // Write Concerns
  w: 'majority',              // Write concern level
  wtimeoutMS: 5000,          // Timeout for write concern
  
  // Retry Logic
  retryWrites: true,          // Automatically retry write operations
  retryReads: true,           // Automatically retry read operations
  
  // Other
  family: 4,                  // Use IPv4, skip trying IPv6
  autoIndex: process.env.NODE_ENV !== 'production', // Auto-index only in dev
};

// ============================================
// Connection State Management
// ============================================

let isConnected = false;
let connectionPromise = null;

/**
 * Get current connection state
 * @returns {Object} Connection state information
 */
function getConnectionState() {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
    99: 'uninitialized',
  };
  
  const stateCode = mongoose.connection.readyState;
  return {
    code: stateCode,
    state: states[stateCode] || 'unknown',
    isConnected: stateCode === 1,
  };
}

/**
 * Log connection events with appropriate level based on environment
 * @param {string} message - Log message
 * @param {string} level - Log level (info, warn, error, debug)
 */
function logConnectionEvent(message, level = 'info') {
  const isDev = process.env.NODE_ENV !== 'production';
  
  switch (level) {
    case 'error':
      console.error(`[DB] ${message}`);
      break;
    case 'warn':
      console.warn(`[DB] ${message}`);
      break;
    case 'debug':
      if (isDev) console.log(`[DB DEBUG] ${message}`);
      break;
    default:
      console.log(`[DB] ${message}`);
  }
}

// ============================================
// Event Handlers
// ============================================

/**
 * Setup mongoose connection event listeners
 * These monitor the health of the database connection
 */
function setupEventListeners() {
  // Connection events
  mongoose.connection.on('connected', () => {
    isConnected = true;
    logConnectionEvent('MongoDB connected successfully');
  });
  
  mongoose.connection.on('error', (err) => {
    isConnected = false;
    logConnectionEvent(`MongoDB connection error: ${err.message}`, 'error');
  });
  
  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    logConnectionEvent('MongoDB disconnected', 'warn');
  });
  
  mongoose.connection.on('reconnected', () => {
    isConnected = true;
    logConnectionEvent('MongoDB reconnected successfully');
  });
  
  mongoose.connection.on('reconnectFailed', () => {
    logConnectionEvent('MongoDB reconnection failed after all attempts', 'error');
  });
  
  // Connection pool events
  mongoose.connection.on('connectionCreated', () => {
    logConnectionEvent('Connection pool: new connection created', 'debug');
  });
  
  mongoose.connection.on('connectionClosed', () => {
    logConnectionEvent('Connection pool: connection closed', 'debug');
  });
  
  // Handle application termination
  process.on('SIGINT', handleGracefulShutdown);
  process.on('SIGTERM', handleGracefulShutdown);
}

// ============================================
// Reconnection Logic
// ============================================

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_BASE = 1000; // Start with 1 second

/**
 * Attempt to reconnect with exponential backoff
 * @param {Function} connectFn - Function to call for reconnection
 * @returns {Promise<void>}
 */
async function attemptReconnection(connectFn) {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logConnectionEvent(`Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Exiting...`, 'error');
    process.exit(1);
  }
  
  const delay = RECONNECT_DELAY_BASE * Math.pow(2, reconnectAttempts);
  reconnectAttempts++;
  
  logConnectionEvent(`Reconnection attempt ${reconnectAttempts} in ${delay}ms...`, 'warn');
  
  await new Promise(resolve => setTimeout(resolve, delay));
  
  try {
    await connectFn();
    reconnectAttempts = 0; // Reset on successful connection
  } catch (error) {
    logConnectionEvent(`Reconnection attempt ${reconnectAttempts} failed: ${error.message}`, 'error');
    await attemptReconnection(connectFn);
  }
}

// ============================================
// Graceful Shutdown
// ============================================

let isShuttingDown = false;

/**
 * Gracefully close database connection on application termination
 * @param {string} signal - The signal that triggered the shutdown
 */
async function handleGracefulShutdown(signal) {
  if (isShuttingDown) {
    logConnectionEvent('Already shutting down, ignoring signal', 'warn');
    return;
  }
  
  isShuttingDown = true;
  logConnectionEvent(`Received ${signal}. Starting graceful shutdown...`, 'warn');
  
  try {
    // Close mongoose connection
    await mongoose.connection.close();
    logConnectionEvent('MongoDB connection closed successfully');
    
    // Exit with success
    process.exit(0);
  } catch (error) {
    logConnectionEvent(`Error during graceful shutdown: ${error.message}`, 'error');
    process.exit(1);
  }
}

// ============================================
// Connection URI Validation & Enhancement
// ============================================

/**
 * Validate and optionally enhance the connection URI
 * @param {string} uri - MongoDB connection URI
 * @returns {string} Validated URI
 * @throws {Error} If URI is invalid
 */
function validateUri(uri) {
  // DEBUG: Log what we received
  console.log('🔍 [DB] validateUri received:', uri ? uri.substring(0, 60) + '...' : 'UNDEFINED or EMPTY');
  
  if (!uri) {
    console.error('❌ [DB] MONGO_URI is missing or empty!');
    throw new Error('MongoDB connection URI is required');
  }
  
  if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) {
    console.error('❌ [DB] Invalid URI format. Must start with mongodb:// or mongodb+srv://');
    console.error('❌ [DB] Received URI starts with:', uri.substring(0, 20));
    throw new Error('Invalid MongoDB connection URI. Must start with mongodb:// or mongodb+srv://');
  }
  
  // Warn if using localhost in production
  if (process.env.NODE_ENV === 'production' && uri.includes('localhost')) {
    logConnectionEvent('WARNING: Using localhost MongoDB in production!', 'warn');
  }
  
  console.log('✅ [DB] URI validation passed');
  return uri;
}

/**
 * Get default database name from URI or environment
 * @param {string} uri - MongoDB connection URI
 * @returns {string} Database name
 */
function getDatabaseName(uri) {
  // Try to extract from URI
  const match = uri.match(/\/([^/?]+)(\?|$)/);
  if (match && match[1]) {
    return match[1];
  }
  
  // Fallback to environment variable
  return process.env.DB_NAME || 'pebeto';
}

// ============================================
// Main Connection Function
// ============================================

/**
 * Connect to MongoDB database with retry logic and event monitoring
 * @param {string} uri - MongoDB connection URI (parameter kept for compatibility, but we use hardcoded)
 * @param {Object} options - Additional mongoose options (will merge with defaults)
 * @returns {Promise<mongoose.Connection>} Mongoose connection instance
 */
async function connectDB(uri, options = {}) {
  // USING HARDCODED URI - IGNORING THE PARAMETER
  console.log('🔍 [DB] Using HARDCODED MongoDB URI (temporary fix)');
  console.log('🔍 [DB] Hardcoded URI:', HARDCODED_MONGO_URI.substring(0, 60) + '...');
  
  // Validate the hardcoded URI
  const validatedUri = validateUri(HARDCODED_MONGO_URI);
  
  // Check if already connected
  const state = getConnectionState();
  if (state.isConnected) {
    logConnectionEvent('Already connected to MongoDB');
    return mongoose.connection;
  }
  
  // Check if connection is in progress
  if (connectionPromise) {
    logConnectionEvent('Connection already in progress, waiting...', 'debug');
    return connectionPromise;
  }
  
  // Merge options with defaults
  const connectionOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  
  // Apply strictQuery based on environment
  mongoose.set('strictQuery', process.env.NODE_ENV === 'production');
  
  // Setup event listeners (only once)
  if (!mongoose.connection._hasListeners) {
    setupEventListeners();
    mongoose.connection._hasListeners = true;
  }
  
  // Create connection promise
  connectionPromise = (async () => {
    try {
      // Mask password in log
      const maskedUri = validatedUri.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@');
      logConnectionEvent(`Connecting to MongoDB at: ${maskedUri}`, 'debug');
      
      await mongoose.connect(validatedUri, connectionOptions);
      
      const dbName = getDatabaseName(validatedUri);
      logConnectionEvent(`Connected to database: ${dbName}`);
      logConnectionEvent(`Connection pool size: ${connectionOptions.maxPoolSize}`);
      
      connectionPromise = null;
      return mongoose.connection;
      
    } catch (error) {
      connectionPromise = null;
      logConnectionEvent(`Initial connection failed: ${error.message}`, 'error');
      
      // Attempt reconnection instead of exiting immediately
      if (process.env.NODE_ENV === 'production') {
        logConnectionEvent('Attempting to reconnect...', 'warn');
        await attemptReconnection(() => connectDB(uri, options));
      } else {
        // In development, throw error for debugging
        throw error;
      }
    }
  })();
  
  return connectionPromise;
}

// ============================================
// Connection Management Helpers
// ============================================

/**
 * Disconnect from MongoDB (useful for testing or graceful shutdown)
 * @returns {Promise<void>}
 */
async function disconnectDB() {
  if (isShuttingDown) {
    logConnectionEvent('Shutdown already in progress', 'warn');
    return;
  }
  
  isShuttingDown = true;
  
  try {
    await mongoose.disconnect();
    isConnected = false;
    logConnectionEvent('Disconnected from MongoDB');
  } catch (error) {
    logConnectionEvent(`Error disconnecting: ${error.message}`, 'error');
    throw error;
  } finally {
    isShuttingDown = false;
  }
}

/**
 * Check if database is connected
 * @returns {boolean}
 */
function isDatabaseConnected() {
  return isConnected && mongoose.connection.readyState === 1;
}

/**
 * Get database connection health information
 * @returns {Object} Health metrics
 */
function getDatabaseHealth() {
  const state = getConnectionState();
  const poolSize = mongoose.connection?.client?.topology?.s?.pool?.size() || 0;
  
  return {
    connected: state.isConnected,
    state: state.state,
    poolSize,
    host: mongoose.connection?.host || null,
    port: mongoose.connection?.port || null,
    name: mongoose.connection?.name || null,
    uptime: isConnected ? process.uptime() : null,
  };
}

/**
 * Ping database to check connectivity
 * @returns {Promise<boolean>}
 */
async function pingDatabase() {
  if (!isDatabaseConnected()) {
    return false;
  }
  
  try {
    await mongoose.connection.db.admin().ping();
    return true;
  } catch (error) {
    logConnectionEvent(`Ping failed: ${error.message}`, 'error');
    return false;
  }
}

/**
 * Get connection statistics
 * @returns {Object} Connection stats
 */
function getConnectionStats() {
  const topology = mongoose.connection?.client?.topology;
  
  if (!topology) {
    return { available: false };
  }
  
  return {
    available: true,
    poolSize: topology.s?.pool?.size() || 0,
    connectionsInUse: topology.s?.pool?.connectionsInUse() || 0,
    pendingRequests: topology.s?.pool?.pendingRequests() || 0,
    totalConnectionsCreated: topology.s?.pool?.totalCreated() || 0,
  };
}

// ============================================
// Export
// ============================================

module.exports = {
  connectDB,
  disconnectDB,
  isDatabaseConnected,
  getDatabaseHealth,
  getConnectionState,
  pingDatabase,
  getConnectionStats,
  DEFAULT_OPTIONS,
};
