import { auth0 } from './lib/auth0';

// Mounts the Auth0 v4 routes (/auth/login, /auth/logout, /auth/callback,
// /auth/profile) and keeps the session cookie rolling on every other request.
export async function middleware(request) {
  return auth0.middleware(request);
}

// Scheduled jobs (api/cron) are left out: their caller is Vercel's cron
// runner, which has no session to roll. CRON_SECRET is their gate
// (lib/cronAuth.js).
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|sw.js|icon.svg|icon-192.png|icon-512.png|apple-touch-icon.png|api/app-icon|api/cron/).*)',
  ],
};
