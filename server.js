'use strict';
require('dotenv').config();

const express = require('express');
const http = require('http');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');

const { router: authRouter } = require('./src/auth');
const { attachWss } = require('./src/wsHandler');
const { httpRateLimitMiddleware } = require('./src/rateLimiter');
const { redis } = require('./src/redisClient');

const PORT           = process.env.PORT || 8080;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

const app = express();
app.set('trust proxy', 1);

// ─── Session middleware ────────────────────────────────────────────────────────
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

app.use(cookieParser());
app.use(sessionMiddleware);
app.use(express.json());

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function bootstrap() {
  // Rate limiter (skip auth paths)
  app.use((req, res, next) => {
    if (req.path.startsWith('/auth')) return next();
    httpRateLimitMiddleware(req, res, next);
  });

  // Auth routes
  app.use('/', authRouter);

  // Static files
  app.use(express.static(path.join(__dirname), { dotfiles: 'deny' }));

  // Health
  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

  // SPA fallback
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

  // ─── HTTP Server ─────────────────────────────────────────────────────────────
  const httpServer = http.createServer(app);

  // Pass session middleware to the WS layer so each upgrade can parse session
  attachWss(httpServer, sessionMiddleware);

  httpServer.listen(PORT, () => {
    console.log(`\n🎉 2,000 Checkboxes server running!`);
    console.log(`   ➤ App:    http://localhost:${PORT}`);
    console.log(`   ➤ Health: http://localhost:${PORT}/health`);
    console.log(`   ➤ Login:  http://localhost:${PORT}/auth/login\n`);
  });

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  function shutdown() {
    console.log('\n[Server] Shutting down gracefully…');
    httpServer.close(() => { redis.disconnect(); process.exit(0); });
  }
}

bootstrap().catch(err => {
  console.error('[Server] Fatal:', err);
  process.exit(1);
});
