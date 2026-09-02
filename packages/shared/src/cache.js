'use strict';

// SPDX-License-Identifier: MIT
// Fase 10.5 — Cache abstraction: Redis (ioredis) when REDIS_URL set, fallback to in-memory LRU
// Uso: const { get, set, del, wrap } = require('@erp/shared').cache;
// TTL en segundos, default env CACHE_TTL || 30

let redisClient = null;
let redisReady = false;
let memoryStore = new Map();

function getTtl() {
  const v = Number(process.env.CACHE_TTL);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

function getRedisUrl() {
  return process.env.REDIS_URL || process.env.CACHE_REDIS_URL || null;
}

function initRedis() {
  const url = getRedisUrl();
  if (!url) return null;
  if (redisClient) return redisClient;
  try {
    // Lazy require — ioredis es opcional en dev (memory fallback)
    // eslint-disable-next-line import/no-unresolved, global-require
    const IORedis = require('ioredis');
    redisClient = new IORedis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });
    redisClient.on('ready', () => {
      redisReady = true;
    });
    redisClient.on('error', () => {
      redisReady = false;
    });
    redisClient.on('close', () => {
      redisReady = false;
    });
    // connect async without blocking
    redisClient.connect().catch(() => {
      redisReady = false;
    });
  } catch (_e) {
    redisClient = null;
    redisReady = false;
  }
  return redisClient;
}

// Inicializa si hay URL (no bloquea)
if (getRedisUrl()) initRedis();

async function get(key) {
  if (redisReady && redisClient) {
    try {
      const raw = await redisClient.get(key);
      if (raw == null) return null;
      return JSON.parse(raw);
    } catch (_e) {
      // fallback to memory
    }
  }
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

async function set(key, value, ttlSeconds) {
  const ttl = ttlSeconds ?? getTtl();
  if (redisReady && redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(value), 'EX', ttl);
      return;
    } catch (_e) {
      // fallback
    }
  }
  memoryStore.set(key, {
    value,
    expiresAt: Date.now() + ttl * 1000,
  });
  // Evita crecimiento infinito en memory (max 500 keys)
  if (memoryStore.size > 500) {
    const firstKey = memoryStore.keys().next().value;
    memoryStore.delete(firstKey);
  }
}

async function del(patternOrKey) {
  // soporta del exacto y del por prefijo con "*"
  if (redisReady && redisClient) {
    try {
      if (patternOrKey.endsWith('*')) {
        const prefix = patternOrKey.slice(0, -1);
        let cursor = '0';
        do {
          // eslint-disable-next-line no-await-in-loop
          const [next, keys] = await redisClient.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
          cursor = next;
          if (keys.length) {
            // eslint-disable-next-line no-await-in-loop
            await redisClient.del(...keys);
          }
        } while (cursor !== '0');
      } else {
        await redisClient.del(patternOrKey);
      }
      return;
    } catch (_e) {
      // fallback
    }
  }
  if (patternOrKey.endsWith('*')) {
    const prefix = patternOrKey.slice(0, -1);
    for (const k of Array.from(memoryStore.keys())) {
      if (k.startsWith(prefix)) memoryStore.delete(k);
    }
  } else {
    memoryStore.delete(patternOrKey);
  }
}

async function wrap(key, fn, ttlSeconds) {
  const cached = await get(key);
  if (cached !== null) return { value: cached, hit: true };
  const value = await fn();
  await set(key, value, ttlSeconds);
  return { value, hit: false };
}

function getStats() {
  return {
    redisUrl: getRedisUrl() ? 'configured' : 'none',
    redisReady,
    memorySize: memoryStore.size,
    ttl: getTtl(),
  };
}

function _resetForTests() {
  memoryStore = new Map();
  if (redisClient) {
    try {
      redisClient.disconnect();
    } catch (_e) {
      // ignore
    }
    redisClient = null;
    redisReady = false;
  }
}

module.exports = {
  get,
  set,
  del,
  wrap,
  getStats,
  _resetForTests,
};
