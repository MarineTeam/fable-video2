import { useEffect } from 'react';
import Head from 'next/head';
import IdleTimeout from '../components/IdleTimeout';
import { applyTheme, validateTheme, THEME_STORAGE_KEY } from '../lib/theme';
import '../styles/globals.css';

export default function App({ Component, pageProps }) {
  useEffect(() => {
    // Refresh the admin-set palette and cache it for the pre-paint script.
    fetch('/api/theme')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const theme = validateTheme(data);
        if (theme) {
          applyTheme(theme);
          try {
            localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
          } catch {}
        }
      })
      .catch(() => {});

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>Marine Video Portal</title>
      </Head>
      {pageProps.user ? <IdleTimeout /> : null}
      <Component {...pageProps} />
    </>
  );
}
