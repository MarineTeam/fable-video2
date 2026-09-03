import { redis, k } from './redis';
import { siteNameOrDefault, normalizeSiteName } from './siteName';

// Redis side of the site name, kept apart from lib/siteName.js so the pure
// helpers stay importable from client-rendered code (see the note there).
//
//   k('settings:siteName')  string
//
// Reads fail back to the default name. Branding is not an access decision, and
// a Redis hiccup rendering the header blank — or worse, blocking the page —
// would be a far worse failure than showing the stock name for one request.
export async function getSiteName() {
  try {
    return siteNameOrDefault(await redis().get(k('settings:siteName')));
  } catch {
    return siteNameOrDefault(null);
  }
}

// Storing null/blank clears the override and returns the app to its default,
// which is why an empty submission is a valid "reset" rather than an error.
export async function setSiteName(raw) {
  const name = normalizeSiteName(raw);
  if (!name) {
    await redis().del(k('settings:siteName'));
    return { ok: true, siteName: siteNameOrDefault(null), cleared: true };
  }
  await redis().set(k('settings:siteName'), name);
  return { ok: true, siteName: name, cleared: false };
}

// Injects the site name into every prop-returning page result. Composed around
// each page's own getServerSideProps rather than added branch by branch: the
// pages have many exit branches between them (unverified, geo-blocked, not
// approved, share gone/mismatch/blocked, ok), and hand-editing each one is
// exactly how a page ends up rendering the stock name in one rare state.
//
// Redirects and notFound results carry no props and are skipped, so a redirect
// costs no extra Redis read. Wrap INSIDE withMonitorPage so the Query Monitor
// counts this read like any other.
export function withSiteName(gssp) {
  return async (ctx) => {
    const result = await gssp(ctx);
    if (result && result.props) {
      result.props.siteName = await getSiteName();
    }
    return result;
  };
}
