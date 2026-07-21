import { requireAdmin } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { logAction } from '../../../lib/audit';
import { baseUrl, resendShareEmail, revokeShare } from '../../../lib/share';
import { extendShareAndBundle } from '../../../lib/bundle';

const ACTIONS = new Set(['resend', 'revoke', 'extend']);
const MAX_IDS = 200;

// Multi-select bulk action over existing share links. Every id is processed
// independently — one bad/missing id never aborts the rest of the batch.
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

  const results = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        let outcome;
        if (action === 'resend') outcome = await resendShareEmail(id, origin);
        else if (action === 'revoke') outcome = await revokeShare(id);
        else outcome = await extendShareAndBundle(id, hours);
        return { id, ok: Boolean(outcome.ok), error: outcome.ok ? undefined : outcome.error };
      } catch (err) {
        return { id, ok: false, error: err?.message || 'Failed' };
      }
    })
  );

  const okCount = results.filter((r) => r.ok).length;
  await logAction(
    admin,
    `share.bulk_${action}`,
    `${okCount}/${uniqueIds.length} succeeded`
  );

  res.json({ results });
}
