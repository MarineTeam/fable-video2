import { auth0 } from './auth0';
import { isAdmin, normalizeEmail } from './auth';
import { redis, k } from './redis';
import { isGeoAllowed } from './geo';

export async function getSessionEmail(req, res) {
  const session = await auth0.getSession(req, res);
  return normalizeEmail(session?.user?.email);
}

// For /api/admin/*: responds 403 and returns null unless the caller is an admin.
export async function requireAdmin(req, res) {
  const email = await getSessionEmail(req, res);
  if (!email || !isAdmin(email)) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  if (!(await isGeoAllowed(req, { admin: true, email }))) {
    res.status(403).json({ error: 'Not available in your region' });
    return null;
  }
  return email;
}

// For viewer APIs: admin or approved viewer. Stamps last-seen as a side effect.
export async function requireViewer(req, res) {
  const email = await getSessionEmail(req, res);
  if (!email) {
    res.status(401).json({ error: 'Not signed in' });
    return null;
  }
  const admin = isAdmin(email);
  let approved = admin;
  if (!approved) {
    try {
      approved = (await redis().sismember(k('viewers'), email)) === 1;
    } catch {
      approved = false;
    }
  }
  if (!approved) {
    res.status(403).json({ error: 'Not approved' });
    return null;
  }
  if (!(await isGeoAllowed(req, { admin, email }))) {
    res.status(403).json({ error: 'Not available in your region' });
    return null;
  }
  redis()
    .hset(k('viewer:lastseen'), { [email]: new Date().toISOString() })
    .catch(() => {});
  return { email, admin };
}
