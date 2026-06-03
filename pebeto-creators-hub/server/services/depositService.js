const { calculateDeposit } = require('../middleware/feeService');
const {
  getOrCreateWallet,
  getAdminProfitWallet,
  recordTransaction,
  debitWallet,
  creditWallet,
  runInTransaction,
} = require('./walletService');
const { AppError } = require('../utils/errors');

/**
 * Business deposits intent X USD into escrow.
 * Charges total X + 10%; credits escrow X; fee to admin profit wallet.
 */
async function processDeposit({ businessUser, intentUsd, campaignId, idempotencyKey }) {
  const breakdown = calculateDeposit(intentUsd);
  const businessWallet = await getOrCreateWallet(businessUser._id);
  const { admin, wallet: profitWallet } = await getAdminProfitWallet();

  const totalRequired =
    businessWallet.balances.available >= breakdown.totalChargeUsd
      ? breakdown.totalChargeUsd
      : breakdown.totalChargeUsd;

  if (businessWallet.balances.available < breakdown.totalChargeUsd) {
    throw new AppError(
      `Insufficient fund wallet. Need $${breakdown.totalChargeUsd} USD (includes 10% fee).`,
      400
    );
  }

  return runInTransaction(async (session) => {
    await debitWallet(businessWallet._id, 'available', breakdown.totalChargeUsd, session);
    await creditWallet(businessWallet._id, 'escrow', breakdown.escrowCreditUsd, session);
    await creditWallet(profitWallet._id, 'available', breakdown.feeUsd, session);

    const depositTx = await recordTransaction(
      {
        type: 'deposit',
        status: 'completed',
        fromUserId: businessUser._id,
        toUserId: businessUser._id,
        fromWalletId: businessWallet._id,
        toWalletId: businessWallet._id,
        grossAmount: breakdown.intentUsd,
        feeAmount: breakdown.feeUsd,
        netAmount: breakdown.escrowCreditUsd,
        feeRate: breakdown.feeRate,
        feeSource: breakdown.feeSource,
        feeRecipient: admin._id,
        metadata: { campaignId, idempotencyKey, note: 'Escrow funding' },
      },
      session
    );

    await recordTransaction(
      {
        type: 'platform_fee',
        status: 'completed',
        fromUserId: businessUser._id,
        toUserId: admin._id,
        fromWalletId: businessWallet._id,
        toWalletId: profitWallet._id,
        grossAmount: breakdown.feeUsd,
        feeAmount: breakdown.feeUsd,
        netAmount: breakdown.feeUsd,
        feeRate: breakdown.feeRate,
        feeSource: 'deposit',
        feeRecipient: admin._id,
        metadata: { campaignId, idempotencyKey },
      },
      session
    );

    return { depositTx, breakdown };
  });
}

module.exports = { processDeposit };
