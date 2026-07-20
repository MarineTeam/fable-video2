import crypto from 'crypto';
import { redis, k } from './redis';

export const DEFAULT_HOURS = 72;
export const MAX_HOURS = 720; // 30 days

export function clampHours(hours) {
  return Math.min(Math.max(parseInt(hours, 10) || DEFAULT_HOURS, 1), MAX_HOURS);
}

export function baseUrl(req) {
  const fromEnv = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  return `https://${req.headers.host}`;
}

// One private, independently-revocable link per (videoId, email) pair.
export async function createShare({ videoId, email, hours }) {
  const id = crypto.randomBytes(18).toString('base64url');
  const now = new Date();
  const ttlHours = clampHours(hours);
  const share = {
    videoId,
    email,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString(),
  };
  const r = redis();
  await r.set(k(`share:${id}`), share, { ex: ttlHours * 3600 });
  await r.sadd(k('shares'), id);
  return { id, share };
}
