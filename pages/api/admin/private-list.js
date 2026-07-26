import { requireAdmin } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import { getVideo } from '../../../lib/bunny';
import { logAction } from '../../../lib/audit';
import { createShare, baseUrl, MAX_HOURS } from '../../../lib/share';
import { afterShareCreated } from '../../../lib/bundle';
import {
  loadPrivateList,
  splitPrivateListEmails,
  recordPrivateListShare,
  revokePrivateListEntry,
} from '../../../lib/privateList';

const MAX_EMAILS = 50;

// A video's "Private list" is a persistent, editable invite, independently
// tracked per video (see lib/privateList.js): adding emails only creates a
// share + notification for the ones the list doesn't already have a live
// invite for, and removing one revokes exactly the share the list itself
// created for them — a share for the same (videoId, email) created through
// the regular Share/Bulk Share button is untouched either way.
export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const videoId = String(req.query.videoId || '');
    if (!videoId) return res.status(400).json({ error: 'Bad videoId' });
    try {
      return res.json({ entries: await loadPrivateList(videoId) });
    } catch {
      return res.status(500).json({ error: 'Could not load the private list' });
    }
  }

  if (req.method === 'POST') {
    if (!(await allowRequest('private-list', admin, 10, 60))) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const { videoId, emails, sendEmail } = req.body || {};
    if (typeof videoId !== 'string' || !videoId || videoId.length > 64) {
      return res.status(400).json({ error: 'Bad videoId' });
    }
    if (!Array.isArray(emails) || emails.length === 0 || emails.length > MAX_EMAILS) {
      return res.status(400).json({ error: `Provide 1-${MAX_EMAILS} emails` });
    }
    const normalized = emails.map(normalizeEmail).filter(Boolean);
    if (normalized.length === 0 || normalized.some((e) => !isValidEmail(e))) {
      return res.status(400).json({ error: 'Bad email in list' });
    }

    const current = await loadPrivateList(videoId);
    const fresh = splitPrivateListEmails(normalized, current);
    const skipped = normalized.filter((e) => !fresh.includes(e));

    const origin = baseUrl(req);
    let videoTitle = '';
    try {
      videoTitle = (await getVideo(videoId))?.title || '';
    } catch {}

    let created;
    try {
      created = await Promise.all(
        fresh.map(async (email) => {
          const { id, share } = await createShare({ videoId, email, hours: MAX_HOURS });
          await recordPrivateListShare(videoId, email, id, share);
          return { id, email, url: `${origin}/s/${id}`, videoTitle, expiresAt: share.expiresAt };
        })
      );
    } catch {
      return res.status(500).json({ error: 'Could not create all invites' });
    }

    // Best-effort per recipient, same idiom as share.js/bulk-share.js — a
    // mail failure never blocks the invite from being fully live.
    const outcomes = {};
    await Promise.all(
      created.map(async (item) => {
        outcomes[item.email] = await afterShareCreated({
          email: item.email,
          newItems: [item],
          sendEmail: Boolean(sendEmail),
          origin,
        });
      })
    );

    if (created.length > 0) {
      await logAction(
        admin,
        'private_list.add',
        `${created.length} invited · video ${videoId}${sendEmail ? '' : ' · silent'}`
      );
    }

    return res.json({
      added: created.map((c) => ({ email: c.email, emailed: outcomes[c.email]?.emailed || false })),
      skipped,
    });
  }

  if (req.method === 'DELETE') {
    const videoId = String(req.query.videoId || req.body?.videoId || '');
    const email = String(req.query.email || req.body?.email || '');
    if (!videoId || !email) return res.status(400).json({ error: 'Bad videoId or email' });
    try {
      const result = await revokePrivateListEntry(videoId, email);
      if (result.revoked > 0) {
        await logAction(admin, 'private_list.remove', `${normalizeEmail(email)} · video ${videoId}`);
      }
      return res.json(result);
    } catch {
      return res.status(500).json({ error: 'Could not remove' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
