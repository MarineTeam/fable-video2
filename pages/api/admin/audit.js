import { withMonitorApi } from "../../../lib/monitor";
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { recentActions } from '../../../lib/audit';

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireCapability(req, res, CAP.AUDIT_READ);
  if (!admin) return;
  res.json({ actions: await recentActions(100) });
}

export default withMonitorApi(handler);
