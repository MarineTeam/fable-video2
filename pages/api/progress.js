import { requireViewer } from '../../lib/guard';
import { redis, k } from '../../lib/redis';

const MAX_ITEMS = 30;

// Per-viewer playback progress / watch history, keyed by email.
export default async function handler(req, res) {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  const key = k(`progress:${viewer.email}`);
  const r = redis();

  if (req.method === 'GET') {
    try {
      const raw = (await r.hgetall(key)) || {};
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

  if (req.method === 'POST') {
    const { videoId, seconds, duration, title } = req.body || {};
    if (typeof videoId !== 'string' || !videoId || videoId.length > 100) {
      return res.status(400).json({ error: 'Bad videoId' });
    }
    const s = Number(seconds);
    const d = Number(duration);
    if (!Number.isFinite(s) || !Number.isFinite(d) || s < 0 || d <= 0) {
      return res.status(400).json({ error: 'Bad progress values' });
    }
    try {
      await r.hset(key, {
        [videoId]: {
          seconds: Math.floor(s),
          duration: Math.floor(d),
          title: typeof title === 'string' ? title.slice(0, 200) : '',
          updatedAt: new Date().toISOString(),
        },
      });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not save progress' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
