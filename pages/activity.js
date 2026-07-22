import { useEffect, useState } from 'react';
import AppShell from '../components/AppShell';
import { auth0 } from '../lib/auth0';
import { isAdmin, normalizeEmail } from '../lib/auth';
import { redis, k } from '../lib/redis';

// Server-side gate mirrors pages/index.js: approved viewer or admin only.
export async function getServerSideProps({ req, res }) {
  const session = await auth0.getSession(req, res);
  if (!session) {
    return { redirect: { destination: '/auth/login?returnTo=/activity', permanent: false } };
  }
  const email = normalizeEmail(session.user.email);
  const admin = isAdmin(email);
  let approved = admin;
  if (!approved) {
    try {
      approved = (await redis().sismember(k('viewers'), email)) === 1;
    } catch {
      approved = false;
    }
  }
  return {
    props: {
      user: { email, name: session.user.name || email },
      isAdmin: admin,
      approved,
    },
  };
}

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

export default function Activity({ user, isAdmin: admin, approved }) {
  const [viewers, setViewers] = useState([]);
  const [selected, setSelected] = useState('__me__');
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!admin) return;
    api('/api/admin/viewers')
      .then((d) => setViewers(d.viewers || []))
      .catch(() => {});
  }, [admin]);

  useEffect(() => {
    if (!approved) return;
    setItems(null);
    setError('');
    const path = selected === '__me__' ? '/api/progress' : `/api/admin/viewer-activity?email=${encodeURIComponent(selected)}`;
    api(path)
      .then((d) => setItems(d.items || []))
      .catch((err) => setError(err.message));
  }, [approved, selected]);

  if (!approved) {
    return (
      <AppShell user={user} isAdmin={admin} approved={false}>
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
    <AppShell user={user} isAdmin={admin} approved>
      <h1>{selected === '__me__' ? 'My activity' : `Activity — ${selected}`}</h1>

      {admin ? (
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
