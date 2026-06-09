/**
 * Unique Code Generator for Pebeto Creator's Hub
 * 
 * Generates and manages unique identifiers for creators.
 * Features include:
 * - Configurable prefix, length, and character sets
 * - Collision checking
 * - Code validation
 * - Batch generation
 * 
 * @module utils/uniqueCode
 */

// ============================================
// Constants
// ============================================

const DEFAULT_CONFIG = {
  prefix: 'CR',
  length: 6,
  chars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // Removed ambiguous characters (0, O, I, 1)
  separator: '-',
  uppercase: true,
};

// Character sets for different use cases
const CHARACTER_SETS = {
  // Alphanumeric without ambiguous characters
  SAFE: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  // Numeric only
  NUMERIC: '0123456789',
  // Alphabetic only
  ALPHA: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  // Lowercase safe
  SAFE_LOWER: 'abcdefghijkmnpqrstuvwxyz23456789',
  // Full alphanumeric (includes ambiguous chars - use with caution)
  FULL: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
};

// ============================================
// Core Generation Functions
// ============================================

/**
 * Generate a random string from character set
 * @param {number} length - Length of random string
 * @param {string} chars - Character set to use
 * @returns {string} Random string
 */
function generateRandomString(length, chars = DEFAULT_CONFIG.chars) {
  let result = '';
  const charsLength = chars.length;
  
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * charsLength)];
  }
  
  return result;
}

/**
 * Generate a unique code with optional prefix
 * @param {Object} options - Generation options
 * @param {string} options.prefix - Code prefix (default: 'CR')
 * @param {number} options.length - Length of random part (default: 6)
 * @param {string} options.chars - Character set (default: SAFE)
 * @param {string} options.separator - Separator between prefix and code (default: '-')
 * @param {boolean} options.uppercase - Convert to uppercase (default: true)
 * @returns {string} Generated unique code
 */
function generateUniqueCode(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const randomPart = generateRandomString(config.length, config.chars);
  
  let code = config.prefix + config.separator + randomPart;
  
  if (config.uppercase) {
    code = code.toUpperCase();
  }
  
  return code;
}

/**
 * Generate a unique code without prefix (standalone)
 * @param {number} length - Length of code (default: 8)
 * @param {string} chars - Character set (default: SAFE)
 * @returns {string} Generated code
 */
function generateSimpleCode(length = 8, chars = CHARACTER_SETS.SAFE) {
  return generateRandomString(length, chars);
}

/**
 * Generate multiple unique codes at once
 * @param {number} count - Number of codes to generate
 * @param {Object} options - Generation options
 * @returns {string[]} Array of generated codes
 */
function generateMultipleCodes(count, options = {}) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(generateUniqueCode(options));
  }
  return codes;
}

/**
 * Generate a unique code that doesn't exist in database
 * @param {Object} model - Mongoose model to check against
 * @param {string} field - Field name to check (default: 'uniqueCode')
 * @param {Object} options - Generation options
 * @param {number} maxAttempts - Maximum attempts before error (default: 10)
 * @returns {Promise<string>} Unique code
 */
async function generateUniqueCodeWithCollisionCheck(model, field = 'uniqueCode', options = {}, maxAttempts = 10) {
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    const code = generateUniqueCode(options);
    const existing = await model.findOne({ [field]: code });
    
    if (!existing) {
      return code;
    }
    
    attempts++;
  }
  
  throw new Error(`Failed to generate unique code after ${maxAttempts} attempts`);
}

// ============================================
// Validation Functions
// ============================================

/**
 * Validate a unique code format
 * @param {string} code - Code to validate
 * @param {Object} options - Validation options
 * @returns {boolean} True if valid
 */
function isValidCodeFormat(code, options = {}) {
  if (!code || typeof code !== 'string') return false;
  
  const config = { ...DEFAULT_CONFIG, ...options };
  const pattern = new RegExp(
    `^${config.prefix}${config.separator}[${config.chars}]{${config.length}}$`,
    'i'
  );
  
  return pattern.test(code);
}

/**
 * Validate a simple code format (no prefix)
 * @param {string} code - Code to validate
 * @param {number} length - Expected length (default: 8)
 * @param {string} chars - Character set to validate against
 * @returns {boolean} True if valid
 */
function isValidSimpleCode(code, length = 8, chars = CHARACTER_SETS.SAFE) {
  if (!code || typeof code !== 'string') return false;
  if (code.length !== length) return false;
  
  const charSet = new Set(chars.split(''));
  for (const char of code) {
    if (!charSet.has(char)) return false;
  }
  
  return true;
}

/**
 * Extract the random part from a unique code
 * @param {string} code - Full unique code
 * @param {string} separator - Separator used (default: '-')
 * @returns {string|null} Random part or null if invalid
 */
function extractCodePart(code, separator = DEFAULT_CONFIG.separator) {
  if (!code || typeof code !== 'string') return null;
  
  const parts = code.split(separator);
  return parts.length === 2 ? parts[1] : null;
}

/**
 * Extract prefix from a unique code
 * @param {string} code - Full unique code
 * @param {string} separator - Separator used (default: '-')
 * @returns {string|null} Prefix or null if invalid
 */
function extractPrefix(code, separator = DEFAULT_CONFIG.separator) {
  if (!code || typeof code !== 'string') return null;
  
  const parts = code.split(separator);
  return parts.length === 2 ? parts[0] : null;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Generate a verification code (numeric, for email/SMS)
 * @param {number} length - Length of code (default: 6)
 * @returns {string} Numeric verification code
 */
function generateVerificationCode(length = 6) {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return Math.floor(min + Math.random() * (max - min + 1)).toString();
}

/**
 * Generate a transaction reference
 * @param {string} prefix - Optional prefix (default: 'TXN')
 * @returns {string} Transaction reference
 */
function generateTransactionReference(prefix = 'TXN') {
  const timestamp = Date.now().toString(36);
  const random = generateRandomString(6, CHARACTER_SETS.SAFE);
  return `${prefix}_${timestamp}_${random}`.toUpperCase();
}

/**
 * Generate an order ID
 * @returns {string} Order ID
 */
function generateOrderId() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const random = generateRandomString(6, CHARACTER_SETS.NUMERIC);
  return `ORD${year}${month}${day}${random}`;
}

/**
 * Generate a payout reference
 * @param {string} method - Payout method (mpesa, paypal, wire)
 * @returns {string} Payout reference
 */
function generatePayoutReference(method = 'payout') {
  const prefix = method.toUpperCase();
  const timestamp = Date.now();
  const random = generateRandomString(4, CHARACTER_SETS.SAFE);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Sanitize a code (remove special characters, uppercase)
 * @param {string} code - Code to sanitize
 * @returns {string} Sanitized code
 */
function sanitizeCode(code) {
  if (!code) return '';
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ============================================
// Predefined Code Generators
// ============================================

/**
 * Generate creator unique code (CR-XXXXXX format)
 * @returns {string} Creator code
 */
function generateCreatorCode() {
  return generateUniqueCode({ prefix: 'CR', length: 6 });
}

/**
 * Generate campaign code (CAMP-XXXXXX format)
 * @returns {string} Campaign code
 */
function generateCampaignCode() {
  return generateUniqueCode({ prefix: 'CAMP', length: 6 });
}

/**
 * Generate transaction code (TXN-XXXXXX format)
 * @returns {string} Transaction code
 */
function generateTransactionCode() {
  return generateUniqueCode({ prefix: 'TXN', length: 8 });
}

/**
 * Generate referral code (REF-XXXXXX format)
 * @returns {string} Referral code
 */
function generateReferralCode() {
  return generateUniqueCode({ prefix: 'REF', length: 6, chars: CHARACTER_SETS.SAFE });
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Core functions
  generateUniqueCode,
  generateSimpleCode,
  generateMultipleCodes,
  generateUniqueCodeWithCollisionCheck,
  
  // Validation
  isValidCodeFormat,
  isValidSimpleCode,
  extractCodePart,
  extractPrefix,
  
  // Utility
  generateRandomString,
  generateVerificationCode,
  generateTransactionReference,
  generateOrderId,
  generatePayoutReference,
  sanitizeCode,
  
  // Predefined generators
  generateCreatorCode,
  generateCampaignCode,
  generateTransactionCode,
  generateReferralCode,
  
  // Constants
  DEFAULT_CONFIG,
  CHARACTER_SETS,
};
