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
];

export default config;
