import ShareShell from '../../components/ShareShell';
import { auth0 } from '../../lib/auth0';
import { isAdmin, normalizeEmail } from '../../lib/auth';
import { baseUrl } from '../../lib/share';
import { loadBundle, liveBundleItems } from '../../lib/bundle';
import { isGeoAllowed } from '../../lib/geo';

// Consolidated listing for a recipient with multiple active shares. Gated
// exactly like an individual /s/[id] link: sign in as the bundle's email and
// the same session unlocks this page AND every individual share addressed
// to that email (Auth0's session cookie already applies site-wide — there is
// no separate per-item re-verification to design around).
export async function getServerSideProps({ req, res, params }) {
  const id = String(params.id || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    return { props: { state: 'gone' } };
  }

  const session = await auth0.getSession(req, res);
  if (!session) {
    return {
      redirect: { destination: `/auth/login?returnTo=${encodeURIComponent(`/b/${id}`)}`, permanent: false },
    };
  }
  const email = normalizeEmail(session.user.email);
  const user = { email };

  if (!(await isGeoAllowed(req, { admin: isAdmin(email) }))) {
    return { props: { state: 'blocked', user } };
  }

  const bundle = await loadBundle(id);
  if (!bundle || Date.parse(bundle.expiresAt) <= Date.now()) {
    return { props: { state: 'gone', user } };
  }
  // Generic mismatch message — never reveals who the bundle was for.
  if (normalizeEmail(bundle.email) !== email) {
    return { props: { state: 'mismatch', user } };
  }

  // Pure grouping list on the bundle record — every item's title/expiry is
  // read live from its own share:<id> record here, never cached on the
  // bundle itself, so revoking/expiring one item shows up immediately.
  const items = await liveBundleItems(bundle, baseUrl(req));

  return { props: { state: 'ok', user, items } };
}

export default function Bundle({ state, user, items }) {
  if (state === 'gone') {
    return (
      <ShareShell user={user}>
        <div className="card card-pad notice">
          <h1>Link unavailable</h1>
          <p>This share link has expired or doesn&apos;t exist.</p>
        </div>
      </ShareShell>
    );
  }
  if (state === 'mismatch') {
    return (
      <ShareShell user={user}>
        <div className="card card-pad notice">
          <h1>Wrong account</h1>
          <p>
            This private link was created for a different account. If you received it directly,
            sign out and sign back in with the email address the link was sent to.
          </p>
        </div>
      </ShareShell>
    );
  }
  if (state === 'blocked') {
    return (
      <ShareShell user={user}>
        <div className="card card-pad notice">
          <h1>Not available in your region</h1>
          <p>This link isn&apos;t accessible from your current location.</p>
        </div>
      </ShareShell>
    );
  }
  return (
    <ShareShell user={user}>
      <h1 className="watch-title">Shared with you</h1>
      <ul className="bundle-list">
        {items.map((item) => (
          <li key={item.id} className="card card-pad bundle-item">
            <a href={item.url}>{item.videoTitle}</a>
            <span className="muted">
              expires {new Date(item.expiresAt).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
      {items.length === 0 ? <p className="empty">Nothing currently shared with you.</p> : null}
    </ShareShell>
  );
}
