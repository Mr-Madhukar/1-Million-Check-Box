'use strict';
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Primary client for reads/writes
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

// Dedicated subscriber client (cannot issue other commands while subscribed)
const redisSub = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on('connect', () => console.log('[Redis] Primary client connected'));
redis.on('error', (err) => console.error('[Redis] Primary error:', err.message));
redisSub.on('connect', () => console.log('[Redis] Subscriber client connected'));
redisSub.on('error', (err) => console.error('[Redis] Subscriber error:', err.message));

module.exports = { redis, redisSub };
