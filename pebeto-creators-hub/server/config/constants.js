/**
 * Platform Constants & Configuration for Pebeto Creator's Hub
 * 
 * This file contains all global configuration values, fee structures,
 * and platform rules used across the backend and frontend.
 * 
 * @module constants
 */

// ============================================
// Environment Detection
// ============================================

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const IS_DEVELOPMENT = NODE_ENV === 'development';
const IS_TEST = NODE_ENV === 'test';

// ============================================
// Currency Configuration
// ============================================

/** Base currency for all financial transactions */
const BASE_CURRENCY = 'USD';

/** Supported currencies for display and conversion */
const SUPPORTED_CURRENCIES = {
  USD: { symbol: '$', name: 'US Dollar', decimals: 2, rate: 1, region: 'Global' },
  KES: { symbol: 'KSh', name: 'Kenyan Shilling', decimals: 2, rate: 130, region: 'Kenya' },
  EUR: { symbol: '€', name: 'Euro', decimals: 2, rate: 0.92, region: 'Europe' },
  GBP: { symbol: '£', name: 'British Pound', decimals: 2, rate: 0.79, region: 'United Kingdom' },
  NGN: { symbol: '₦', name: 'Nigerian Naira', decimals: 2, rate: 750, region: 'Nigeria' },
  ZAR: { symbol: 'R', name: 'South African Rand', decimals: 2, rate: 18.5, region: 'South Africa' },
  GHS: { symbol: '₵', name: 'Ghanaian Cedi', decimals: 2, rate: 12.5, region: 'Ghana' },
  TZS: { symbol: 'TSh', name: 'Tanzanian Shilling', decimals: 2, rate: 2600, region: 'Tanzania' },
  UGX: { symbol: 'USh', name: 'Ugandan Shilling', decimals: 0, rate: 3800, region: 'Uganda' },
  JPY: { symbol: '¥', name: 'Japanese Yen', decimals: 0, rate: 148, region: 'Japan' },
  CNY: { symbol: '¥', name: 'Chinese Yuan', decimals: 2, rate: 7.24, region: 'China' },
  INR: { symbol: '₹', name: 'Indian Rupee', decimals: 2, rate: 83, region: 'India' },
  CHF: { symbol: 'Fr', name: 'Swiss Franc', decimals: 2, rate: 0.91, region: 'Switzerland' },
  CAD: { symbol: 'C$', name: 'Canadian Dollar', decimals: 2, rate: 1.35, region: 'Canada' },
  AUD: { symbol: 'A$', name: 'Australian Dollar', decimals: 2, rate: 1.52, region: 'Australia' },
  SEK: { symbol: 'kr', name: 'Swedish Krona', decimals: 2, rate: 10.5, region: 'Sweden' },
  NZD: { symbol: 'NZ$', name: 'New Zealand Dollar', decimals: 2, rate: 1.65, region: 'New Zealand' },
  BRL: { symbol: 'R$', name: 'Brazilian Real', decimals: 2, rate: 5.10, region: 'Brazil' },
  MXN: { symbol: '$', name: 'Mexican Peso', decimals: 2, rate: 17.5, region: 'Mexico' },
  SGD: { symbol: 'S$', name: 'Singapore Dollar', decimals: 2, rate: 1.35, region: 'Singapore' },
  MYR: { symbol: 'RM', name: 'Malaysian Ringgit', decimals: 2, rate: 4.70, region: 'Malaysia' },
  THB: { symbol: '฿', name: 'Thai Baht', decimals: 2, rate: 35.5, region: 'Thailand' },
  VND: { symbol: '₫', name: 'Vietnamese Dong', decimals: 0, rate: 24500, region: 'Vietnam' },
  PHP: { symbol: '₱', name: 'Philippine Peso', decimals: 2, rate: 56, region: 'Philippines' },
  IDR: { symbol: 'Rp', name: 'Indonesian Rupiah', decimals: 0, rate: 15500, region: 'Indonesia' },
  PKR: { symbol: '₨', name: 'Pakistani Rupee', decimals: 2, rate: 278, region: 'Pakistan' },
  BDT: { symbol: '৳', name: 'Bangladeshi Taka', decimals: 2, rate: 110, region: 'Bangladesh' },
  LKR: { symbol: 'Rs', name: 'Sri Lankan Rupee', decimals: 2, rate: 320, region: 'Sri Lanka' },
  NPR: { symbol: 'Rs', name: 'Nepalese Rupee', decimals: 2, rate: 133, region: 'Nepal' },
};

/** Array of currency codes for easy iteration */
const CURRENCY_CODES = Object.keys(SUPPORTED_CURRENCIES);

// ============================================
// Fee Structure
// ============================================

/** Platform fee rates (as decimals) */
const FEE_RATES = {
  /** Fee charged when a brand deposits funds (10%) */
  DEPOSIT: 0.10,
  /** Fee charged on creator tips (5% - creator receives 95%) */
  TIP: 0.05,
  /** Fee charged when withdrawing funds (3%) */
  WITHDRAWAL: 0.03,
};

/** Human-readable fee descriptions */
const FEE_DESCRIPTIONS = {
  DEPOSIT: 'Platform fee for funding campaigns',
  TIP: 'Service fee for tips (creator keeps 95%)',
  WITHDRAWAL: 'Withdrawal processing fee',
};

/**
 * Calculate fee amount based on rate and principal
 * @param {number} amount - The principal amount
 * @param {keyof FEE_RATES} feeType - Type of fee to calculate
 * @returns {number} Calculated fee amount (rounded to 2 decimals)
 */
function calculateFee(amount, feeType) {
  const rate = FEE_RATES[feeType];
  if (!rate) throw new Error(`Unknown fee type: ${feeType}`);
  return Math.round((amount * rate) * 100) / 100;
}

/**
 * Calculate net amount after fee
 * @param {number} amount - The principal amount
 * @param {keyof FEE_RATES} feeType - Type of fee to deduct
 * @returns {number} Net amount after fee deduction
 */
function calculateNetAmount(amount, feeType) {
  const fee = calculateFee(amount, feeType);
  return Math.round((amount - fee) * 100) / 100;
}

/**
 * Calculate gross amount needed to achieve a net amount
 * @param {number} netAmount - Desired net amount after fee
 * @param {keyof FEE_RATES} feeType - Type of fee applied
 * @returns {number} Gross amount needed
 */
function calculateGrossAmount(netAmount, feeType) {
  const rate = FEE_RATES[feeType];
  if (!rate) throw new Error(`Unknown fee type: ${feeType}`);
  return Math.round((netAmount / (1 - rate)) * 100) / 100;
}

// ============================================
// Deposit Methods Configuration
// ============================================

/** Supported deposit methods with their configurations */
const DEPOSIT_METHODS_CONFIG = {
  mpesa: {
    name: 'M-Pesa',
    enabled: true,
    region: 'Kenya',
    type: 'mobile_money',
    requiredFields: ['phoneNumber'],
    phoneRegex: /^(254|\+254|0)[7-9][0-9]{8}$/,
    minAmount: 1,
    maxAmount: 1150, // USD equivalent (~150,000 KES)
    processingTime: 'Instant',
    additionalFee: 0,
    feePercentage: 10,
    icon: 'phone',
  },
  paypal: {
    name: 'PayPal',
    enabled: true,
    region: 'Global',
    type: 'digital_wallet',
    requiredFields: ['paypalEmail'],
    emailRegex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    minAmount: 1,
    maxAmount: 10000,
    processingTime: 'Instant',
    additionalFee: 0,
    feePercentage: 10,
    icon: 'paypal',
  },
  wire: {
    name: 'Wire Transfer',
    enabled: true,
    region: 'International',
    type: 'bank_transfer',
    requiredFields: ['bankName', 'accountNumber', 'accountHolderName'],
    minAmount: 100,
    maxAmount: 50000,
    processingTime: '2-5 business days',
    additionalFee: 0,
    feePercentage: 10,
    icon: 'bank',
  },
  card: {
    name: 'Credit/Debit Card',
    enabled: false, // Coming soon
    region: 'Global',
    type: 'card',
    requiredFields: ['cardNumber', 'expiryDate', 'cvv'],
    minAmount: 10,
    maxAmount: 10000,
    processingTime: 'Instant',
    additionalFee: 2.9,
    feePercentage: 10,
    icon: 'card',
  },
  crypto: {
    name: 'Cryptocurrency',
    enabled: false, // Coming soon
    region: 'Global',
    type: 'crypto',
    requiredFields: ['walletAddress', 'currency'],
    minAmount: 50,
    maxAmount: 50000,
    processingTime: '10-30 minutes',
    additionalFee: 0,
    feePercentage: 10,
    icon: 'crypto',
  },
};

/** List of enabled deposit methods */
const DEPOSIT_METHODS = Object.keys(DEPOSIT_METHODS_CONFIG).filter(
  method => DEPOSIT_METHODS_CONFIG[method].enabled
);

// ============================================
// Withdrawal Configuration
// ============================================

/** Minimum withdrawal amount in USD */
const MIN_WITHDRAWAL_USD = 30;

/** Maximum withdrawal amount in USD (null = no limit) */
const MAX_WITHDRAWAL_USD = null;

/** Minimum withdrawal amounts for other currencies */
const MIN_WITHDRAWAL_BY_CURRENCY = {
  USD: 30,
  KES: 4000,
  EUR: 28,
  GBP: 24,
  NGN: 45000,
  ZAR: 550,
  GHS: 400,
  TZS: 78000,
  UGX: 110000,
  JPY: 4500,
  CNY: 215,
  INR: 2500,
  CAD: 40,
  AUD: 45,
  NZD: 48,
};

/** Supported payout methods with their configurations */
const PAYOUT_METHODS_CONFIG = {
  mpesa: {
    name: 'M-Pesa',
    enabled: true,
    region: 'Kenya',
    requiredFields: ['phoneNumber'],
    phoneRegex: /^(254|\+254|0)[7-9][0-9]{8}$/,
    minAmount: 1,
    maxAmount: 1150,
    processingTime: 'Instant to 1 hour',
    additionalFee: 0,
    feePercentage: 3,
  },
  paypal: {
    name: 'PayPal',
    enabled: true,
    region: 'Global',
    requiredFields: ['paypalEmail'],
    emailRegex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    minAmount: 1,
    maxAmount: 10000,
    processingTime: '1-3 business days',
    additionalFee: 0.02, // 2% PayPal fee (estimate)
    feePercentage: 3,
  },
  swift: {
    name: 'Wire Transfer (SWIFT)',
    enabled: true,
    region: 'International',
    requiredFields: ['bankName', 'accountHolderName', 'accountNumber', 'swiftCode'],
    minAmount: 100,
    maxAmount: 50000,
    processingTime: '3-5 business days',
    additionalFee: 15, // Fixed international wire fee in USD
    feePercentage: 3,
  },
  bank_transfer: {
    name: 'Local Bank Transfer',
    enabled: true,
    region: 'Local',
    requiredFields: ['bankName', 'accountNumber', 'accountHolderName'],
    minAmount: 10,
    maxAmount: null,
    processingTime: '1-2 business days',
    additionalFee: 0,
    feePercentage: 3,
  },
};

/** List of enabled payout methods (for backward compatibility) */
const PAYOUT_METHODS = Object.keys(PAYOUT_METHODS_CONFIG).filter(
  method => PAYOUT_METHODS_CONFIG[method].enabled
);

// ============================================
// Campaign Configuration
// ============================================

/** Minimum campaign budget in USD */
const MIN_CAMPAIGN_BUDGET_USD = 10;

/** Maximum campaign budget in USD (null = no limit) */
const MAX_CAMPAIGN_BUDGET_USD = null;

/** Default campaign duration in days */
const DEFAULT_CAMPAIGN_DURATION_DAYS = 30;

/** Maximum campaign duration in days */
const MAX_CAMPAIGN_DURATION_DAYS = 90;

/** Campaign statuses */
const CAMPAIGN_STATUS = {
  DRAFT: 'draft',
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  SUBMITTED_FOR_REVIEW: 'submitted_for_review',
  COMPLETED: 'completed',
  PAID: 'paid',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  DISPUTED: 'disputed',
};

/** Campaign stages for creators */
const CREATOR_STAGES = {
  BID: 'Bid',
  WAITING_APPROVAL: 'Waiting for Approval',
  COMPLETED: 'Completed',
  PAID: 'Paid',
};

/** Campaign stages for businesses */
const BUSINESS_STAGES = {
  ACTIVE: 'Active',
  SUBMITTED_FOR_REVIEW: 'Submitted for Review',
  COMPLETED: 'Completed',
  PAID: 'Paid',
};

// ============================================
// Pagination & Rate Limiting
// ============================================

/** Default items per page for paginated endpoints */
const DEFAULT_PAGE_SIZE = 20;

/** Maximum items per page allowed */
const MAX_PAGE_SIZE = 100;

/** Rate limiting configuration */
const RATE_LIMITS = {
  // Public endpoints
  public: {
    windowMs: 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute
  },
  // Authenticated API
  api: {
    windowMs: 60 * 1000,
    max: 120, // 120 requests per minute
  },
  // Auth endpoints (login/register)
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per 15 minutes
  },
  // Campaign creation
  campaign: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 campaigns per hour per user
  },
  // Bidding
  bid: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 50, // 50 bids per hour per user
  },
  // Deposits
  deposit: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // 20 deposit attempts per hour per user
  },
  // Withdrawals
  withdrawal: {
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: 5, // 5 withdrawal requests per day per user
  },
};

// ============================================
// Cache Configuration
// ============================================

/** Cache TTLs in seconds */
const CACHE_TTL = {
  USER_PROFILE: 300, // 5 minutes
  CAMPAIGN_LIST: 60, // 1 minute
  CAMPAIGN_DETAIL: 300, // 5 minutes
  EXCHANGE_RATES: 3600, // 1 hour
  BALANCE: 30, // 30 seconds
  STATS: 300, // 5 minutes
  PAYMENT_METHODS: 3600, // 1 hour
  CURRENCY_RATES: 3600, // 1 hour
};

// ============================================
// Validation Rules
// ============================================

/** Password requirements */
const PASSWORD_CONFIG = {
  MIN_LENGTH: 8,
  MAX_LENGTH: 100,
  REQUIRE_UPPERCASE: true,
  REQUIRE_LOWERCASE: true,
  REQUIRE_NUMBERS: true,
  REQUIRE_SPECIAL: false,
};

/** Username/display name rules */
const NAME_CONFIG = {
  MIN_LENGTH: 2,
  MAX_LENGTH: 50,
  ALLOWED_CHARS: /^[a-zA-Z0-9\s\-_.]+$/,
};

/** Unique code generation */
const UNIQUE_CODE_CONFIG = {
  PREFIX: 'PBT',
  LENGTH: 8,
  CHARSET: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
};

// ============================================
// File Upload Configuration
// ============================================

/** File upload limits */
const UPLOAD_CONFIG = {
  MAX_FILE_SIZE_MB: 100,
  MAX_FILE_SIZE_BYTES: 100 * 1024 * 1024,
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  ALLOWED_VIDEO_TYPES: ['video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm'],
  ALLOWED_DOCUMENT_TYPES: ['application/pdf', 'application/msword', 'text/plain'],
  MAX_IMAGE_DIMENSION: 4096, // pixels
};

// ============================================
// Session & JWT Configuration
// ============================================

/** JWT token expiry times */
const JWT_EXPIRY = {
  ACCESS: IS_PRODUCTION ? '15m' : '7d',
  REFRESH: '30d',
  EMAIL_VERIFICATION: '24h',
  PASSWORD_RESET: '1h',
};

// ============================================
// Email Templates
// ============================================

const EMAIL_TEMPLATES = {
  WELCOME: 'welcome',
  VERIFY_EMAIL: 'verify-email',
  PASSWORD_RESET: 'password-reset',
  BID_ACCEPTED: 'bid-accepted',
  CAMPAIGN_COMPLETED: 'campaign-completed',
  WITHDRAWAL_PROCESSED: 'withdrawal-processed',
  NEW_CAMPAIGN: 'new-campaign',
  DEPOSIT_CONFIRMED: 'deposit-confirmed',
  PAYMENT_RECEIVED: 'payment-received',
};

// ============================================
// Helper Functions
// ============================================

/**
 * Get currency details by code
 * @param {string} currencyCode - Currency code (e.g., 'USD')
 * @returns {Object|null} Currency details or null if not found
 */
function getCurrencyDetails(currencyCode) {
  return SUPPORTED_CURRENCIES[currencyCode?.toUpperCase()] || null;
}

/**
 * Get deposit method details by method ID
 * @param {string} methodId - Method ID (e.g., 'mpesa')
 * @returns {Object|null} Method details or null if not found
 */
function getDepositMethodDetails(methodId) {
  return DEPOSIT_METHODS_CONFIG[methodId?.toLowerCase()] || null;
}

/**
 * Get payout method details by method ID
 * @param {string} methodId - Method ID (e.g., 'paypal')
 * @returns {Object|null} Method details or null if not found
 */
function getPayoutMethodDetails(methodId) {
  return PAYOUT_METHODS_CONFIG[methodId?.toLowerCase()] || null;
}

/**
 * Check if a currency is supported
 * @param {string} currencyCode - Currency code to check
 * @returns {boolean}
 */
function isCurrencySupported(currencyCode) {
  return !!SUPPORTED_CURRENCIES[currencyCode?.toUpperCase()];
}

// ============================================
// Export Configuration
// ============================================

module.exports = {
  // Environment
  NODE_ENV,
  IS_PRODUCTION,
  IS_DEVELOPMENT,
  IS_TEST,
  
  // Currency
  BASE_CURRENCY,
  SUPPORTED_CURRENCIES,
  CURRENCY_CODES,
  getCurrencyDetails,
  isCurrencySupported,
  
  // Fees
  FEE_RATES,
  FEE_DESCRIPTIONS,
  calculateFee,
  calculateNetAmount,
  calculateGrossAmount,
  
  // Deposit Methods
  DEPOSIT_METHODS_CONFIG,
  DEPOSIT_METHODS,
  getDepositMethodDetails,
  
  // Withdrawals
  MIN_WITHDRAWAL_USD,
  MAX_WITHDRAWAL_USD,
  MIN_WITHDRAWAL_BY_CURRENCY,
  PAYOUT_METHODS,
  PAYOUT_METHODS_CONFIG,
  getPayoutMethodDetails,
  
  // Campaigns
  MIN_CAMPAIGN_BUDGET_USD,
  MAX_CAMPAIGN_BUDGET_USD,
  DEFAULT_CAMPAIGN_DURATION_DAYS,
  MAX_CAMPAIGN_DURATION_DAYS,
  CAMPAIGN_STATUS,
  CREATOR_STAGES,
  BUSINESS_STAGES,
  
  // Pagination & Rate Limiting
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  RATE_LIMITS,
  
  // Cache
  CACHE_TTL,
  
  // Validation
  PASSWORD_CONFIG,
  NAME_CONFIG,
  UNIQUE_CODE_CONFIG,
  
  // Upload
  UPLOAD_CONFIG,
  
  // Session
  JWT_EXPIRY,
  
  // Email
  EMAIL_TEMPLATES,
};
