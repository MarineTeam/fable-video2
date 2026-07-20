import { requireAdmin } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import { getVideo } from '../../../lib/bunny';
import { mailEnabled, sendBulkShareEmail } from '../../../lib/mail';
import { logAction } from '../../../lib/audit';
import { createShare, clampHours, baseUrl } from '../../../lib/share';

const MAX_VIDEOS = 50;
const MAX_EMAILS = 50;
const MAX_PAIRS = 300; // videos x recipients per request

// Select N videos x M recipients, get N*M independently-revocable links —
// one email per recipient listing only the links addressed to them.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!(await allowRequest('bulk-share', admin, 5, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { videoIds, emails, hours, sendEmail } = req.body || {};
  if (!Array.isArray(videoIds) || videoIds.length === 0 || videoIds.length > MAX_VIDEOS) {
    return res.status(400).json({ error: `Pick 1-${MAX_VIDEOS} videos` });
  }
  if (videoIds.some((v) => typeof v !== 'string' || !v || v.length > 64)) {
    return res.status(400).json({ error: 'Bad videoId in selection' });
  }
  if (!Array.isArray(emails) || emails.length === 0 || emails.length > MAX_EMAILS) {
    return res.status(400).json({ error: `Provide 1-${MAX_EMAILS} recipient emails` });
  }
  const recipients = [...new Set(emails.map(normalizeEmail))].filter(Boolean);
  if (recipients.some((e) => !isValidEmail(e))) {
    return res.status(400).json({ error: 'Bad recipient email in list' });
  }
  const uniqueVideoIds = [...new Set(videoIds)];
  const totalPairs = uniqueVideoIds.length * recipients.length;
  if (totalPairs > MAX_PAIRS) {
    return res.status(400).json({ error: `Too many links requested (${totalPairs} > ${MAX_PAIRS})` });
  }
  const ttlHours = clampHours(hours);

  const titles = {};
  await Promise.all(
    uniqueVideoIds.map(async (videoId) => {
      try {
        titles[videoId] = (await getVideo(videoId))?.title || videoId;
      } catch {
        titles[videoId] = videoId;
      }
    })
  );

  const url = baseUrl(req);
  const linksByRecipient = new Map(recipients.map((email) => [email, []]));
  let created = 0;
  try {
    await Promise.all(
      recipients.flatMap((email) =>
        uniqueVideoIds.map(async (videoId) => {
          const { id, share } = await createShare({ videoId, email, hours: ttlHours });
          created += 1;
          linksByRecipient.get(email).push({
            id,
            url: `${url}/s/${id}`,
            videoTitle: titles[videoId],
            expiresAt: share.expiresAt,
          });
        })
      )
    );
  } catch {
    return res.status(500).json({ error: 'Could not create all links' });
  }

  await logAction(
    admin,
    'share.bulk_create',
    `${recipients.length} recipients × ${uniqueVideoIds.length} videos = ${created} links · ${ttlHours}h`
  );

  const emailed = {};
  if (sendEmail && mailEnabled()) {
    await Promise.all(
      recipients.map(async (email) => {
        const items = linksByRecipient.get(email);
        const result = await sendBulkShareEmail({ to: email, items });
        emailed[email] = Boolean(result.ok);
      })
    );
  }

  res.json({
    created,
    recipients: recipients.map((email) => ({
      email,
      links: linksByRecipient.get(email).length,
      emailed: emailed[email] || false,
    })),
  });
}
