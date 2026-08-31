import { withMonitorApi } from "../../lib/monitor";
import { requireCapability } from '../../lib/guard';
import { CAP } from '../../lib/capabilities';
import { redis, k } from '../../lib/redis';
import { DEFAULT_THEME, validateTheme } from '../../lib/theme';
import { logAction } from '../../lib/audit';

// GET is public (the palette applies to the login-facing shell too and leaks
// nothing but colors). POST is admin-only.
async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const stored = await redis().get(k('theme'));
      const theme = validateTheme(stored) || DEFAULT_THEME;
      return res.json(theme);
    } catch {
      return res.json(DEFAULT_THEME);
    }
  }

  if (req.method === 'POST') {
    const admin = await requireCapability(req, res, CAP.SETTINGS_MANAGE);
    if (!admin) return;
    const theme = validateTheme(req.body);
    if (!theme) return res.status(400).json({ error: 'Invalid palette' });
    try {
      await redis().set(k('theme'), theme);
      await logAction(admin, 'theme.update', theme.name);
      return res.json(theme);
    } catch {
      return res.status(500).json({ error: 'Could not save palette' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
