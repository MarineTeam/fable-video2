import { Html, Head, Main, NextScript } from 'next/document';
import { COLOR_KEYS, DEFAULT_THEME, THEME_STORAGE_KEY } from '../lib/theme';

// Embedding a value in a <script> is not the same as serializing it.
// JSON.stringify leaves '<' alone, so a value containing '</script>' would
// close the tag early, and it passes U+2028/U+2029 through, which older
// parsers read as line terminators inside a string literal. Escaping those
// three is what makes the output safe to paste into code - CodeQL flags the
// bare JSON.stringify as improper sanitization (js/bad-code-sanitization),
// and it is right to: the values below are constants we control today, but
// the call site is what has to stay safe, not whatever flows through it.
function jsLiteral(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Applies the cached palette before first paint so returning visitors never
// see a color flash.
//
// Each value is re-checked against the SAME 6-digit hex shape lib/theme.js
// enforces on write (`HEX` / `validateTheme`). The palette arrives here from
// localStorage, which this script cannot vouch for: `setProperty` with an
// unchecked string lets whatever wrote that cache put arbitrary text into a
// CSS custom property. Re-applying the server-side contract costs one regex
// and keeps the two ends in step — one bad value drops the whole cached
// palette and the page renders the default, which is the same thing a missing
// cache does.
//
// The variable list is derived from COLOR_KEYS rather than spelled out, so a
// new colour cannot be added to the theme and silently skip this check;
// themeCssVars() maps every key to '--' + key.
const noFlash = `try{var h=/^#[0-9a-fA-F]{6}$/,k=${jsLiteral(
  COLOR_KEYS
)},t=JSON.parse(localStorage.getItem(${jsLiteral(
  THEME_STORAGE_KEY
)})||"null");if(t&&t.colors&&k.every(function(n){return h.test(t.colors[n])})){var s=document.documentElement.style;k.forEach(function(n){s.setProperty("--"+n,t.colors[n])})}}catch(e){}`;

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        {/* The admin-set iOS icon when there is one, else a redirect to the
            built-in file — see pages/api/app-icon/[size].js. */}
        <link rel="apple-touch-icon" href="/api/app-icon/180" />
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
