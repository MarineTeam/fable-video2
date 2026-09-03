import { useEffect } from 'react';
import Head from 'next/head';
import IdleTimeout from '../components/IdleTimeout';
import QueryMonitor from '../components/QueryMonitor';
import { applyTheme, validateTheme, THEME_STORAGE_KEY } from '../lib/theme';
import { siteNameOrDefault } from '../lib/siteName';
import '../styles/globals.css';

export default function App({ Component, pageProps }) {
  // Server-resolved and passed through page props, so the tab title is
  // correct in the first HTML response rather than corrected after paint.
  const siteName = siteNameOrDefault(pageProps.siteName);
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
        <title>{siteName}</title>
      </Head>
      {pageProps.user ? <IdleTimeout /> : null}
      <Component {...pageProps} />
      {pageProps.user ? <QueryMonitor ssrStats={pageProps._monitor} /> : null}
    </>
  );
}
