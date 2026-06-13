/**
 * Helper Utilities for Pebeto Creator's Hub
 * 
 * Common utility functions used across the application.
 * 
 * @module utils/helpers
 */

const crypto = require('crypto');

// ============================================
// String Helpers
// ============================================

/**
 * Truncate a string to a maximum length
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length
 * @param {string} suffix - Suffix to add (default: '...')
 * @returns {string} Truncated string
 */
function truncate(str, maxLength = 100, suffix = '...') {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * Capitalize first letter of a string
 * @param {string} str - String to capitalize
 * @returns {string} Capitalized string
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Convert string to slug (URL-friendly)
 * @param {string} str - String to slugify
 * @returns {string} Slugified string
 */
function slugify(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generate a random string
 * @param {number} length - Length of random string
 * @returns {string} Random string
 */
function randomString(length = 8) {
  return crypto.randomBytes(length).toString('hex').substring(0, length);
}

/**
 * Generate a random number between min and max
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Random number
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ============================================
// Date Helpers
// ============================================

/**
 * Format date to relative time string (e.g., "2 hours ago")
 * @param {Date|string} date - Date to format
 * @returns {string} Relative time string
 */
function timeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years !== 1 ? 's' : ''} ago`;
}

/**
 * Check if a date is expired
 * @param {Date|string} date - Date to check
 * @returns {boolean} True if expired
 */
function isExpired(date) {
  return new Date(date) < new Date();
}

/**
 * Add days to a date
 * @param {Date} date - Starting date
 * @param {number} days - Number of days to add
 * @returns {Date} New date
 */
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Get start and end of day
 * @param {Date} date - Date to get range for
 * @returns {Object} Start and end of day
 */
function getDayRange(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * Get start and end of month
 * @param {Date} date - Date to get range for
 * @returns {Object} Start and end of month
 */
function getMonthRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

// ============================================
// Object/Array Helpers
// ============================================

/**
 * Deep clone an object
 * @param {Object} obj - Object to clone
 * @returns {Object} Cloned object
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Pick specific fields from an object
 * @param {Object} obj - Source object
 * @param {Array} keys - Keys to pick
 * @returns {Object} Picked object
 */
function pick(obj, keys) {
  const result = {};
  keys.forEach(key => {
    if (obj && obj[key] !== undefined) {
      result[key] = obj[key];
    }
  });
  return result;
}

/**
 * Omit specific fields from an object
 * @param {Object} obj - Source object
 * @param {Array} keys - Keys to omit
 * @returns {Object} Object without omitted keys
 */
function omit(obj, keys) {
  const result = { ...obj };
  keys.forEach(key => {
    delete result[key];
  });
  return result;
}

/**
 * Chunk array into smaller arrays
 * @param {Array} arr - Array to chunk
 * @param {number} size - Chunk size
 * @returns {Array} Chunked array
 */
function chunkArray(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/**
 * Remove duplicates from array
 * @param {Array} arr - Array with potential duplicates
 * @returns {Array} Array without duplicates
 */
function uniqueArray(arr) {
  return [...new Set(arr)];
}

// ============================================
// Validation Helpers
// ============================================

/**
 * Check if a string is a valid email
 * @param {string} email - Email to validate
 * @returns {boolean} True if valid
 */
function isValidEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

/**
 * Check if a string is a valid phone number (Kenyan format)
 * @param {string} phone - Phone number to validate
 * @returns {boolean} True if valid
 */
function isValidPhoneNumber(phone) {
  const regex = /^(254|\+254|0)[7-9][0-9]{8}$/;
  return regex.test(phone);
}

/**
 * Check if a string is a valid URL
 * @param {string} url - URL to validate
 * @returns {boolean} True if valid
 */
function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a string is a valid MongoDB ObjectId
 * @param {string} id - ID to validate
 * @returns {boolean} True if valid
 */
function isValidObjectId(id) {
  return /^[0-9a-fA-F]{24}$/.test(id);
}

// ============================================
// Security Helpers
// ============================================

/**
 * Mask sensitive data (e.g., email, phone)
 * @param {string} value - Value to mask
 * @param {number} visibleStart - Number of characters to show at start
 * @param {number} visibleEnd - Number of characters to show at end
 * @returns {string} Masked value
 */
function maskValue(value, visibleStart = 2, visibleEnd = 2) {
  if (!value) return '';
  if (value.length <= visibleStart + visibleEnd) return '*'.repeat(value.length);
  const start = value.substring(0, visibleStart);
  const end = value.substring(value.length - visibleEnd);
  const stars = '*'.repeat(value.length - visibleStart - visibleEnd);
  return `${start}${stars}${end}`;
}

/**
 * Mask email address
 * @param {string} email - Email to mask
 * @returns {string} Masked email
 */
function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return maskValue(email, 2, 2);
  const maskedLocal = maskValue(local, 2, 2);
  return `${maskedLocal}@${domain}`;
}

/**
 * Generate a simple hash from a string
 * @param {string} str - String to hash
 * @returns {string} Hash
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

// ============================================
// Exports
// ============================================

module.exports = {
  // String helpers
  truncate,
  capitalize,
  slugify,
  randomString,
  randomInt,
  
  // Date helpers
  timeAgo,
  isExpired,
  addDays,
  getDayRange,
  getMonthRange,
  
  // Object/Array helpers
  deepClone,
  pick,
  omit,
  chunkArray,
  uniqueArray,
  
  // Validation helpers
  isValidEmail,
  isValidPhoneNumber,
  isValidUrl,
  isValidObjectId,
  
  // Security helpers
  maskValue,
  maskEmail,
  simpleHash,
};
