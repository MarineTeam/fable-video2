import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { logAction } from '../../../lib/audit';
import { validateIconSet } from '../../../lib/appIcon';
import { clearAppIcons, setAppIcons } from '../../../lib/appIconStore';

// Sets or resets the app icon. SETTINGS_MANAGE, like the site name.
//
//   PUT    { icons: { 180: base64, 192: base64, 512: base64 } }  -> { version }
//   DELETE                                                        -> built-in icon
//
// The browser resizes; nothing about that is trusted — lib/appIcon.js checks
// every size is a PNG of exactly that size, under a byte cap, before storing.
export const config = { api: { bodyParser: { sizeLimit: '1.5mb' } } };

async function handler(req, res) {
  const admin = await requireCapability(req, res, CAP.SETTINGS_MANAGE);
  if (!admin) return;

  if (req.method === 'PUT') {
    const result = validateIconSet(req.body?.icons);
    if (!result.ok) return res.status(400).json({ error: result.error });
    try {
      const version = await setAppIcons(result.icons);
      await logAction(admin, 'settings.app_icon', `set ${version}`);
      return res.json({ version });
    } catch {
      return res.status(502).json({ error: 'Could not save the icon' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await clearAppIcons();
      await logAction(admin, 'settings.app_icon', 'reset to default');
      return res.json({ ok: true });
    } catch {
      return res.status(502).json({ error: 'Could not reset the icon' });
    }
  }

  res.setHeader('Allow', 'PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
