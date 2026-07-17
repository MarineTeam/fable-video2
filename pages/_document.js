import { Html, Head, Main, NextScript } from 'next/document';
import { DEFAULT_THEME, THEME_STORAGE_KEY } from '../lib/theme';

// Applies the cached palette before first paint so returning visitors never
// see a color flash.
const noFlash = `try{var t=JSON.parse(localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)})||"null");if(t&&t.colors){var s=document.documentElement.style;s.setProperty("--bg",t.colors.bg);s.setProperty("--panel",t.colors.panel);s.setProperty("--text",t.colors.text);s.setProperty("--muted",t.colors.muted);s.setProperty("--accent",t.colors.accent);s.setProperty("--accent2",t.colors.accent2);}}catch(e){}`;

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="theme-color" content={DEFAULT_THEME.colors.bg} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
