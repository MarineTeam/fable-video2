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
