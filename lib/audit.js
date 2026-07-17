import { redis, k } from './redis';

const MAX_ENTRIES = 200;

// Append-only, capped, best-effort: a logging failure must never break the
// admin action being logged.
export async function logAction(actor, action, detail = '') {
  try {
    const entry = JSON.stringify({
      actor,
      action,
      detail: String(detail).slice(0, 300),
      at: new Date().toISOString(),
    });
    const r = redis();
    await r.lpush(k('audit'), entry);
    await r.ltrim(k('audit'), 0, MAX_ENTRIES - 1);
  } catch {
    // best-effort
  }
}

export async function recentActions(limit = 100) {
  try {
    const rows = await redis().lrange(k('audit'), 0, limit - 1);
    return (rows || [])
      .map((row) => {
        if (typeof row === 'string') {
          try {
            return JSON.parse(row);
          } catch {
            return null;
          }
        }
        return row;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
