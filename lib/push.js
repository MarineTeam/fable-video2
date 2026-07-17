import { redis, k } from './redis';
import { adminEmails, normalizeEmail } from './auth';

// Web Push. Completely inert unless BOTH keys are configured.
export function pushEnabled() {
  return Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export const ANNOUNCE_WINDOW_MS = 48 * 3600 * 1000;

// Announce only videos that finished encoding (status 4) and were uploaded
// recently, so enabling push never back-blasts the existing library.
export function shouldAnnounce(video, now = Date.now()) {
  if (!video || video.status !== 4) return false;
  const uploaded = Date.parse(video.dateUploaded || '');
  if (!Number.isFinite(uploaded)) return false;
  return now - uploaded <= ANNOUNCE_WINDOW_MS;
}

// Sends reach only currently-allowed emails — a removed viewer stops receiving
// pushes even if their device subscription lingers.
export function eligibleSubs(entries, allowedEmails) {
  const allowed = new Set([...allowedEmails].map(normalizeEmail));
  return (entries || []).filter(
    (e) => e && e.sub && e.sub.endpoint && allowed.has(normalizeEmail(e.email))
  );
}

let vapidConfigured = false;

async function webPush() {
  const mod = await import('web-push');
  const wp = mod.default || mod;
  if (!vapidConfigured) {
    const subject =
      process.env.VAPID_SUBJECT || `mailto:${adminEmails()[0] || 'admin@example.com'}`;
    wp.setVapidDetails(
      subject,
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    vapidConfigured = true;
  }
  return wp;
}

async function allowedEmailSet() {
  let viewers = [];
  try {
    viewers = (await redis().smembers(k('viewers'))) || [];
  } catch {
    viewers = [];
  }
  return new Set([...viewers, ...adminEmails()].map(normalizeEmail));
}

export async function sendToAll(payload) {
  if (!pushEnabled()) return { sent: 0, pruned: 0 };
  const r = redis();
  const raw = (await r.hgetall(k('push:subs'))) || {};
  const entries = Object.values(raw).map((v) => {
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    }
    return v;
  });
  const targets = eligibleSubs(entries, await allowedEmailSet());
  if (!targets.length) return { sent: 0, pruned: 0 };

  const wp = await webPush();
  const body = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;
  await Promise.all(
    targets.map(async (target) => {
      try {
        await wp.sendNotification(target.sub, body);
        sent += 1;
      } catch (err) {
        // Dead subscriptions are pruned automatically.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await r.hdel(k('push:subs'), target.sub.endpoint).catch(() => {});
          pruned += 1;
        }
      }
    })
  );
  return { sent, pruned };
}

// Called opportunistically (admin library refreshes). The atomic SADD guard
// ensures each video is announced exactly once even across concurrent polls.
export async function announceNewVideos(videos) {
  if (!pushEnabled()) return;
  for (const video of videos || []) {
    if (!shouldAnnounce(video)) continue;
    try {
      const added = await redis().sadd(k('push:announced'), video.guid);
      if (added === 1) {
        await sendToAll({
          title: 'New video available',
          body: video.title || 'A new video was just published.',
          url: `/watch/${video.guid}`,
        });
      }
    } catch {
      // best-effort
    }
  }
}
