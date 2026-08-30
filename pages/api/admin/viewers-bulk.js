import { withMonitorApi } from "../../../lib/monitor";
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { allowRequest } from '../../../lib/ratelimit';
import { logAction } from '../../../lib/audit';
import { addTagToViewers, removeTagFromViewers } from '../../../lib/viewerTags';

const ACTIONS = new Set(['add-tag', 'remove-tag']);
const MAX_EMAILS = 500;

// Multi-select tag action over approved viewers, mirroring videos-bulk.js /
// shares-bulk.js: every email is processed independently, one bad email
// never aborts the rest of the batch. Also doubles as the single-viewer
// tag editor — the admin UI just calls it with a one-email selection.
async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireCapability(req, res, CAP.VIEWERS_MANAGE);
  if (!admin) return;
  if (!(await allowRequest('viewers-bulk', admin, 20, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { action, emails, tag } = req.body || {};
  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Bad action' });
  if (!Array.isArray(emails) || emails.length === 0 || emails.length > MAX_EMAILS) {
    return res.status(400).json({ error: `Select 1-${MAX_EMAILS} viewers` });
  }
  if (typeof tag !== 'string' || !tag.trim()) {
    return res.status(400).json({ error: 'Bad tag' });
  }
  const uniqueEmails = [...new Set(emails.map(String))];

  let results;
  try {
    results =
      action === 'add-tag'
        ? await addTagToViewers(uniqueEmails, tag)
        : await removeTagFromViewers(uniqueEmails, tag);
  } catch {
    return res.status(500).json({ error: 'Could not complete the bulk action' });
  }

  const okCount = results.filter((r) => r.ok).length;
  await logAction(
    admin,
    action === 'add-tag' ? 'viewer.bulk_tag' : 'viewer.bulk_untag',
    `"${tag.trim().slice(0, 40)}" · ${okCount}/${uniqueEmails.length} succeeded`
  );

  res.json({ results });
}

export default withMonitorApi(handler);
