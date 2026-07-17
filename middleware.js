import { auth0 } from './lib/auth0';

// Mounts the Auth0 v4 routes (/auth/login, /auth/logout, /auth/callback,
// /auth/profile) and keeps the session cookie rolling on every other request.
export async function middleware(request) {
  return auth0.middleware(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|sw.js|icon.svg|icon-192.png|icon-512.png|apple-touch-icon.png).*)',
  ],
};
