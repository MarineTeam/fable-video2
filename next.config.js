const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The PWA manifest is generated (it carries the admin-set site name) but keeps
  // its original URL, so public/sw.js's asset allowlist and middleware.js's
  // static-asset exclusion need no changes. The static file it replaced was
  // deleted, so an ordinary rewrite is enough — nothing on disk shadows it.
  async rewrites() {
    return [{ source: '/manifest.webmanifest', destination: '/api/manifest' }];
  },
  // Baseline response hardening. Deliberately NOT a full CSP: the pre-paint
  // theme script in pages/_document.js and Next's own bootstrap are inline, so
  // a script-src policy would need nonces threaded through both — a separate
  // piece of work. `frame-ancestors` is the part that closes a real hole, and
  // it needs no nonce.
  //
  // Referrer-Policy is strict-origin-when-cross-origin, NOT no-referrer:
  // bunny.net thumbnail hotlink protection checks the Referer, so suppressing
  // it entirely breaks every thumbnail (see the no-img-element note in
  // eslint.config.mjs). Sending the origin cross-origin satisfies Bunny while
  // keeping share ids, which live in the URL path, off the wire.
  //
  // No Strict-Transport-Security here on purpose: Vercel already sets it on its
  // own domains, and a wrong max-age/includeSubDomains is cached by browsers and
  // cannot be withdrawn quickly.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // /admin has one-click destructive actions; framing it anywhere is
          // clickjacking. Both headers, since X-Frame-Options is what older
          // browsers honour and frame-ancestors is what current ones do.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

module.exports = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  widenClientFileUpload: true,
  disableLogger: true,
  telemetry: false,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
});
