import { useEffect, useState } from 'react';
import AppShell from '../components/AppShell';
import { auth0 } from '../lib/auth0';
import { normalizeEmail, trustedEmail } from '../lib/auth';
import { viewerAccessFor } from '../lib/guard';
import { CAP } from '../lib/capabilities';
import { withMonitorPage } from '../lib/monitor';
import { withSiteName } from '../lib/siteNameStore';

// Server-side gate mirrors pages/index.js: approved viewer or staff only —
// via the same shared helper, so a role-holder is never told "not approved"
// here while being approved everywhere else.
async function gssp({ req, res }) {
  const session = await auth0.getSession(req, res);
  if (!session) {
    return { redirect: { destination: '/auth/login?returnTo=/activity', permanent: false } };
  }
  const email = trustedEmail(session.user);
  if (!email) {
    const claimed = normalizeEmail(session.user.email);
    return {
      props: {
        user: { email: claimed, name: session.user.name || claimed },
        isAdmin: false,
        canLookUpOthers: false,
        approved: false,
        unverified: true,
      },
    };
  }
  const { approved, owner, staff, capabilities } = await viewerAccessFor(email);
  // The lookup dropdown needs BOTH underlying routes, so it is offered only to
  // someone who holds both capabilities — otherwise it renders a control that
  // is guaranteed to 403 on use.
  const canLookUpOthers =
    owner ||
    (capabilities.includes(CAP.VIEWERS_READ) && capabilities.includes(CAP.ANALYTICS_READ));
  return {
    props: {
      user: { email, name: session.user.name || email },
      isAdmin: owner || staff,
      canLookUpOthers,
      approved,
    },
  };
}

export const getServerSideProps = withMonitorPage(withSiteName(gssp));

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export default function Activity({ user, isAdmin: admin, canLookUpOthers, approved, unverified, siteName }) {
  const [viewers, setViewers] = useState([]);
  const [selected, setSelected] = useState('__me__');
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canLookUpOthers) return;
    api('/api/admin/viewers')
      .then((d) => setViewers(d.viewers || []))
      .catch(() => {});
  }, [canLookUpOthers]);

  useEffect(() => {
    if (!approved) return;
    setItems(null);
    setError('');
    const path = selected === '__me__' ? '/api/progress' : `/api/admin/viewer-activity?email=${encodeURIComponent(selected)}`;
    api(path)
      .then((d) => setItems(d.items || []))
      .catch((err) => setError(err.message));
  }, [approved, selected]);

  if (unverified) {
    return (
      <AppShell siteName={siteName} user={user} isAdmin={false} approved={false}>
        <div className="card card-pad notice">
          <h1>Verify your email</h1>
          <p>
            You&apos;re signed in as <strong>{user.email}</strong>, but that address hasn&apos;t been
            verified yet. Check your inbox for the verification link, then reload this page.
          </p>
        </div>
      </AppShell>
    );
  }

  if (!approved) {
    return (
      <AppShell siteName={siteName} user={user} isAdmin={admin} approved={false}>
        <div className="card card-pad notice">
          <h1>Not approved yet</h1>
          <p>
            You&apos;re signed in as <strong>{user.email}</strong>, but this account isn&apos;t on
            the approved viewer list.
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell siteName={siteName} user={user} isAdmin={admin} approved>
      <h1>{selected === '__me__' ? 'My activity' : `Activity — ${selected}`}</h1>

      {canLookUpOthers ? (
        <label className="field-inline">
          Viewer
          <select className="select" value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="__me__">Me ({user.email})</option>
            {viewers
              .filter((v) => v.email !== user.email)
              .map((v) => (
                <option key={v.email} value={v.email}>
                  {v.email}
                </option>
              ))}
          </select>
        </label>
      ) : null}

      {error ? <p className="error-text">{error}</p> : null}
      {items === null && !error ? <p className="muted">Loading…</p> : null}

      {items ? (
        <div className="admin-rows">
          {items.map((p) => (
            <div key={p.videoId} className="admin-row card">
              <div className="row-main">
                <span className="row-title">{p.title || p.videoId}</span>
                <span className="row-meta muted">
                  {fmtDuration(p.seconds)} / {fmtDuration(p.duration)}
                  {p.duration ? ` (${Math.min(100, Math.round((p.seconds / p.duration) * 100))}%)` : ''}
                  {' · last watched '}
                  {fmtWhen(p.updatedAt)}
                </span>
              </div>
            </div>
          ))}
          {items.length === 0 ? <p className="empty">No watch history yet.</p> : null}
        </div>
      ) : null}
    </AppShell>
  );
}
