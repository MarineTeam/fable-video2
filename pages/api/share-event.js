import { auth0 } from '../../lib/auth0';
import { normalizeEmail } from '../../lib/auth';
import { allowRequest } from '../../lib/ratelimit';
import { redis, k } from '../../lib/redis';
import { isShareActive } from '../../lib/share';

// Real playback signal for a share link, reported by the player itself
// (play / progress / ended) rather than inferred from page loads.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const session = await auth0.getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  const email = normalizeEmail(session.user.email);
  if (!(await allowRequest('share-event', email, 60, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { id, type, percent } = req.body || {};
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    return res.status(400).json({ error: 'Bad id' });
  }
  if (type !== 'play' && type !== 'progress' && type !== 'complete') {
    return res.status(400).json({ error: 'Bad type' });
  }

  const key = k(`share:${id}`);
  const r = redis();
  let share;
  try {
    share = await r.get(key);
  } catch {
    return res.status(500).json({ error: 'Could not load link' });
  }
  // Revoked/expired records can still exist during their grace window (see
  // lib/share.js GRACE_SECONDS) — treat them the same as truly gone.
  if (!isShareActive(share)) return res.status(404).json({ error: 'Link expired or does not exist' });
  // Same rule as the share page itself: never let one recipient's viewing
  // affect or reveal another recipient's link.
  if (normalizeEmail(share.email) !== email) return res.status(403).json({ error: 'Not your link' });

  const patch = {};
  if (type === 'play') {
    patch.plays = (share.plays || 0) + 1;
  } else if (type === 'progress') {
    const p = Math.max(0, Math.min(100, Math.floor(Number(percent) || 0)));
    patch.furthestPercent = Math.max(share.furthestPercent || 0, p);
  } else {
    patch.furthestPercent = 100;
    patch.completedAt = new Date().toISOString();
  }

  try {
    const ttl = await r.ttl(key);
    if (ttl > 0) {
      await r.set(key, { ...share, ...patch }, { ex: ttl });
    }
  } catch {}
  res.json({ ok: true });
}
