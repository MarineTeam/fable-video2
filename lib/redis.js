import { Redis } from '@upstash/redis';
import { monitorEnabled, recordQuery } from './monitor';

let client = null;

// Query Monitor instrumentation: a transparent pass-through Proxy that times
// every Redis command and reports it via lib/monitor.js. Disabled (the
// default), this adds one cheap env-var check per call and nothing else —
// every existing `redis().foo(...)` call site across the app is untouched.
function instrument(rawClient) {
  return new Proxy(rawClient, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return function (...args) {
        if (!monitorEnabled()) return value.apply(target, args);
        const start = process.hrtime.bigint();
        const finish = () =>
          recordQuery(String(prop), Number(process.hrtime.bigint() - start) / 1e6);
        const result = value.apply(target, args);
        if (result && typeof result.then === 'function') {
          return result.finally(finish);
        }
        finish();
        return result;
      };
    },
  });
}

// Lazy so importing this module never requires env vars at build time.
// Supports both the Vercel Marketplace (KV_*) and native Upstash (UPSTASH_*)
// env var names.
export function redis() {
  if (!client) {
    const rawClient = new Redis({
      url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    client = instrument(rawClient);
  }
  return client;
}

// Every key this app touches is namespaced under pvp:
export const k = (name) => `fable2:${name}`;
