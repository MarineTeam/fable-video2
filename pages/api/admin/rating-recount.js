import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { logAction } from '../../../lib/audit';
import { recountRatings } from '../../../lib/ratingsStore';

// Rebuilds the rating totals from the votes. POST only, no body.
//
// Since the vote script (lib/ratingScripts.js) a vote and its counters are one
// write, so new drift cannot happen. This exists for the drift that already
// did: totals written under the old two-write path, where a failure between
// the vote and its HINCRBY left a total one short, and two racing clicks could
// both count. Safe to run any time — it replaces the counters with what the
// votes add up to, so running it twice changes nothing.
//
// SETTINGS_MANAGE, like /api/admin/cleanup: maintenance that rewrites stored
// data, not an action on one video. requireCapability returns the admin's
// EMAIL in this repo, which is exactly what logAction wants. The answer is
// counts only — the votes it reads are keyed by email, and nothing about who
// voted leaves this route.
async function handler(req, res) {
  const admin = await requireCapability(req, res, CAP.SETTINGS_MANAGE);
  if (!admin) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await recountRatings();
    await logAction(
      admin,
      'ratings.recount',
      `Recounted ${result.votes} vote(s) from ${result.viewers} viewer(s)`
    );
    return res.json(result);
  } catch {
    return res.status(502).json({ error: 'Could not recount ratings' });
  }
}

export default withMonitorApi(handler);
