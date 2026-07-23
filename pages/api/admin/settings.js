import { requireAdmin } from '../../../lib/guard';
import { redis, k } from '../../../lib/redis';
import { logAction } from '../../../lib/audit';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import {
  getGlobalDefault,
  setGlobalDefault,
  listExempt,
  addExempt,
  removeExempt,
} from '../../../lib/watermark';
import {
  geoWhitelist,
  adminGeoWhitelist,
  adminGeoBypassEmails,
  geoEnforcementOn,
  adminGeoEnforcementOn,
} from '../../../lib/geo';

const DEFAULT_COUNT = 48;

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const r = redis();

  if (req.method === 'GET') {
    let homeCount = DEFAULT_COUNT;
    try {
      const raw = await r.get(k('settings:homeCount'));
      homeCount = Math.min(Math.max(parseInt(raw, 10) || DEFAULT_COUNT, 1), 200);
    } catch {}
    const [watermarkDefault, watermarkExempt, geoEnforcement, adminGeoEnforcement] = await Promise.all([
      getGlobalDefault(),
      listExempt(),
      geoEnforcementOn(),
      adminGeoEnforcementOn(),
    ]);
    return res.json({
      homeCount,
      watermarkDefault,
      watermarkExempt,
      geoEnforcement,
      geoWhitelist: geoWhitelist(),
      adminGeoEnforcement,
      adminGeoWhitelist: adminGeoWhitelist(),
      adminGeoBypassEmails: adminGeoBypassEmails(),
    });
  }

  if (req.method === 'POST') {
    // Homepage video count.
    if (req.body?.homeCount !== undefined) {
      const homeCount = Math.min(Math.max(parseInt(req.body.homeCount, 10) || 0, 1), 200);
      if (!homeCount) return res.status(400).json({ error: 'Bad count' });
      try {
        await r.set(k('settings:homeCount'), homeCount);
        await logAction(admin, 'settings.homeCount', String(homeCount));
        return res.json({ homeCount });
      } catch {
        return res.status(500).json({ error: 'Could not save' });
      }
    }

    // Global watermark default.
    if (typeof req.body?.watermarkDefault === 'boolean') {
      try {
        const on = await setGlobalDefault(req.body.watermarkDefault);
        await logAction(admin, 'settings.watermarkDefault', on ? 'on' : 'off');
        return res.json({ watermarkDefault: on });
      } catch {
        return res.status(500).json({ error: 'Could not save' });
      }
    }

    // Viewer geo-enforcement toggle. The whitelist itself is env-only
    // (GEO_WHITELIST) and shown read-only in the admin UI.
    if (typeof req.body?.geoEnforcement === 'boolean') {
      try {
        await r.set(k('settings:geoEnforcement'), req.body.geoEnforcement ? '1' : '0');
        await logAction(admin, 'settings.geoEnforcement', req.body.geoEnforcement ? 'on' : 'off');
        return res.json({ geoEnforcement: req.body.geoEnforcement });
      } catch {
        return res.status(500).json({ error: 'Could not save' });
      }
    }

    // Admin geo-enforcement toggle. Separate from the viewer toggle above so
    // an admin traveling never gets locked out by the viewer whitelist — the
    // admin whitelist (ADMIN_GEO_WHITELIST) is a distinct env var an admin
    // can always edit directly in Vercel even if this UI is unreachable.
    if (typeof req.body?.adminGeoEnforcement === 'boolean') {
      try {
        await r.set(k('settings:adminGeoEnforcement'), req.body.adminGeoEnforcement ? '1' : '0');
        await logAction(
          admin,
          'settings.adminGeoEnforcement',
          req.body.adminGeoEnforcement ? 'on' : 'off'
        );
        return res.json({ adminGeoEnforcement: req.body.adminGeoEnforcement });
      } catch {
        return res.status(500).json({ error: 'Could not save' });
      }
    }

    // Add a watermark exemption.
    if (req.body?.addWatermarkExempt) {
      const email = normalizeEmail(req.body.addWatermarkExempt);
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Bad email' });
      try {
        await addExempt(email);
        await logAction(admin, 'watermark.exempt_add', email);
        return res.json({ ok: true, exempt: await listExempt() });
      } catch {
        return res.status(500).json({ error: 'Could not save' });
      }
    }

    return res.status(400).json({ error: 'Nothing to update' });
  }

  if (req.method === 'DELETE') {
    const email = normalizeEmail(req.body?.removeWatermarkExempt || req.query.removeWatermarkExempt);
    if (!email) return res.status(400).json({ error: 'Bad email' });
    try {
      await removeExempt(email);
      await logAction(admin, 'watermark.exempt_remove', email);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not remove' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
