const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { Server } = require('socket.io');

const env = require('./config/env');
const { connectDB } = require('./config/db');
const { errorHandler } = require('./middleware/errorHandler');
const { attachFeeService } = require('./middleware/feeService');
const { initSockets } = require('./sockets');

const authRoutes = require('./routes/auth.routes');
const walletRoutes = require('./routes/wallet.routes');
const adminRoutes = require('./routes/admin.routes');
const campaignRoutes = require('./routes/campaign.routes');

async function bootstrap() {
  await connectDB(env.mongoUri);

  const app = express();
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: {
      origin: env.clientOrigin === '*' ? true : env.clientOrigin,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });
  initSockets(io);
  app.set('io', io);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(
    cors({
      origin: env.clientOrigin === '*' ? true : env.clientOrigin,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(attachFeeService);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'pebeto-creators-hub' });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/wallet', walletRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/campaigns', campaignRoutes);

  app.use(express.static(path.join(__dirname, '..', 'client')));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    const file = path.join(__dirname, '..', 'client', 'index.html');
    res.sendFile(file, (err) => {
      if (err) res.status(404).json({ message: 'Not found' });
    });
  });

  app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
  });

  app.use(errorHandler);

  const PORT = process.env.PORT || 3000;

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Pebeto Creator's Hub running on port ${PORT}`);
  });
} // This bracket closes the async function bootstrap()

// This call is now correctly outside the function
bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
