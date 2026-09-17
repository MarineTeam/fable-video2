import coreWebVitals from 'eslint-config-next/core-web-vitals';

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'public/sw.js'] },
  ...coreWebVitals,
  {
    rules: {
      // Thumbnails are token-signed bunny.net CDN URLs that rely on the
      // browser sending the site Referer; next/image would proxy them
      // server-side and break hotlink protection.
      '@next/next/no-img-element': 'off',
      // This app fetches data on mount with plain fetch + setState (no data
      // library). The new compiler-powered rule flags that whole pattern,
      // including setState that only happens after an await.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // no-undef on server code. eslint-config-next does not enable it for plain
    // JS, which is how `pages/api/share-event.js` shipped calling an
    // unimported `normalizeEmail` — the guard ran, then the handler threw a
    // ReferenceError on every authenticated request. Lint was green, and the
    // route-guard suite only exercises the ANONYMOUS path, which returns 401
    // before reaching the call.
    //
    // Scoped to lib/ and pages/api/ because those run on Node with a small,
    // enumerable global set. Browser code (components/, pages/*.js) would need
    // the whole DOM global list to avoid false positives, which is a different
    // job — the incident was server-side.
    //
    // NEGATIVE CONTROL (re-run after editing this block, per validation-and-qa):
    // remove `normalizeEmail` from the import in pages/api/share-event.js and
    // `npm run lint` must fail with "'normalizeEmail' is not defined". It did.
    files: ['lib/**/*.js', 'pages/api/**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        crypto: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        structuredClone: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: { 'no-undef': 'error' },
  },
];

export default config;
