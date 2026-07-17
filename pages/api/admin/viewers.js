import { requireAdmin } from '../../../lib/guard';
import { redis, k } from '../../../lib/redis';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import { logAction } from '../../../lib/audit';

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const r = redis();

  if (req.method === 'GET') {
    try {
      const [emails, lastSeen] = await Promise.all([
        r.smembers(k('viewers')),
        r.hgetall(k('viewer:lastseen')).catch(() => ({})),
      ]);
      const viewers = (emails || [])
        .map((email) => ({ email, lastSeen: (lastSeen || {})[email] || null }))
        .sort((a, b) => a.email.localeCompare(b.email));
      return res.json({ viewers });
    } catch {
      return res.status(500).json({ error: 'Could not load viewers' });
    }
  }

  if (req.method === 'POST') {
    // Accepts a single email, an array, or a pasted blob separated by
    // commas/whitespace/semicolons. Validated + deduped.
    let input = req.body?.emails ?? req.body?.email ?? '';
    if (typeof input === 'string') input = input.split(/[\s,;]+/);
    if (!Array.isArray(input)) return res.status(400).json({ error: 'Bad input' });
    const seen = new Set();
    const valid = [];
    const invalid = [];
    for (const raw of input.slice(0, 500)) {
      const email = normalizeEmail(raw);
      if (!email) continue;
      if (!isValidEmail(email)) {
        invalid.push(email);
        continue;
      }
      if (!seen.has(email)) {
        seen.add(email);
        valid.push(email);
      }
    }
    if (!valid.length) return res.status(400).json({ error: 'No valid emails', invalid });
    try {
      const added = await r.sadd(k('viewers'), ...valid);
      await logAction(admin, 'viewer.add', valid.slice(0, 10).join(', ') + (valid.length > 10 ? ` (+${valid.length - 10} more)` : ''));
      return res.json({ added, submitted: valid.length, invalid });
    } catch {
      return res.status(500).json({ error: 'Could not add viewers' });
    }
  }

  if (req.method === 'DELETE') {
    const email = normalizeEmail(req.body?.email || req.query.email);
    if (!email) return res.status(400).json({ error: 'Bad email' });
    try {
      await r.srem(k('viewers'), email);
      await r.hdel(k('viewer:lastseen'), email).catch(() => {});
      await logAction(admin, 'viewer.remove', email);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not remove viewer' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
