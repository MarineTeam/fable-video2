import { requireAdmin } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { logAction } from '../../../lib/audit';
import { baseUrl, resendShareEmails, revokeShares, unrevokeShares, purgeShares } from '../../../lib/share';
import { extendSharesAndBundle } from '../../../lib/bundle';

const ACTIONS = new Set(['resend', 'revoke', 'unrevoke', 'delete', 'extend']);
const MAX_IDS = 200;

// Multi-select bulk action over existing share links. Every id is processed
// independently — one bad/missing id never aborts the rest of the batch.
// Each action below starts with a single batched Redis fetch (MGET) for the
// whole selection instead of one GET per id — see lib/share.js/lib/bundle.js
// for why that's the difference between O(1) and O(selection size) commands.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!(await allowRequest('shares-bulk', admin, 10, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { action, ids, hours } = req.body || {};
  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Bad action' });
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS) {
    return res.status(400).json({ error: `Select 1-${MAX_IDS} links` });
  }
  const uniqueIds = [...new Set(ids.map(String))];
  const origin = baseUrl(req);

  let results;
  try {
    if (action === 'resend') results = await resendShareEmails(uniqueIds, origin);
    else if (action === 'revoke') results = await revokeShares(uniqueIds);
    else if (action === 'unrevoke') results = await unrevokeShares(uniqueIds);
    else if (action === 'delete') results = await purgeShares(uniqueIds);
    else results = await extendSharesAndBundle(uniqueIds, hours);
  } catch {
    return res.status(500).json({ error: 'Could not complete the bulk action' });
  }

  const okCount = results.filter((r) => r.ok).length;
  await logAction(
    admin,
    `share.bulk_${action}`,
    `${okCount}/${uniqueIds.length} succeeded`
  );

  res.json({ results });
}
