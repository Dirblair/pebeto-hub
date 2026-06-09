/**
 * Logger Utility for Pebeto Creator's Hub
 * 
 * Provides simple logging with different levels.
 * Can be extended to use more sophisticated logging in production.
 * 
 * @module utils/logger
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};

const currentLogLevel = LOG_LEVELS[process.env.LOG_LEVEL] || LOG_LEVELS.info;

function formatMessage(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  
  // Simple format for now
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
}

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] > currentLogLevel) return;
  
  const formatted = formatMessage(level, message, meta);
  
  switch (level) {
    case 'error':
      console.error(formatted);
      break;
    case 'warn':
      console.warn(formatted);
      break;
    case 'debug':
      console.debug(formatted);
      break;
    default:
      console.log(formatted);
  }
}

const logger = {
  error: (message, meta) => log('error', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  info: (message, meta) => log('info', message, meta),
  debug: (message, meta) => log('debug', message, meta),
  trace: (message, meta) => log('trace', message, meta),
};

module.exports = logger;
