const jwt = require('jsonwebtoken');
const env = require('../config/env');
const User = require('../models/User');
const { AppError } = require('../utils/errors');

async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError('Authentication required', 401);
    }
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, env.jwtSecret);
    const user = await User.findById(decoded.userId);
    if (!user || user.status !== 'active') {
      throw new AppError('Invalid or inactive user', 401);
    }
    req.user = user;
    next();
  } catch (err) {
    next(err.name === 'JsonWebTokenError' ? new AppError('Invalid token', 401) : err);
  }
}

function authorize(...roles) {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('Forbidden', 403));
    }
    next();
  };
}

module.exports = { authenticate, authorize };
