require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  
  exchangeRateApiKey: process.env.EXCHANGE_RATE_API_KEY || '',
  exchangeRateApiUrl: process.env.EXCHANGE_RATE_API_URL || 'https://v6.exchangerate-api.com/v6',
  clientOrigin: process.env.CLIENT_ORIGIN || '*',

  // NEW: M-Pesa Configuration
  mpesaConsumerKey: process.env.MPESA_CONSUMER_KEY,
  mpesaConsumerSecret: process.env.MPESA_CONSUMER_SECRET,
  mpesaInitiatorName: process.env.MPESA_INITIATOR_NAME,
  mpesaPassword: process.env.MPESA_PASSWORD,
  mpesaShortCode: process.env.MPESA_SHORT_CODE,
  mpesaApiUrl: process.env.MPESA_API_URL || 'https://sandbox.safaricom.co.ke',
  mpesaQueueTimeoutUrl: process.env.MPESA_QUEUE_TIMEOUT_URL,
  mpesaResultUrl: process.env.MPESA_RESULT_URL,
};
