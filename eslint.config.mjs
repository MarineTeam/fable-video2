import coreWebVitals from 'eslint-config-next/core-web-vitals';

export default [
  { ignores: ['.next/**', 'node_modules/**', 'public/sw.js'] },
  ...coreWebVitals,
  {
    rules: {
      // Thumbnails are token-signed bunny.net CDN URLs that rely on the
      // browser sending the site Referer; next/image would proxy them
      // server-side and break hotlink protection.
      '@next/next/no-img-element': 'off',
    },
  },
];
