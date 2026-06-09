/**
 * Withdrawal Service for Pebeto Creator's Hub
 * 
 * Handles withdrawal processing including:
 * - Validation and fee calculation
 * - Multi-currency support
 * - Multiple payout methods (M-Pesa, PayPal, Wire Transfer, Bank Transfer)
 * - Provider dispatch and callback handling
 * - Transaction recording
 * 
 * @module services/withdrawalService
 */

const { PAYOUT_METHODS, PAYOUT_METHODS_CONFIG, MIN_WITHDRAWAL_USD } = require('../config/constants');
const { AppError } = require('../utils/errors');
const { calculateWithdrawal, roundUsd } = require('../services/feeService');
const { getRatesMap, convertLocalToUsd, convertUsdToLocal } = require('./exchangeRateService');
const { sendMpesaB2C } = require('./mpesaService');
const {
  getOrCreateWallet,
  getAdminProfitWallet,
  recordTransaction,
  debitWithdrawable,
  creditWallet,
  runInTransaction,
} = require('./walletService');
const logger = require('../utils/logger');

// ============================================
// Constants
// ============================================

const WITHDRAWAL_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

// ============================================
// Payout Validation
// ============================================

/**
 * Validate payout details based on method
 * @param {string} method - Payout method (mpesa, paypal, swift, bank_transfer)
 * @param {Object} details - Payout details object
 * @returns {Object} Validated details
 * @throws {AppError} If validation fails
 */
function validatePayoutDetails(method, details = {}) {
  const config = PAYOUT_METHODS_CONFIG[method];
  
  if (!config || !config.enabled) {
    throw new AppError(`Invalid or disabled payout method: ${method}`, 400);
  }
  
  switch (method) {
    case 'mpesa':
      if (!details.phoneNumber) {
        throw new AppError('M-Pesa phone number is required', 400);
      }
      // Validate Kenyan phone number format
      const phoneRegex = /^(254|\+254|0)[7-9][0-9]{8}$/;
      if (!phoneRegex.test(details.phoneNumber)) {
        throw new AppError('Invalid M-Pesa phone number format. Use 07XX XXX XXX or 2547XX XXX XXX', 400);
      }
      break;
      
    case 'paypal':
      if (!details.paypalEmail) {
        throw new AppError('PayPal email is required', 400);
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(details.paypalEmail)) {
        throw new AppError('Invalid PayPal email format', 400);
      }
      break;
      
    case 'swift':
      if (!details.bankName) {
        throw new AppError('Bank name is required for SWIFT transfer', 400);
      }
      if (!details.accountNumber) {
        throw new AppError('Account number is required for SWIFT transfer', 400);
      }
      if (!details.swiftCode) {
        throw new AppError('SWIFT/BIC code is required for international transfer', 400);
      }
      if (!details.accountHolderName) {
        throw new AppError('Account holder name is required', 400);
      }
      break;
      
    case 'bank_transfer':
      if (!details.bankName) {
        throw new AppError('Bank name is required', 400);
      }
      if (!details.accountNumber) {
        throw new AppError('Account number is required', 400);
      }
      if (!details.accountHolderName) {
        throw new AppError('Account holder name is required', 400);
      }
      break;
      
    default:
      throw new AppError(`Unsupported payout method: ${method}`, 400);
  }
  
  return details;
}

/**
 * Get minimum withdrawal amount for a specific method and currency
 * @param {string} method - Payout method
 * @param {string} currency - Currency code
 * @returns {number} Minimum amount
 */
function getMinWithdrawalAmount(method, currency = 'USD') {
  const config = PAYOUT_METHODS_CONFIG[method];
  const minAmount = config?.minAmount || MIN_WITHDRAWAL_USD;
  
  if (currency === 'USD') return minAmount;
  
  // Convert to local currency using approximate rates
  const rates = {
    KES: 130,
    EUR: 0.92,
    GBP: 0.79,
    NGN: 750,
    ZAR: 18.5,
    GHS: 12.5,
  };
  const rate = rates[currency] || 1;
  return Math.ceil(minAmount * rate);
}

// ============================================
// Provider Dispatch Functions
// ============================================

/**
 * Dispatch payout to M-Pesa
 * @param {Object} params - Payout parameters
 * @returns {Promise<Object>} Payout result
 */
async function dispatchMpesaPayout({ amount, phoneNumber, reference }) {
  try {
    // Convert USD to KES (M-Pesa uses KES)
    const rates = await getRatesMap();
    const amountKes = Math.round(amount * (rates.KES || 130));
    
    logger.info('Dispatching M-Pesa B2C payout', {
      phoneNumber: phoneNumber.slice(-6),
      amountUsd: amount,
      amountKes,
      reference,
    });
    
    const result = await sendMpesaB2C({
      phoneNumber,
      amount: amountKes,
      commandId: 'BusinessPayment',
      remarks: `Pebeto withdrawal ${reference}`,
    });
    
    return {
      success: true,
      provider: 'mpesa',
      reference: result.conversationId || result.originatorConversationId,
      message: 'M-Pesa payment sent successfully',
    };
  } catch (error) {
    logger.error('M-Pesa payout failed', {
      error: error.message,
      phoneNumber: phoneNumber?.slice(-6),
      amount,
    });
    throw new AppError(`M-Pesa payout failed: ${error.message}`, 502);
  }
}

/**
 * Dispatch payout to PayPal
 * @param {Object} params - Payout parameters
 * @returns {Promise<Object>} Payout result
 */
async function dispatchPaypalPayout({ amount, email, reference }) {
  try {
    // TODO: Implement actual PayPal Payouts API integration
    // This is a placeholder for the actual implementation
    logger.info('Dispatching PayPal payout', {
      email,
      amount,
      reference,
    });
    
    // Simulate API call (replace with actual PayPal Payouts API)
    // const result = await paypal.payouts.create({
    //   sender_batch_header: {
    //     sender_batch_id: reference,
    //     email_subject: 'Pebeto Withdrawal',
    //   },
    //   items: [{
    //     recipient_type: 'EMAIL',
    //     amount: { value: amount, currency: 'USD' },
    //     receiver: email,
    //     note: 'Thank you for using Pebeto!',
    //     sender_item_id: reference,
    //   }],
    // });
    
    return {
      success: true,
      provider: 'paypal',
      reference: `PAYPAL_${Date.now()}_${reference}`,
      message: 'PayPal payout processed successfully',
    };
  } catch (error) {
    logger.error('PayPal payout failed', {
      error: error.message,
      email,
      amount,
    });
    throw new AppError(`PayPal payout failed: ${error.message}`, 502);
  }
}

/**
 * Dispatch payout via SWIFT/Wire Transfer
 * @param {Object} params - Payout parameters
 * @returns {Promise<Object>} Payout result
 */
async function dispatchWirePayout({ amount, currency, bankDetails, reference }) {
  try {
    const { bankName, accountNumber, swiftCode, accountHolderName, iban, routingNumber } = bankDetails;
    
    logger.info('Dispatching wire transfer payout', {
      bankName,
      accountNumber: accountNumber.slice(-4),
      swiftCode,
      amount,
      currency,
      reference,
    });
    
    // TODO: Implement actual Bank/Wire transfer API integration
    // This could connect to:
    // - Stripe Connect
    // - Wise (formerly TransferWise)
    // - Banking API (Plaid, etc.)
    // - Manual processing queue
    
    // For now, return success for manual processing
    return {
      success: true,
      provider: 'wire',
      reference: `WIRE_${Date.now()}_${reference}`,
      message: 'Wire transfer initiated. Funds will arrive in 2-5 business days.',
      estimatedDays: 3,
    };
  } catch (error) {
    logger.error('Wire transfer payout failed', {
      error: error.message,
      bankName: bankDetails?.bankName,
      amount,
    });
    throw new AppError(`Wire transfer failed: ${error.message}`, 502);
  }
}

/**
 * Dispatch payout to appropriate provider
 * @param {Object} params - Payout parameters
 * @returns {Promise<Object>} Payout result
 */
async function dispatchPayoutToProvider({ amount, method, details, reference }) {
  switch (method) {
    case 'mpesa':
      return dispatchMpesaPayout({
        amount,
        phoneNumber: details.phoneNumber,
        reference,
      });
      
    case 'paypal':
      return dispatchPaypalPayout({
        amount,
        email: details.paypalEmail,
        reference,
      });
      
    case 'swift':
      return dispatchWirePayout({
        amount,
        currency: 'USD',
        bankDetails: {
          bankName: details.bankName,
          accountNumber: details.accountNumber,
          swiftCode: details.swiftCode,
          accountHolderName: details.accountHolderName,
          iban: details.iban,
          routingNumber: details.routingNumber,
        },
        reference,
      });
      
    case 'bank_transfer':
      return dispatchWirePayout({
        amount,
        currency: details.currency || 'USD',
        bankDetails: {
          bankName: details.bankName,
          accountNumber: details.accountNumber,
          accountHolderName: details.accountHolderName,
          routingNumber: details.routingNumber,
          iban: details.iban,
        },
        reference,
      });
      
    default:
      throw new AppError(`Unsupported payout method: ${method}`, 400);
  }
}

// ============================================
// Withdrawal Processing Functions
// ============================================

/**
 * Validate withdrawal request and calculate fees
 * @param {Object} params - Withdrawal parameters
 * @param {string} params.role - User role (admin, creator, business)
 * @param {number} params.amountUsd - Amount in USD (optional)
 * @param {number} params.amountLocal - Amount in local currency (optional)
 * @param {string} params.currency - Currency code for local amount
 * @returns {Promise<Object>} Validated withdrawal breakdown
 */
async function previewWithdrawal({ role, amountUsd, amountLocal, currency }) {
  let grossUsd = amountUsd;
  
  if (amountLocal && currency) {
    const rates = await getRatesMap();
    grossUsd = convertLocalToUsd(amountLocal, currency, rates);
  }
  
  if (!grossUsd || grossUsd <= 0) {
    throw new AppError('Withdrawal amount must be positive', 400);
  }
  
  const breakdown = calculateWithdrawal(grossUsd, role);
  
  // Check minimum withdrawal
  if (role !== 'admin' && grossUsd < MIN_WITHDRAWAL_USD) {
    throw new AppError(`Minimum withdrawal amount is $${MIN_WITHDRAWAL_USD} USD`, 400);
  }
  
  const rates = await getRatesMap();
  const displayAmount = amountLocal || grossUsd;
  const displayCurrency = currency || 'USD';
  
  return {
    grossUsd: breakdown.grossUsd,
    feeUsd: breakdown.feeUsd,
    netToUserUsd: breakdown.netToUserUsd,
    feeRate: breakdown.feeRate,
    feePercentage: breakdown.feePercentage,
    feeSource: breakdown.feeSource,
    adminExempt: breakdown.adminExempt,
    displayCurrency,
    displayAmount,
    exchangeRateUsed: currency ? rates[currency] : 1,
    meetsMinimum: grossUsd >= MIN_WITHDRAWAL_USD,
    minimumRequired: MIN_WITHDRAWAL_USD,
  };
}

/**
 * Process a withdrawal request
 * @param {Object} params - Withdrawal parameters
 * @param {Object} params.user - User object
 * @param {number} params.amountUsd - Amount in USD (optional)
 * @param {number} params.amountLocal - Amount in local currency (optional)
 * @param {string} params.currency - Currency code for local amount
 * @param {string} params.payoutMethod - Payout method (mpesa, paypal, swift, bank_transfer)
 * @param {Object} params.payoutDetails - Payout details for the method
 * @param {string} params.idempotencyKey - Optional idempotency key
 * @returns {Promise<Object>} Withdrawal result
 */
async function processWithdrawal({
  user,
  amountUsd,
  amountLocal,
  currency,
  payoutMethod,
  payoutDetails,
  idempotencyKey = null,
}) {
  // Validate payout details
  validatePayoutDetails(payoutMethod, payoutDetails);
  
  // Calculate withdrawal breakdown
  const rates = await getRatesMap();
  let grossUsd = amountUsd;
  
  if (amountLocal && currency) {
    grossUsd = convertLocalToUsd(amountLocal, currency, rates);
  }
  
  if (!grossUsd || grossUsd <= 0) {
    throw new AppError('Withdrawal amount must be positive', 400);
  }
  
  const breakdown = calculateWithdrawal(grossUsd, user.role);
  
  // Check minimum withdrawal (skip for admin)
  if (user.role !== 'admin' && grossUsd < MIN_WITHDRAWAL_USD) {
    throw new AppError(`Minimum withdrawal amount is $${MIN_WITHDRAWAL_USD} USD`, 400);
  }
  
  // Get user wallet
  const userWallet = await getOrCreateWallet(user._id);
  
  // Calculate total withdrawable balance
  const withdrawable = userWallet.balances.available + userWallet.balances.tips;
  if (withdrawable < breakdown.grossUsd) {
    throw new AppError(
      `Insufficient balance. Available: $${withdrawable}, Requested: $${breakdown.grossUsd}`,
      400
    );
  }
  
  // Get admin profit wallet for fee
  const { admin, wallet: profitWallet } = await getAdminProfitWallet();
  
  // Check for duplicate idempotency key
  if (idempotencyKey) {
    const existing = await checkExistingWithdrawal(idempotencyKey);
    if (existing) {
      logger.warn('Duplicate withdrawal attempt blocked', { idempotencyKey, userId: user._id });
      throw new AppError('Duplicate withdrawal request detected', 409);
    }
  }
  
  let withdrawalTx;
  let payoutResult;
  
  await runInTransaction(async (session) => {
    // Debit user's withdrawable balance (available first, then tips)
    await debitWithdrawable(userWallet._id, breakdown.grossUsd, session);
    
    // Record withdrawal transaction (pending initially)
    withdrawalTx = await recordTransaction(
      {
        type: 'withdrawal',
        status: WITHDRAWAL_STATUS.PENDING,
        fromUserId: user._id,
        toUserId: user._id,
        fromWalletId: userWallet._id,
        toWalletId: userWallet._id,
        grossAmount: breakdown.grossUsd,
        feeAmount: breakdown.feeUsd,
        netAmount: breakdown.netToUserUsd,
        feeRate: breakdown.feeRate,
        feeSource: breakdown.feeSource,
        feeRecipient: breakdown.feeUsd > 0 ? admin._id : undefined,
        metadata: {
          payoutMethod,
          payoutDetails,
          displayCurrency: currency || 'USD',
          displayAmount: amountLocal || grossUsd,
          exchangeRateUsed: currency ? rates[currency] : 1,
          idempotencyKey,
          initiatedAt: new Date(),
        },
      },
      session
    );
    
    // If there's a fee, credit admin profit wallet
    if (breakdown.feeUsd > 0 && profitWallet) {
      await creditWallet(profitWallet._id, 'available', breakdown.feeUsd, session);
      
      await recordTransaction(
        {
          type: 'platform_fee',
          status: WITHDRAWAL_STATUS.COMPLETED,
          fromUserId: user._id,
          toUserId: admin._id,
          fromWalletId: userWallet._id,
          toWalletId: profitWallet._id,
          grossAmount: breakdown.feeUsd,
          feeAmount: breakdown.feeUsd,
          netAmount: breakdown.feeUsd,
          feeRate: breakdown.feeRate,
          feeSource: 'withdrawal',
          feeRecipient: admin._id,
          metadata: {
            withdrawalId: withdrawalTx._id,
            note: 'Withdrawal platform fee',
          },
        },
        session
      );
    }
  });
  
  // Dispatch payout to provider (outside transaction to avoid long locks)
  try {
    withdrawalTx.status = WITHDRAWAL_STATUS.PROCESSING;
    await withdrawalTx.save();
    
    payoutResult = await dispatchPayoutToProvider({
      amount: breakdown.netToUserUsd,
      method: payoutMethod,
      details: payoutDetails,
      reference: withdrawalTx.transactionId,
    });
    
    // Update transaction with provider reference
    withdrawalTx.status = WITHDRAWAL_STATUS.COMPLETED;
    withdrawalTx.completedAt = new Date();
    withdrawalTx.referenceId = payoutResult.reference;
    withdrawalTx.metadata.providerReference = payoutResult.reference;
    withdrawalTx.metadata.providerResponse = payoutResult;
    withdrawalTx.metadata.completedAt = new Date();
    await withdrawalTx.save();
    
    logger.info('Withdrawal completed successfully', {
      withdrawalId: withdrawalTx._id,
      userId: user._id,
      amount: breakdown.netToUserUsd,
      method: payoutMethod,
      providerReference: payoutResult.reference,
    });
    
  } catch (error) {
    // Mark withdrawal as failed
    withdrawalTx.status = WITHDRAWAL_STATUS.FAILED;
    withdrawalTx.errorMessage = error.message;
    withdrawalTx.metadata.failedAt = new Date();
    withdrawalTx.metadata.failureReason = error.message;
    await withdrawalTx.save();
    
    logger.error('Withdrawal failed after debit', {
      withdrawalId: withdrawalTx._id,
      userId: user._id,
      amount: breakdown.netToUserUsd,
      method: payoutMethod,
      error: error.message,
    });
    
    // Note: Funds have been debited but payout failed.
    // In production, you might want to queue for retry or manual review.
    throw new AppError(`Payout failed: ${error.message}. Funds will be reviewed by support.`, 502);
  }
  
  return {
    success: true,
    withdrawal: withdrawalTx,
    payoutResult,
    grossUsd: breakdown.grossUsd,
    feeUsd: breakdown.feeUsd,
    netToUserUsd: breakdown.netToUserUsd,
    message: user.role === 'admin'
      ? 'Admin withdrawal processed successfully.'
      : `Withdrawal of $${breakdown.netToUserUsd} USD via ${payoutMethod} has been initiated.`,
  };
}

/**
 * Get withdrawal history for a user
 * @param {string} userId - User ID
 * @param {Object} options - Pagination and filter options
 * @returns {Promise<Object>} Withdrawals with pagination
 */
async function getWithdrawalHistory(userId, options = {}) {
  const { page = 1, limit = 20, status, startDate, endDate } = options;
  const skip = (page - 1) * limit;
  const effectiveLimit = Math.min(limit, 100);
  
  const match = {
    type: 'withdrawal',
    fromUserId: userId,
  };
  
  if (status) match.status = status;
  if (startDate) match.createdAt = { ...match.createdAt, $gte: new Date(startDate) };
  if (endDate) match.createdAt = { ...match.createdAt, $lte: new Date(endDate) };
  
  const [withdrawals, total] = await Promise.all([
    Transaction.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(effectiveLimit)
      .lean(),
    Transaction.countDocuments(match),
  ]);
  
  // Calculate summary
  const completedWithdrawals = withdrawals.filter(w => w.status === 'completed');
  const summary = {
    totalWithdrawn: completedWithdrawals.reduce((sum, w) => sum + w.netAmount, 0),
    totalFees: completedWithdrawals.reduce((sum, w) => sum + w.feeAmount, 0),
    totalCount: total,
    averageWithdrawal: completedWithdrawals.length > 0
      ? completedWithdrawals.reduce((sum, w) => sum + w.netAmount, 0) / completedWithdrawals.length
      : 0,
  };
  
  return {
    withdrawals,
    pagination: {
      page,
      limit: effectiveLimit,
      total,
      pages: Math.ceil(total / effectiveLimit),
      hasMore: skip + withdrawals.length < total,
    },
    summary,
  };
}

/**
 * Check if withdrawal with given idempotency key already exists
 * @param {string} idempotencyKey - Idempotency key to check
 * @returns {Promise<Object|null>} Existing withdrawal or null
 */
async function checkExistingWithdrawal(idempotencyKey) {
  const Transaction = require('../models/Transaction');
  const existing = await Transaction.findOne({
    'metadata.idempotencyKey': idempotencyKey,
    type: 'withdrawal',
  });
  return existing;
}

/**
 * Retry a failed withdrawal
 * @param {string} withdrawalId - Withdrawal transaction ID
 * @returns {Promise<Object>} Retry result
 */
async function retryWithdrawal(withdrawalId) {
  const withdrawal = await Transaction.findById(withdrawalId);
  
  if (!withdrawal) {
    throw new AppError('Withdrawal not found', 404);
  }
  
  if (withdrawal.status !== WITHDRAWAL_STATUS.FAILED) {
    throw new AppError(`Cannot retry withdrawal with status: ${withdrawal.status}`, 400);
  }
  
  const { payoutMethod, payoutDetails } = withdrawal.metadata;
  
  withdrawal.status = WITHDRAWAL_STATUS.PROCESSING;
  withdrawal.retryCount = (withdrawal.retryCount || 0) + 1;
  withdrawal.metadata.retriedAt = new Date();
  await withdrawal.save();
  
  try {
    const payoutResult = await dispatchPayoutToProvider({
      amount: withdrawal.netAmount,
      method: payoutMethod,
      details: payoutDetails,
      reference: withdrawal.transactionId,
    });
    
    withdrawal.status = WITHDRAWAL_STATUS.COMPLETED;
    withdrawal.completedAt = new Date();
    withdrawal.referenceId = payoutResult.reference;
    withdrawal.metadata.providerReference = payoutResult.reference;
    withdrawal.metadata.providerResponse = payoutResult;
    await withdrawal.save();
    
    logger.info('Withdrawal retry succeeded', {
      withdrawalId: withdrawal._id,
      providerReference: payoutResult.reference,
    });
    
    return {
      success: true,
      withdrawal,
      message: 'Withdrawal retry succeeded',
    };
    
  } catch (error) {
    withdrawal.status = WITHDRAWAL_STATUS.FAILED;
    withdrawal.errorMessage = error.message;
    withdrawal.metadata.failedAt = new Date();
    withdrawal.metadata.failureReason = error.message;
    await withdrawal.save();
    
    throw new AppError(`Retry failed: ${error.message}`, 502);
  }
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Main functions
  processWithdrawal,
  previewWithdrawal,
  getWithdrawalHistory,
  retryWithdrawal,
  
  // Validation
  validatePayoutDetails,
  getMinWithdrawalAmount,
  
  // Provider dispatchers (for testing)
  dispatchMpesaPayout,
  dispatchPaypalPayout,
  dispatchWirePayout,
  dispatchPayoutToProvider,
  
  // Constants
  WITHDRAWAL_STATUS,
};
