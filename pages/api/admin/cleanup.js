import { requireAdmin } from '../../../lib/guard';
import { logAction } from '../../../lib/audit';
import { pruneGoneShares } from '../../../lib/share';
import { cleanupStaleBundles } from '../../../lib/bundle';

// Manual garbage collection for the two indexes whose own Redis TTL lags
// behind reality: the `shares` set (ids can outlive their record's grace
// window before anyone runs a GET to sweep them) and the `bundles` set
// (a bundle's expiresAt only ever moves forward, so it can sit around with
// zero live members long before its own TTL catches up). Nothing here is a
// correctness fix — both indexes already self-heal on normal reads — this
// just lets an admin reclaim the space on demand instead of waiting.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const [goneShares, bundleResult] = await Promise.all([pruneGoneShares(), cleanupStaleBundles()]);
    const summary = { goneShares, ...bundleResult };
    await logAction(
      admin,
      'maintenance.cleanup',
      `${summary.goneShares} gone shares, ${summary.staleBundles} stale + ${summary.goneBundles} gone bundles`
    );
    return res.json(summary);
  } catch {
    return res.status(500).json({ error: 'Cleanup failed' });
  }
}
