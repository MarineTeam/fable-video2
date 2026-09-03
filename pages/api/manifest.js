import { withMonitorApi } from '../../lib/monitor';
import { getSiteName } from '../../lib/siteNameStore';
import { shortSiteName } from '../../lib/siteName';
import { DEFAULT_THEME } from '../../lib/theme';

// The PWA manifest, served dynamically so an installed app carries the
// admin-set name. Rewritten onto the original /manifest.webmanifest URL (see
// next.config.js) rather than linked at /api/manifest, so the service worker's
// asset allowlist and the middleware matcher's static-asset exclusion both keep
// working untouched — this URL is deliberately public and pre-login, exactly as
// the static file was.
//
// Public by design and leaks only branding, the same class of exception as
// GET /api/theme.
async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const siteName = await getSiteName();
  res.setHeader('content-type', 'application/manifest+json; charset=utf-8');
  // Always revalidate. This response is tiny and fetched rarely, and the site
  // name behind it can change at any moment with no redeploy — an HTTP cache
  // holding it for even a few minutes is the second way a rename fails to reach
  // an installed app (the first was the service worker, now network-first).
  res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
  res.status(200).send(
    JSON.stringify(
      {
        name: siteName,
        short_name: shortSiteName(siteName),
        description: 'Private, invite-only video portal',
        start_url: '/',
        display: 'standalone',
        background_color: DEFAULT_THEME.colors.bg,
        theme_color: DEFAULT_THEME.colors.bg,
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      null,
      2
    )
  );
}

export default withMonitorApi(handler);
