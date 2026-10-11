import { withMonitorApi } from "../../../lib/monitor";
import { requireActor } from '../../../lib/guard';
import { guidsInScope } from '../../../lib/staffScope';
import { isScoped, personInScope } from '../../../lib/staffScopeRules';
import { groupIdsForEmail, loadGroups } from '../../../lib/groups';
import { CAP } from '../../../lib/capabilities';
import { redis, k } from '../../../lib/redis';
import { normalizeEmail } from '../../../lib/auth';

const MAX_ITEMS = 30;

// Admin lookup of any approved viewer's watch history — reads the same
// progress:<email> hash as /api/progress, just for an email the admin picks
// rather than the caller's own session.
async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const actor = await requireActor(req, res, CAP.ANALYTICS_READ);
  if (!actor) return;

  const email = normalizeEmail(req.query.email);
  if (!email) return res.status(400).json({ error: 'Bad email' });

  const r = redis();
  const isViewer = (await r.sismember(k('viewers'), email).catch(() => 0)) === 1;
  if (!isViewer) return res.status(404).json({ error: 'Not an approved viewer' });
  // A group-scoped caller reads only their own groups' people — anyone else
  // answers exactly like an address that is not a viewer — and only the
  // videos their groups grant.
  if (isScoped(actor)) {
    let inScope = false;
    try {
      const [theirs, groupsById] = await Promise.all([groupIdsForEmail(email), loadGroups()]);
      inScope = personInScope(actor, theirs, groupsById);
    } catch {
      inScope = false;
    }
    if (!inScope) return res.status(404).json({ error: 'Not an approved viewer' });
  }

  try {
    const raw = (await r.hgetall(k(`progress:${email}`))) || {};
    const items = Object.entries(raw)
      .map(([videoId, value]) => {
        const entry = typeof value === 'string' ? safeParse(value) : value;
        if (!entry) return null;
        return { videoId, ...entry };
      })
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .slice(0, MAX_ITEMS);
    const allowed = await guidsInScope(actor, items.map((i) => i.videoId));
    return res.json({ items: items.filter((i) => allowed.has(i.videoId)) });
  } catch {
    return res.json({ items: [] });
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export default withMonitorApi(handler);
