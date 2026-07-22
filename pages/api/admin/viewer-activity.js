import { requireAdmin } from '../../../lib/guard';
import { redis, k } from '../../../lib/redis';
import { normalizeEmail } from '../../../lib/auth';

const MAX_ITEMS = 30;

// Admin lookup of any approved viewer's watch history — reads the same
// progress:<email> hash as /api/progress, just for an email the admin picks
// rather than the caller's own session.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const email = normalizeEmail(req.query.email);
  if (!email) return res.status(400).json({ error: 'Bad email' });

  const r = redis();
  const isViewer = (await r.sismember(k('viewers'), email).catch(() => 0)) === 1;
  if (!isViewer) return res.status(404).json({ error: 'Not an approved viewer' });

  try {
    const raw = (await r.hgetall(k(`progress:${email}`))) || {};
    const items = Object.entries(raw)
      .map(([videoId, value]) => {
        const entry = typeof value === 'string' ? safeParse(value) : value;
        if (!entry) return null;
        return { videoId, ...entry };
      })
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .slice(0, MAX_ITEMS);
    return res.json({ items });
  } catch {
    return res.json({ items: [] });
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
