import { requireAdmin } from '../../../lib/guard';
import { recentActions } from '../../../lib/audit';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  res.json({ actions: await recentActions(100) });
}
