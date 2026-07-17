import { requireAdmin } from '../../../lib/guard';
import { redis, k } from '../../../lib/redis';
import { logAction } from '../../../lib/audit';

const DEFAULT_COUNT = 48;

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const r = redis();

  if (req.method === 'GET') {
    try {
      const raw = await r.get(k('settings:homeCount'));
      const homeCount = Math.min(Math.max(parseInt(raw, 10) || DEFAULT_COUNT, 1), 200);
      return res.json({ homeCount });
    } catch {
      return res.json({ homeCount: DEFAULT_COUNT });
    }
  }

  if (req.method === 'POST') {
    const homeCount = Math.min(Math.max(parseInt(req.body?.homeCount, 10) || 0, 1), 200);
    if (!homeCount) return res.status(400).json({ error: 'Bad count' });
    try {
      await r.set(k('settings:homeCount'), homeCount);
      await logAction(admin, 'settings.homeCount', String(homeCount));
      return res.json({ homeCount });
    } catch {
      return res.status(500).json({ error: 'Could not save' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
