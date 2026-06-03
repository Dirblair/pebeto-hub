require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/pebeto-creators-hub',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  exchangeRateApiKey: process.env.EXCHANGE_RATE_API_KEY || '',
  exchangeRateApiUrl: process.env.EXCHANGE_RATE_API_URL || 'https://v6.exchangerate-api.com/v6',
  clientOrigin: process.env.CLIENT_ORIGIN || '*',
};
