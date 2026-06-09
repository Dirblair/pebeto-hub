/**
 * Exchange Rate Routes for Pebeto Creator's Hub
 * 
 * Handles currency exchange rate information
 * 
 * @module routes/exchange
 */

const express = require('express');
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const { catchAsync } = require('../middleware/errorHandler');
const { getRatesMap } = require('../services/exchangeRateService');

const router = express.Router();

/**
 * GET /api/exchange/rates
 * Get current exchange rates (requires authentication)
 */
router.get('/rates', authenticate, catchAsync(async (req, res) => {
  const rates = await getRatesMap();
  
  res.json({
    success: true,
    data: {
      base: 'USD',
      rates,
      timestamp: new Date().toISOString()
    }
  });
}));

/**
 * GET /api/exchange/rates/public
 * Get current exchange rates (public - no auth required)
 */
router.get('/rates/public', catchAsync(async (req, res) => {
  const rates = await getRatesMap();
  
  res.json({
    success: true,
    data: {
      base: 'USD',
      rates,
      timestamp: new Date().toISOString()
    }
  });
}));

/**
 * GET /api/exchange/convert
 * Convert an amount between currencies
 */
router.get('/convert', authenticate, catchAsync(async (req, res) => {
  const { amount, from = 'USD', to = 'USD' } = req.query;
  
  if (!amount || isNaN(amount)) {
    throw new AppError('Valid amount is required', 400);
  }
  
  const rates = await getRatesMap();
  const fromRate = rates[from.toUpperCase()];
  const toRate = rates[to.toUpperCase()];
  
  if (!fromRate && from !== 'USD') {
    throw new AppError(`Exchange rate not available for ${from}`, 400);
  }
  
  if (!toRate && to !== 'USD') {
    throw new AppError(`Exchange rate not available for ${to}`, 400);
  }
  
  let amountInUsd = parseFloat(amount);
  if (from !== 'USD') {
    amountInUsd = amountInUsd / fromRate;
  }
  
  let convertedAmount = amountInUsd;
  if (to !== 'USD') {
    convertedAmount = amountInUsd * toRate;
  }
  
  res.json({
    success: true,
    data: {
      from,
      to,
      originalAmount: parseFloat(amount),
      convertedAmount: Math.round(convertedAmount * 100) / 100,
      rate: to !== 'USD' ? toRate : (from !== 'USD' ? 1 / fromRate : 1)
    }
  });
}));

module.exports = router;
