import { withMonitorApi } from '../../lib/monitor';
import { requireViewer } from '../../lib/guard';
import { allowRequest } from '../../lib/ratelimit';
import { logAction } from '../../lib/audit';
import { getOrIssueFeedToken, issueFeedToken, podcastEnabled } from '../../lib/podcastStore';

// A viewer's own podcast feed URL. requireViewer, and it only ever touches the
// caller's own token — there is no parameter naming someone else.
//
// GET returns the existing token (issuing one on first use, so opening the page
// does not mint a new credential every visit). POST regenerates, which
// immediately revokes the previous URL: that is the revoke button.
async function handler(req, res) {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  if (!podcastEnabled()) return res.status(404).json({ error: 'Not available' });

  if (req.method === 'GET') {
    const result = await getOrIssueFeedToken(viewer.email);
    if (!result.ok) return res.status(500).json({ error: 'Could not load your feed' });
    return res.json({ token: result.token });
  }

  if (req.method === 'POST') {
    if (!(await allowRequest('feed-token', viewer.email, 5, 3600))) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const result = await issueFeedToken(viewer.email);
    if (!result.ok) return res.status(500).json({ error: 'Could not regenerate your feed' });
    await logAction(viewer.email, 'feed.regenerate', viewer.email);
    return res.json({ token: result.token });
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
