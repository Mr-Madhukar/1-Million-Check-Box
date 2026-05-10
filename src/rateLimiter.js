'use strict';
/**
 * Custom Redis-backed sliding-window rate limiter.
 * NO external rate-limit packages used.
 *
 * Strategy:
 *   - For each unique key (IP / userId / socketId), maintain a Redis counter
 *     with a TTL equal to the window duration.
 *   - On first request in window: INCR sets counter to 1, EXPIRE sets TTL.
 *   - On subsequent requests: INCR increments; if value > limit → deny.
 *   - Window resets naturally when the TTL expires.
 */

const { redis } = require('./redisClient');

/**
 * Check & increment a rate limit bucket.
 * @param {string} bucketKey  - unique Redis key (e.g. "rl:ws:user123")
 * @param {number} limit      - max allowed actions in the window
 * @param {number} windowSecs - window duration in seconds
 * @returns {Promise<{allowed: boolean, remaining: number, retryAfter: number}>}
 */
async function checkLimit(bucketKey, limit, windowSecs) {
  // Atomic pipeline: INCR then conditionally EXPIRE
  const pipeline = redis.pipeline();
  pipeline.incr(bucketKey);
  pipeline.ttl(bucketKey);
  const [[, current], [, ttl]] = await pipeline.exec();

  // If this is the first increment (counter was 0), set the expiry
  if (current === 1 || ttl === -1) {
    await redis.expire(bucketKey, windowSecs);
  }

  const allowed = current <= limit;
  const remaining = Math.max(0, limit - current);
  const retryAfter = allowed ? 0 : (ttl > 0 ? ttl : windowSecs);

  return { allowed, remaining, retryAfter };
}

// ─── HTTP Rate Limiter ────────────────────────────────────────────────────────
// 100 requests per 10 seconds per IP (raised from 30 – static assets + auth
// calls easily exceed 30 on a normal page load / dev reload cycle)
const HTTP_LIMIT = 100;
const HTTP_WINDOW = 10;

/**
 * Express middleware for HTTP rate limiting by IP.
 */
async function httpRateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const key = `rl:http:${ip}`;
  try {
    const { allowed, remaining, retryAfter } = await checkLimit(key, HTTP_LIMIT, HTTP_WINDOW);
    res.setHeader('X-RateLimit-Limit', HTTP_LIMIT);
    res.setHeader('X-RateLimit-Remaining', remaining);
    if (!allowed) {
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: 'Too many requests. Please slow down.',
        retryAfter,
      });
    }
    next();
  } catch (err) {
    // If Redis is down, fail open (allow request) to avoid blocking users
    console.error('[RateLimit] Redis error, failing open:', err.message);
    next();
  }
}

// ─── WebSocket Rate Limiter ───────────────────────────────────────────────────
// 30 toggle events per 5 seconds per user (or per socket ID for anon)
const WS_LIMIT = 30;
const WS_WINDOW = 5;

/**
 * Check WebSocket rate limit for a given identifier.
 * @param {string} identifier - userId or socketId
 * @returns {Promise<{allowed: boolean, retryAfter: number}>}
 */
async function wsRateLimit(identifier) {
  const key = `rl:ws:${identifier}`;
  try {
    const { allowed, retryAfter } = await checkLimit(key, WS_LIMIT, WS_WINDOW);
    return { allowed, retryAfter };
  } catch (err) {
    console.error('[RateLimit] WS Redis error, failing open:', err.message);
    return { allowed: true, retryAfter: 0 };
  }
}

module.exports = { httpRateLimitMiddleware, wsRateLimit };
