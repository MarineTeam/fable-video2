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
  {
    // The same rule on browser code. Its absence hid the access-request queue
    // (2026-08-31 to 2026-09-24): the loader and the Approve / Dismiss
    // handlers were pasted into AddViewersByTag instead of ViewersTab, where
    // setRequests and friends do not exist. Lint was green, the catches
    // swallowed the ReferenceErrors, and the queue simply never loaded. The
    // globals are listed rather than taken from a package, like the block
    // above, so a new one is a deliberate line here and a missing one fails
    // lint loudly.
    //
    // NEGATIVE CONTROL: reference an undeclared name in any page or component
    // and `npm run lint` must fail with "'<name>' is not defined".
    files: ['pages/**/*.js', 'components/**/*.js'],
    ignores: ['pages/api/**'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        AbortController: 'readonly',
        Notification: 'readonly',
        Image: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        Intl: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        confirm: 'readonly',
        alert: 'readonly',
      },
    },
    rules: { 'no-undef': 'error' },
  },
];

export default config;
