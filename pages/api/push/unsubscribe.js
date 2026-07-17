import { getSessionEmail } from '../../../lib/guard';
import { redis, k } from '../../../lib/redis';

// Unsubscribing is always allowed for a signed-in user — even one who is no
// longer approved should be able to silence their own device.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const email = await getSessionEmail(req, res);
  if (!email) return res.status(401).json({ error: 'Not signed in' });

  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    return res.status(400).json({ error: 'Bad endpoint' });
  }
  try {
    await redis().hdel(k('push:subs'), endpoint);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not remove subscription' });
  }
}
