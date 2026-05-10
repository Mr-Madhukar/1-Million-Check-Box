'use strict';
/**
 * WebSocket handler.
 *
 * Message protocol (JSON):
 *   Client → Server:
 *     { type: 'toggle', index: number }
 *     { type: 'ping' }
 *
 *   Server → Client:
 *     { type: 'init',   data: string (base64 bitmap), count: number, checkedCount: number,
 *                       authenticated: boolean, user: object|null }
 *     { type: 'update', index: number, checked: boolean, userId: string, userName: string }
 *     { type: 'stats',  connected: number }
 *     { type: 'error',  code: string, message: string, retryAfter?: number }
 *     { type: 'pong' }
 */

const WebSocket  = require('ws');
const { setCheckboxBit, getAllCheckboxBytes, countChecked, CHECKBOX_COUNT } = require('./checkboxStore');
const { wsRateLimit } = require('./rateLimiter');
const { redis, redisSub } = require('./redisClient');

const PUBSUB_CHANNEL = 'checkbox-updates';
const BITMAP_KEY     = 'checkboxes:bits';

let wss            = null;
let connectedCount = 0;

/**
 * Wrap express-style middleware into a Promise so we can await it.
 */
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Attach WebSocket server. Receives sessionMiddleware to parse sessions on upgrade.
 * @param {http.Server} httpServer
 * @param {Function} sessionMiddleware  express-session middleware
 */
function attachWss(httpServer, sessionMiddleware) {
  wss = new WebSocket.Server({ noServer: true });

  // Handle the HTTP → WS upgrade
  httpServer.on('upgrade', async (request, socket, head) => {
    try {
      // Build a minimal response-like object that express-session can work with
      // (it needs setHeader to write the Set-Cookie header)
      const mockRes = {
        _headers: {},
        getHeader(name) { return this._headers[name.toLowerCase()]; },
        setHeader(name, value) { this._headers[name.toLowerCase()] = value; },
        end() {},
      };

      // Run session middleware – populates request.session
      await runMiddleware(request, mockRes, sessionMiddleware);
    } catch (err) {
      console.error('[WS] Session middleware error:', err.message);
      // Continue anyway – user will be treated as anonymous
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.user     = request.session?.user || null;
      ws.socketId = Math.random().toString(36).slice(2, 10);
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', handleConnection);

  // Subscribe to Redis Pub/Sub for cross-instance broadcasting
  redisSub.subscribe(PUBSUB_CHANNEL, (err) => {
    if (err) console.error('[WS] Redis subscribe error:', err.message);
    else     console.log(`[WS] Subscribed to Redis channel: ${PUBSUB_CHANNEL}`);
  });

  redisSub.on('message', (_channel, message) => {
    broadcastToAll(message);
  });

  console.log('[WS] WebSocket server attached');
}

/** Handle a new WebSocket connection. */
async function handleConnection(ws) {
  connectedCount++;
  broadcastStats();

  try {
    const [bitmap, checkedCount] = await Promise.all([
      getAllCheckboxBytes(),
      countChecked(),
    ]);

    const initMsg = JSON.stringify({
      type:          'init',
      data:          bitmap.toString('base64'),
      count:         CHECKBOX_COUNT,
      checkedCount,
      connected:     connectedCount,
      authenticated: !!ws.user,
      user:          ws.user || null,
    });
    if (ws.readyState === WebSocket.OPEN) ws.send(initMsg);
  } catch (err) {
    console.error('[WS] Init send error:', err.message);
  }

  ws.on('message', (rawMsg) => handleMessage(ws, rawMsg));
  ws.on('close',   ()        => { connectedCount = Math.max(0, connectedCount - 1); broadcastStats(); });
  ws.on('error',   (err)     => console.error(`[WS] Socket error (${ws.socketId}):`, err.message));
}

/** Handle an incoming message from a client. */
async function handleMessage(ws, rawMsg) {
  let data;
  try { data = JSON.parse(rawMsg.toString()); }
  catch { return sendError(ws, 'INVALID_JSON', 'Invalid JSON'); }

  if (data.type === 'ping') {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  if (data.type === 'toggle') {
    // Auth check
    if (!ws.user) {
      return sendError(ws, 'AUTH_REQUIRED', 'You must be logged in to toggle checkboxes');
    }

    // Input validation
    const index = parseInt(data.index, 10);
    if (!Number.isInteger(index) || index < 0 || index >= CHECKBOX_COUNT) {
      return sendError(ws, 'INVALID_INDEX', 'Invalid checkbox index');
    }

    // Rate limit
    const { allowed, retryAfter } = await wsRateLimit(ws.user.sub || ws.socketId);
    if (!allowed) {
      return sendError(ws, 'RATE_LIMITED', `Rate limit exceeded. Retry in ${retryAfter}s`, retryAfter);
    }

    // Toggle in Redis: read current bit, flip it
    try {
      const current = await redis.getbit(BITMAP_KEY, index);
      const newVal  = current === 0 ? 1 : 0;
      await setCheckboxBit(index, newVal === 1);

      // Publish update to all server instances via Redis Pub/Sub
      const updateMsg = JSON.stringify({
        type:     'update',
        index,
        checked:  newVal === 1,
        userId:   ws.user.sub,
        userName: ws.user.name || 'Unknown',
      });
      await redis.publish(PUBSUB_CHANNEL, updateMsg);
    } catch (err) {
      console.error('[WS] Toggle error:', err.message);
      sendError(ws, 'SERVER_ERROR', 'Failed to update checkbox');
    }
  }
}

function sendError(ws, code, message, retryAfter) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const payload = { type: 'error', code, message };
  if (retryAfter !== undefined) payload.retryAfter = retryAfter;
  ws.send(JSON.stringify(payload));
}

function broadcastToAll(message) {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

function broadcastStats() {
  broadcastToAll(JSON.stringify({ type: 'stats', connected: connectedCount }));
}

module.exports = { attachWss };
