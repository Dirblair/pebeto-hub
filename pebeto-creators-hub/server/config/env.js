require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // These MUST be set in your Render Environment dashboard
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  
  // These have safe defaults
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  exchangeRateApiKey: process.env.EXCHANGE_RATE_API_KEY || '',
  exchangeRateApiUrl: process.env.EXCHANGE_RATE_API_URL || 'https://v6.exchangerate-api.com/v6',
  clientOrigin: process.env.CLIENT_ORIGIN || '*',
};
