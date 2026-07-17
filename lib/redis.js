import { Redis } from '@upstash/redis';

let client = null;

// Lazy so importing this module never requires env vars at build time.
// Supports both the Vercel Marketplace (KV_*) and native Upstash (UPSTASH_*)
// env var names.
export function redis() {
  if (!client) {
    client = new Redis({
      url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return client;
}

// Every key this app touches is namespaced under pvp:
export const k = (name) => `fable2:${name}`;
