const jwt = require('jsonwebtoken');
const env = require('../config/env');
const User = require('../models/User');

function initSockets(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication required'));
      const decoded = jwt.verify(token, env.jwtSecret);
      const user = await User.findById(decoded.userId);
      if (!user) return next(new Error('Invalid user'));
      socket.user = user;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.user._id}`);

    socket.on('dm:typing', (payload) => {
      const { conversationId } = payload || {};
      if (conversationId) {
        socket.to(`dm:${conversationId}`).emit('dm:typing', {
          userId: socket.user._id,
          uniqueCode: socket.user.uniqueCode,
        });
      }
    });

    socket.on('status:subscribe', () => {
      socket.join('status:global');
    });

    socket.on('disconnect', () => {
      socket.broadcast.emit('presence:offline', { userId: socket.user._id });
    });

    socket.broadcast.emit('presence:online', { userId: socket.user._id });
  });
}

module.exports = { initSockets };
