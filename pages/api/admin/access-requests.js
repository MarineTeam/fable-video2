import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { redis, k } from '../../../lib/redis';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import { logAction } from '../../../lib/audit';
import { loadAccessRequests, removeAccessRequest } from '../../../lib/accessRequests';
import { loadGroups, setGroupsForEmail } from '../../../lib/groups';

// Admin side of the access-request queue. Reading the queue is viewers.read;
// acting on it is viewers.manage — the same split the Viewers tab already uses,
// so a read-only staff member can see the backlog without being able to let
// anyone in.
async function handler(req, res) {
  const cap = req.method === 'GET' ? CAP.VIEWERS_READ : CAP.VIEWERS_MANAGE;
  const admin = await requireCapability(req, res, cap);
  if (!admin) return;

  if (req.method === 'GET') {
    try {
      return res.json({ requests: await loadAccessRequests() });
    } catch {
      return res.status(500).json({ error: 'Could not load access requests' });
    }
  }

  // Approve: add to the viewers SET, optionally drop them straight into
  // groups, then clear the queue entry. Groups are assigned here because the
  // moment of approval is when an admin actually knows where someone belongs.
  if (req.method === 'POST') {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Bad email' });
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds.map(String) : [];
    try {
      await redis().sadd(k('viewers'), email);
      if (groupIds.length) {
        const groupsById = await loadGroups();
        await setGroupsForEmail(email, groupIds, groupsById);
      }
      await removeAccessRequest(email);
      await logAction(
        admin,
        'access.approve',
        groupIds.length ? `${email} -> ${groupIds.join(', ')}` : email
      );
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not approve the request' });
    }
  }

  // Dismiss: drop the queue entry without granting anything. Not a block —
  // the same person can ask again once the rate-limit window passes.
  if (req.method === 'DELETE') {
    const email = normalizeEmail(req.body?.email || req.query.email);
    if (!email) return res.status(400).json({ error: 'Bad email' });
    try {
      await removeAccessRequest(email);
      await logAction(admin, 'access.dismiss', email);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not dismiss the request' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
