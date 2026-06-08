const { PAYOUT_METHODS } = require('../config/constants');
const { AppError } = require('../utils/errors');
const { validateWithdrawalRequest } = require('../middleware/feeService');
const { getRatesMap } = require('./exchangeRateService');
const { sendMpesaB2C } = require('./mpesaService');
const {
  getOrCreateWallet,
  getAdminProfitWallet,
  recordTransaction,
  debitWithdrawable,
  creditWallet,
  runInTransaction,
} = require('./walletService');

function validatePayoutDetails(method, details = {}) {
  if (!PAYOUT_METHODS.includes(method)) {
    throw new AppError(`Invalid payout method. Use: ${PAYOUT_METHODS.join(', ')}`, 400);
  }
  switch (method) {
    case 'mpesa':
      if (!details.phoneNumber) throw new AppError('M-Pesa phone number is required', 400);
      break;
    case 'paypal':
      if (!details.paypalEmail) throw new AppError('PayPal email is required', 400);
      break;
    case 'swift':
      if (!details.bankName || !details.accountNumber || !details.swiftCode || !details.accountHolderName) {
        throw new AppError('Bank name, account number, SWIFT code, and account holder name are required', 400);
      }
      break;
    default:
      break;
  }
  return details;
}

async function dispatchPayoutToProvider({ amount, method, details }) {
  switch (method) {
    case 'mpesa':
      // Calls the real M-Pesa B2C service
      return await sendMpesaB2C(details.phoneNumber, amount);
      
    case 'paypal':
      // TODO: Replace with your actual paypalService.payout call once configured
      return { success: true, reference: 'PAYPAL_' + Date.now() };
      
    case 'swift':
      // TODO: Replace with your actual bankService.wireTransfer call once configured
      return { success: true, reference: 'SWIFT_' + Date.now() };
      
    default:
      throw new AppError('Unsupported payout method', 400);
  }
}
async function processWithdrawal({
  user,
  amountUsd,
  amountLocal,
  currency,
  payoutMethod,
  payoutDetails,
}) {
  validatePayoutDetails(payoutMethod, payoutDetails);
  const rates = await getRatesMap();
  const validated = validateWithdrawalRequest(
    { amountUsd, amountLocal, currency, role: user.role },
    rates
  );
  const { grossUsd, feeUsd, netToUserUsd, feeSource } = validated;

  const userWallet = await getOrCreateWallet(user._id);
  const withdrawable =
    userWallet.balances.available + userWallet.balances.tips;
  if (withdrawable < grossUsd) {
    throw new AppError('Insufficient balance for withdrawal', 400);
  }
  const { admin, wallet: profitWallet } = await getAdminProfitWallet();

 return runInTransaction(async (session) => {
    await debitWithdrawable(userWallet._id, grossUsd, session);

    const withdrawalTx = await recordTransaction(
      {
        type: 'withdrawal',
        status: 'pending',
        fromUserId: user._id,
        toUserId: user._id,
        fromWalletId: userWallet._id,
        toWalletId: userWallet._id,
        grossAmount: grossUsd,
        feeAmount: feeUsd,
        netAmount: netToUserUsd,
        feeRate: validated.feeRate,
        feeSource,
        feeRecipient: feeUsd > 0 ? admin._id : undefined,
        metadata: {
          payoutMethod,
          payoutDetails,
          displayCurrency: validated.displayCurrency,
          displayAmount: validated.displayAmount,
          exchangeRateUsed: validated.exchangeRateUsed,
        },
      },
      session
    );

    // Automation: Dispatch payout and finalize
    try {
      const payoutResponse = await dispatchPayoutToProvider({
        amount: netToUserUsd,
        method: payoutMethod,
        details: payoutDetails,
      });

      if (payoutResponse.success) {
        withdrawalTx.status = 'completed';
        withdrawalTx.metadata.providerReference = payoutResponse.reference;
        await withdrawalTx.save({ session });
      }
    } catch (err) {
      throw new AppError(`Payout failed: ${err.message}`, 502);
    }

    if (feeUsd > 0) {
      await creditWallet(profitWallet._id, 'available', feeUsd, session);
      await recordTransaction(
        {
          type: 'platform_fee',
          status: 'completed',
          fromUserId: user._id,
          toUserId: admin._id,
          fromWalletId: userWallet._id,
          toWalletId: profitWallet._id,
          grossAmount: feeUsd,
          feeAmount: feeUsd,
          netAmount: feeUsd,
          feeRate: validated.feeRate,
          feeSource: 'withdrawal',
          feeRecipient: admin._id,
          metadata: { note: 'Withdrawal platform fee' },
        },
        session
      );
    }

    return {
      withdrawal: withdrawalTx,
      grossUsd,
      feeUsd,
      netToUserUsd,
      message:
        user.role === 'admin'
          ? 'Admin withdrawal processed.'
          : `Withdrawal processed. You receive $${netToUserUsd} USD.`,
    };
  });
}

async function previewWithdrawal({ user, amountUsd, amountLocal, currency }) {
  const rates = await getRatesMap();
  return validateWithdrawalRequest(
    { amountUsd, amountLocal, currency, role: user.role },
    rates
  );
}

async function dispatchPayoutToProvider({ amount, method, details }) {
  switch (method) {
    case 'mpesa':
      // TODO: Connect M-Pesa B2C SDK here
      return { success: true, reference: 'MPESA_' + Date.now() };
    case 'paypal':
      // TODO: Connect PayPal Payouts SDK here
      return { success: true, reference: 'PAYPAL_' + Date.now() };
    case 'swift':
      // TODO: Connect Bank Wire API here
      return { success: true, reference: 'SWIFT_' + Date.now() };
    default:
      throw new AppError('Unsupported payout method', 400);
  }
}
module.exports = {
  processWithdrawal,
  previewWithdrawal,
  validatePayoutDetails,
};
