const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { AppError } = require('../utils/errors');
const { roundUsd } = require('../middleware/feeService');

async function getOrCreateWallet(userId, walletType = 'standard') {
  let wallet = await Wallet.findOne({ userId });
  if (!wallet) {
    wallet = await Wallet.create({ userId, walletType, currency: 'USD' });
  }
  return wallet;
}

async function getAdminProfitWallet() {
  const admin = await User.findOne({ role: 'admin' });
  if (!admin) throw new AppError('Admin account not configured', 500);
  let wallet = await Wallet.findOne({ userId: admin._id, walletType: 'profit' });
  if (!wallet) {
    wallet = await Wallet.create({
      userId: admin._id,
      walletType: 'profit',
      currency: 'USD',
    });
  }
  return { admin, wallet };
}

async function recordTransaction(entry, session = null) {
  const opts = session ? { session } : {};
  return Transaction.create(
    [
      {
        transactionId: uuidv4(),
        ...entry,
      },
    ],
    opts
  ).then((docs) => docs[0]);
}

async function creditWallet(walletId, field, amount, session) {
  const update = { $inc: { [`balances.${field}`]: roundUsd(amount) } };
  return Wallet.findByIdAndUpdate(walletId, update, { new: true, session });
}

async function debitWallet(walletId, field, amount, session) {
  const wallet = await Wallet.findById(walletId).session(session);
  if (!wallet || wallet.balances[field] < amount) {
    throw new AppError('Insufficient balance', 400);
  }
  wallet.balances[field] = roundUsd(wallet.balances[field] - amount);
  await wallet.save({ session });
  return wallet;
}

/** Debit from available first, then tips (USD). */
async function debitWithdrawable(walletId, amount, session) {
  const wallet = await Wallet.findById(walletId).session(session);
  if (!wallet) throw new AppError('Wallet not found', 404);
  const total = wallet.balances.available + wallet.balances.tips;
  if (total < amount) throw new AppError('Insufficient balance', 400);
  let remaining = roundUsd(amount);
  const fromAvailable = Math.min(wallet.balances.available, remaining);
  if (fromAvailable > 0) {
    wallet.balances.available = roundUsd(wallet.balances.available - fromAvailable);
    remaining = roundUsd(remaining - fromAvailable);
  }
  if (remaining > 0) {
    wallet.balances.tips = roundUsd(wallet.balances.tips - remaining);
  }
  await wallet.save({ session });
  return wallet;
}

async function runInTransaction(fn) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

module.exports = {
  getOrCreateWallet,
  getAdminProfitWallet,
  recordTransaction,
  creditWallet,
  debitWallet,
  debitWithdrawable,
  runInTransaction,
};
