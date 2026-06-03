const mongoose = require('mongoose');

async function connectDB(uri) {
  try {
    mongoose.set('strictQuery', true);
    console.log('DEBUG: Attempting to connect to MongoDB...');
    
    await mongoose.connect(uri);
    
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('CRITICAL DATABASE ERROR:', error.message);
    // Exit process with failure code so Render knows it crashed
    process.exit(1);
  }
}

module.exports = { connectDB };
