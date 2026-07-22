import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AppShell from '../components/AppShell';
import { PlayIcon, SearchIcon, ChevronLeftIcon, ChevronRightIcon } from '../components/icons';
import { auth0 } from '../lib/auth0';
import { isAdmin, normalizeEmail } from '../lib/auth';
import { redis, k } from '../lib/redis';
import { isGeoAllowed } from '../lib/geo';

export async function getServerSideProps({ req, res }) {
  const session = await auth0.getSession(req, res);
  if (!session) {
    return { redirect: { destination: '/auth/login?returnTo=/', permanent: false } };
  }
  const email = normalizeEmail(session.user.email);
  const admin = isAdmin(email);
  const user = { email, name: session.user.name || email };
  if (!(await isGeoAllowed(req, { admin }))) {
    return { props: { user, isAdmin: admin, approved: false, geoBlocked: true } };
  }
  let approved = admin;
  if (!approved) {
    try {
      approved = (await redis().sismember(k('viewers'), email)) === 1;
    } catch {
      approved = false;
    }
  }
  if (approved) {
    redis()
      .hset(k('viewer:lastseen'), { [email]: new Date().toISOString() })
      .catch(() => {});
  }
  return {
    props: {
      user,
      isAdmin: admin,
      approved,
    },
  };
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

export default function Home({ user, isAdmin: admin, approved, geoBlocked }) {
  const [videos, setVideos] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [collections, setCollections] = useState([]);
  const [activeCollection, setActiveCollection] = useState('');
  const [progress, setProgress] = useState([]);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(queryInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [queryInput]);

  const loadVideos = useCallback(async () => {
    if (!approved) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (query) params.set('q', query);
      if (activeCollection) params.set('collection', activeCollection);
      const res = await fetch(`/api/videos?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setVideos(data.videos || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
    } catch {
      setError('Could not load the library. Try again in a moment.');
    } finally {
      setLoading(false);
    }
  }, [approved, page, query, activeCollection]);

  useEffect(() => {
    loadVideos();
  }, [loadVideos]);

  useEffect(() => {
    if (!approved) return;
    fetch('/api/collections')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setCollections(data?.collections || []))
      .catch(() => {});
    fetch('/api/progress')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setProgress(data?.items || []))
      .catch(() => {});
  }, [approved]);

  if (geoBlocked) {
    return (
      <AppShell user={user} isAdmin={admin} approved={false}>
        <div className="card card-pad notice">
          <h1>Not available in your region</h1>
          <p>
            You&apos;re signed in as <strong>{user.email}</strong>, but this portal isn&apos;t
            accessible from your current location.
          </p>
        </div>
      </AppShell>
    );
  }

  if (!approved) {
    return (
      <AppShell user={user} isAdmin={admin} approved={false}>
        <div className="card card-pad notice">
          <h1>Not approved yet</h1>
          <p>
            You&apos;re signed in as <strong>{user.email}</strong>, but this account isn&apos;t on
            the approved viewer list. If you were expecting access, contact the person who invited
            you.
          </p>
        </div>
      </AppShell>
    );
  }

  const progressMap = Object.fromEntries(progress.map((p) => [p.videoId, p]));
  const continueWatching = progress.filter(
    (p) => p.seconds > 10 && p.duration > 0 && p.seconds < p.duration * 0.95
  );
  const hasThumbs = videos.some((v) => v.thumbnail);

  return (
    <AppShell user={user} isAdmin={admin} approved>
      {continueWatching.length > 0 && !query && !activeCollection && page === 1 ? (
        <section className="cw-section">
          <h2 className="section-title">Continue watching</h2>
          <div className="cw-strip">
            {continueWatching.slice(0, 8).map((p) => (
              <Link key={p.videoId} href={`/watch/${p.videoId}`} className="cw-card card">
                <span className="cw-title">{p.title || 'Untitled'}</span>
                <span className="cw-meta">
                  {fmtDuration(p.seconds)} / {fmtDuration(p.duration)}
                </span>
                <span className="progress-line">
                  <span
                    style={{ width: `${Math.min(100, (p.seconds / p.duration) * 100)}%` }}
                  />
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <div className="library-head">
        <h1>Library {total ? <span className="muted">({total})</span> : null}</h1>
        <div className="searchbar">
          <SearchIcon />
          <input
            className="input"
            type="search"
            placeholder="Search videos…"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            aria-label="Search videos"
          />
        </div>
      </div>

      {collections.length > 0 ? (
        <div className="chips">
          <button
            type="button"
            className={activeCollection === '' ? 'chip active' : 'chip'}
            onClick={() => {
              setActiveCollection('');
              setPage(1);
            }}
          >
            All
          </button>
          {collections.map((c) => (
            <button
              key={c.guid}
              type="button"
              className={activeCollection === c.guid ? 'chip active' : 'chip'}
              onClick={() => {
                setActiveCollection(c.guid);
                setPage(1);
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <p className="error-text">{error}</p> : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {!loading && !error && videos.length === 0 ? (
        <p className="empty">No videos {query ? 'match your search' : 'here yet'}.</p>
      ) : null}

      {hasThumbs ? (
        <div className="grid">
          {videos.map((v) => {
            const p = progressMap[v.guid];
            return (
              <Link key={v.guid} href={`/watch/${v.guid}`} className="vcard card">
                <span className="vthumb">
                  {v.thumbnail ? (
                    <img src={v.thumbnail} alt="" loading="lazy" />
                  ) : (
                    <span className="vthumb-fallback">
                      <PlayIcon width={28} height={28} />
                    </span>
                  )}
                  <span className="play-overlay">
                    <PlayIcon width={22} height={22} />
                  </span>
                  {v.length ? <span className="duration-badge">{fmtDuration(v.length)}</span> : null}
                  {p && p.duration ? (
                    <span className="progress-line thumb-progress">
                      <span style={{ width: `${Math.min(100, (p.seconds / p.duration) * 100)}%` }} />
                    </span>
                  ) : null}
                </span>
                <span className="vtitle">{v.title}</span>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="list-rows">
          {videos.map((v) => (
            <Link key={v.guid} href={`/watch/${v.guid}`} className="row card">
              <PlayIcon />
              <span className="row-title">{v.title}</span>
              {v.length ? <span className="muted">{fmtDuration(v.length)}</span> : null}
            </Link>
          ))}
        </div>
      )}

      {pages > 1 ? (
        <div className="pager">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeftIcon /> Previous
          </button>
          <span className="muted">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRightIcon />
          </button>
        </div>
      ) : null}
    </AppShell>
  );
}
