import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppShell from '../components/AppShell';
import {
  CheckIcon,
  CopyIcon,
  GripIcon,
  LinkIcon,
  MailIcon,
  PencilIcon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from '../components/icons';
import { auth0 } from '../lib/auth0';
import { isAdmin, normalizeEmail } from '../lib/auth';
import { PRESETS, COLOR_KEYS, applyTheme, validateTheme, THEME_STORAGE_KEY } from '../lib/theme';
import { rollupSharesByVideo } from '../lib/videoAnalytics';

// Server-side gate: non-admins are redirected before any admin UI is sent.
export async function getServerSideProps({ req, res }) {
  const session = await auth0.getSession(req, res);
  if (!session) {
    return { redirect: { destination: '/auth/login?returnTo=/admin', permanent: false } };
  }
  const email = normalizeEmail(session.user.email);
  if (!isAdmin(email)) {
    return { redirect: { destination: '/', permanent: false } };
  }
  return {
    props: {
      user: { email, name: session.user.name || email },
      mailOn: Boolean(process.env.RESEND_API_KEY),
      pushOn: Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
    },
  };
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

const isEncodingStatus = (v) => v.status >= 0 && v.status <= 3;
const isFailedStatus = (v) => v.status === 5 || v.status === 6;

const TABS = ['Videos', 'Viewers', 'Shares', 'Settings', 'Activity', 'Analytics'];

export default function Admin({ user, mailOn, pushOn }) {
  const [tab, setTab] = useState('Videos');
  const [videos, setVideos] = useState([]);
  const [collections, setCollections] = useState([]);
  const [viewers, setViewers] = useState([]);
  const [shares, setShares] = useState([]);
  const [loadError, setLoadError] = useState('');

  const loadVideos = useCallback(async () => {
    try {
      const data = await api('/api/admin/videos');
      setVideos(data.videos || []);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);
  const loadCollections = useCallback(async () => {
    try {
      setCollections((await api('/api/admin/collections')).collections || []);
    } catch {}
  }, []);
  const loadViewers = useCallback(async () => {
    try {
      setViewers((await api('/api/admin/viewers')).viewers || []);
    } catch {}
  }, []);
  const loadShares = useCallback(async () => {
    try {
      setShares((await api('/api/admin/shares')).shares || []);
    } catch {}
  }, []);

  useEffect(() => {
    loadVideos();
    loadCollections();
    loadViewers();
    loadShares();
  }, [loadVideos, loadCollections, loadViewers, loadShares]);

  // Auto-refresh encoding badges while anything is processing.
  useEffect(() => {
    if (!videos.some(isEncodingStatus)) return;
    const t = setInterval(loadVideos, 10000);
    return () => clearInterval(t);
  }, [videos, loadVideos]);

  // Per-video analytics panel is a pure rollup of the shares already loaded
  // for the Shares tab — no extra fetch, no new tracking.
  const shareRollup = useMemo(() => rollupSharesByVideo(shares), [shares]);

  return (
    <AppShell user={user} isAdmin approved wide>
      <h1>Admin</h1>
      {loadError ? <p className="error-text">{loadError}</p> : null}
      <div className="tabs" role="tablist">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? 'tab active' : 'tab'}
            onClick={() => setTab(name)}
          >
            {name}
            {name === 'Viewers' && viewers.length ? (
              <span className="tab-badge">{viewers.length}</span>
            ) : null}
            {name === 'Shares' && shares.length ? (
              <span className="tab-badge">{shares.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'Videos' ? (
        <VideosTab
          videos={videos}
          setVideos={setVideos}
          collections={collections}
          reloadVideos={loadVideos}
          reloadCollections={loadCollections}
          reloadShares={loadShares}
          mailOn={mailOn}
          shareRollup={shareRollup}
        />
      ) : null}
      {tab === 'Viewers' ? <ViewersTab viewers={viewers} reload={loadViewers} /> : null}
      {tab === 'Shares' ? <SharesTab shares={shares} reload={loadShares} mailOn={mailOn} /> : null}
      {tab === 'Settings' ? <SettingsTab pushOn={pushOn} /> : null}
      {tab === 'Activity' ? <ActivityTab /> : null}
      {tab === 'Analytics' ? <AnalyticsTab shareRollup={shareRollup} /> : null}
    </AppShell>
  );
}

// ---------------------------------------------------------------- Videos tab

function VideosTab({
  videos,
  setVideos,
  collections,
  reloadVideos,
  reloadCollections,
  reloadShares,
  mailOn,
  shareRollup,
}) {
  const [filter, setFilter] = useState('');
  const [uploads, setUploads] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [editing, setEditing] = useState(null); // { guid, title }
  const [shareFor, setShareFor] = useState(null); // guid
  const [copiedId, setCopiedId] = useState('');
  const [newCollection, setNewCollection] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCollection, setBulkCollection] = useState('');
  const [bulkVideoBusy, setBulkVideoBusy] = useState(false);
  const [bulkVideoResult, setBulkVideoResult] = useState(null);
  const [openAnalytics, setOpenAnalytics] = useState(new Set());
  const uploadRefs = useRef({}); // key -> { tusUpload, file, videoId }
  const fileInputRef = useRef(null);

  const patchUpload = (key, patch) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  async function startUpload(file, existingKey) {
    const key = existingKey || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const title = file.name.replace(/\.[^.]+$/, '');
    if (!existingKey) {
      setUploads((list) => [...list, { key, name: file.name, pct: 0, status: 'starting', error: '' }]);
    } else {
      patchUpload(key, { pct: 0, status: 'starting', error: '' });
    }
    try {
      const ticket = await api('/api/admin/upload', { method: 'POST', body: { title } });
      const tus = await import('tus-js-client');
      const upload = new tus.Upload(file, {
        endpoint: ticket.endpoint,
        headers: ticket.headers,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        metadata: { filetype: file.type, title },
        onError: (err) => patchUpload(key, { status: 'error', error: String(err?.message || err) }),
        onProgress: (sent, totalBytes) =>
          patchUpload(key, { status: 'uploading', pct: Math.round((sent / totalBytes) * 100) }),
        onSuccess: () => {
          patchUpload(key, { status: 'done', pct: 100 });
          setTimeout(reloadVideos, 1500);
        },
      });
      uploadRefs.current[key] = { tusUpload: upload, file, videoId: ticket.videoId };
      upload.start();
    } catch (err) {
      patchUpload(key, { status: 'error', error: err.message });
    }
    return key;
  }

  async function cancelUpload(key) {
    const ref = uploadRefs.current[key];
    try {
      ref?.tusUpload?.abort(true);
    } catch {}
    // A cancelled upload cleans up its half-created video.
    if (ref?.videoId) {
      try {
        await api(`/api/admin/videos?id=${encodeURIComponent(ref.videoId)}`, { method: 'DELETE' });
      } catch {}
    }
    patchUpload(key, { status: 'cancelled' });
    setTimeout(reloadVideos, 1000);
  }

  function retryUpload(key) {
    const ref = uploadRefs.current[key];
    if (!ref?.file) return;
    // Fresh ticket + fresh attempt (the old signature may have expired).
    startUpload(ref.file, key);
  }

  function onFiles(fileList) {
    [...fileList].forEach((file) => startUpload(file));
  }

  async function saveRename() {
    if (!editing) return;
    const { guid, title } = editing;
    setEditing(null);
    if (!title.trim()) return;
    try {
      await api('/api/admin/videos', { method: 'PUT', body: { id: guid, title: title.trim() } });
      reloadVideos();
    } catch {}
  }

  async function setCollection(guid, collectionId) {
    try {
      await api('/api/admin/videos', { method: 'PUT', body: { id: guid, collectionId } });
      reloadVideos();
    } catch {}
  }

  async function removeVideo(guid, title) {
    if (!window.confirm(`Delete "${title}"? This removes it from bunny.net permanently.`)) return;
    try {
      await api(`/api/admin/videos?id=${encodeURIComponent(guid)}`, { method: 'DELETE' });
      reloadVideos();
    } catch {}
  }

  function moveVideo(from, to) {
    if (from === to) return;
    const next = [...videos];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setVideos(next);
    api('/api/admin/order', { method: 'POST', body: { order: next.map((v) => v.guid) } }).catch(
      () => {}
    );
  }

  function toggleSelect(guid) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(guid)) next.delete(guid);
      else next.add(guid);
      return next;
    });
  }

  function clearSelect() {
    setSelected(new Set());
    setBulkOpen(false);
    setBulkVideoResult(null);
  }

  function toggleAnalytics(guid) {
    setOpenAnalytics((prev) => {
      const next = new Set(prev);
      if (next.has(guid)) next.delete(guid);
      else next.add(guid);
      return next;
    });
  }

  async function setVideoWatermark(guid, watermarkMode) {
    try {
      await api('/api/admin/videos', { method: 'PUT', body: { id: guid, watermarkMode } });
      reloadVideos();
    } catch {}
  }

  // Every id is processed independently server-side, same as bulk-share.
  async function bulkDeleteVideos() {
    if (
      !window.confirm(
        `Delete ${selected.size} video(s)? This removes them from bunny.net permanently.`
      )
    )
      return;
    setBulkVideoBusy(true);
    setBulkVideoResult(null);
    try {
      const data = await api('/api/admin/videos-bulk', {
        method: 'POST',
        body: { action: 'delete', ids: [...selected] },
      });
      setBulkVideoResult(data.results);
      reloadVideos();
      setSelected(new Set());
      setBulkOpen(false);
    } catch {
    } finally {
      setBulkVideoBusy(false);
    }
  }

  async function bulkAssignCollection() {
    setBulkVideoBusy(true);
    setBulkVideoResult(null);
    try {
      const data = await api('/api/admin/videos-bulk', {
        method: 'POST',
        body: { action: 'assign-collection', ids: [...selected], collectionId: bulkCollection },
      });
      setBulkVideoResult(data.results);
      reloadVideos();
    } catch {
    } finally {
      setBulkVideoBusy(false);
    }
  }

  async function copyText(text, id) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(''), 1500);
    } catch {}
  }

  async function addCollection(e) {
    e.preventDefault();
    const name = newCollection.trim();
    if (!name) return;
    setNewCollection('');
    try {
      await api('/api/admin/collections', { method: 'POST', body: { name } });
      reloadCollections();
    } catch {}
  }

  async function removeCollection(guid, name) {
    if (!window.confirm(`Delete collection "${name}"? Videos in it are kept.`)) return;
    try {
      await api(`/api/admin/collections?id=${encodeURIComponent(guid)}`, { method: 'DELETE' });
      reloadCollections();
      reloadVideos();
    } catch {}
  }

  const shown = filter
    ? videos.filter((v) => (v.title || '').toLowerCase().includes(filter.toLowerCase()))
    : videos;
  const dragEnabled = !filter;

  return (
    <div className="tab-body">
      <div
        className={dragOver ? 'upload-zone drag card' : 'upload-zone card'}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files);
        }}
      >
        <UploadIcon width={22} height={22} />
        <p>
          Drag &amp; drop video files here, or{' '}
          <button type="button" className="linklike" onClick={() => fileInputRef.current?.click()}>
            browse
          </button>
          . Files stream from your browser straight to bunny.net.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {uploads.length > 0 ? (
        <div className="upload-list">
          {uploads.map((u) => (
            <div key={u.key} className="upload-item card">
              <span className="upload-name">{u.name}</span>
              {u.status === 'uploading' || u.status === 'starting' ? (
                <>
                  <span className="progress-line">
                    <span style={{ width: `${u.pct}%` }} />
                  </span>
                  <span className="muted">{u.pct}%</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => cancelUpload(u.key)}>
                    <XIcon /> Cancel
                  </button>
                </>
              ) : null}
              {u.status === 'done' ? (
                <span className="badge badge-ok">
                  <CheckIcon /> Uploaded
                </span>
              ) : null}
              {u.status === 'cancelled' ? <span className="badge">Cancelled</span> : null}
              {u.status === 'error' ? (
                <>
                  <span className="badge badge-err" title={u.error}>
                    Failed
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => retryUpload(u.key)}>
                    Retry
                  </button>
                </>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="library-head">
        <h2 className="section-title">Library ({videos.length})</h2>
        <input
          className="input"
          type="search"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter videos"
        />
      </div>
      {!dragEnabled && videos.length > 1 ? (
        <p className="muted">Clear the filter to drag-reorder.</p>
      ) : null}

      {selected.size > 0 ? (
        <div className="bulk-toolbar card card-pad">
          <span>{selected.size} selected</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setBulkOpen((v) => !v)}>
            <LinkIcon /> Bulk share
          </button>
          <select
            className="select"
            value={bulkCollection}
            onChange={(e) => setBulkCollection(e.target.value)}
            aria-label="Bulk assign collection"
          >
            <option value="">No collection</option>
            {collections.map((c) => (
              <option key={c.guid} value={c.guid}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={bulkVideoBusy}
            onClick={bulkAssignCollection}
          >
            Assign collection
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm danger"
            disabled={bulkVideoBusy}
            onClick={bulkDeleteVideos}
          >
            <TrashIcon /> Delete {selected.size}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={clearSelect}>
            Clear
          </button>
        </div>
      ) : null}
      {bulkVideoResult ? (
        <ul className="bulk-share-result">
          {bulkVideoResult.map((r) => (
            <li key={r.id}>
              {r.id}: {r.ok ? 'done' : r.error || 'failed'}
            </li>
          ))}
        </ul>
      ) : null}
      {bulkOpen && selected.size > 0 ? (
        <BulkShareForm
          videoIds={[...selected]}
          mailOn={mailOn}
          onCreated={() => {
            reloadShares();
            clearSelect();
          }}
        />
      ) : null}

      <div className="admin-rows">
        {shown.map((v, i) => (
          <div
            key={v.guid}
            className="admin-row card"
            draggable={dragEnabled}
            onDragStart={() => setDragIndex(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragEnabled && dragIndex !== null) moveVideo(dragIndex, i);
              setDragIndex(null);
            }}
          >
            {dragEnabled ? (
              <span className="grip" title="Drag to reorder">
                <GripIcon />
              </span>
            ) : null}
            <input
              type="checkbox"
              checked={selected.has(v.guid)}
              onChange={() => toggleSelect(v.guid)}
              aria-label={`Select ${v.title}`}
            />
            {v.thumbnail ? (
              <img className="row-thumb" src={v.thumbnail} alt="" loading="lazy" />
            ) : (
              <span className="row-thumb row-thumb-empty" />
            )}
            <div className="row-main">
              {editing?.guid === v.guid ? (
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveRename();
                  }}
                >
                  <input
                    className="input"
                    value={editing.title}
                    autoFocus
                    onChange={(e) => setEditing({ guid: v.guid, title: e.target.value })}
                    onBlur={saveRename}
                  />
                </form>
              ) : (
                <span className="row-title">
                  {v.title}
                  <button
                    type="button"
                    className="btn-icon"
                    title="Rename"
                    onClick={() => setEditing({ guid: v.guid, title: v.title })}
                  >
                    <PencilIcon />
                  </button>
                </span>
              )}
              <span className="row-meta muted">
                {v.length ? `${fmtDuration(v.length)} · ` : ''}
                {v.views || 0} views
                {isEncodingStatus(v) ? (
                  <span className="badge badge-warn">Processing {v.encodeProgress || 0}%</span>
                ) : null}
                {isFailedStatus(v) ? <span className="badge badge-err">Failed</span> : null}
              </span>
            </div>
            <select
              className="select"
              value={v.collectionId || ''}
              onChange={(e) => setCollection(v.guid, e.target.value)}
              aria-label="Collection"
            >
              <option value="">No collection</option>
              {collections.map((c) => (
                <option key={c.guid} value={c.guid}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              className="select"
              value={v.watermarkMode || 'default'}
              onChange={(e) => setVideoWatermark(v.guid, e.target.value)}
              aria-label="Watermark"
              title="Overrides the global watermark default for this video (a per-share choice overrides this in turn)"
            >
              <option value="default">Watermark: default</option>
              <option value="always">Watermark: always</option>
              <option value="never">Watermark: never</option>
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShareFor(shareFor === v.guid ? null : v.guid)}
            >
              <LinkIcon /> Share
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleAnalytics(v.guid)}>
              Analytics
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm danger"
              onClick={() => removeVideo(v.guid, v.title)}
            >
              <TrashIcon />
            </button>
            {shareFor === v.guid ? (
              <ShareForm
                videoId={v.guid}
                mailOn={mailOn}
                onCreated={() => reloadShares()}
                copyText={copyText}
                copiedId={copiedId}
              />
            ) : null}
            {openAnalytics.has(v.guid) ? (
              <VideoAnalyticsPanel stats={shareRollup[v.guid]} />
            ) : null}
          </div>
        ))}
        {shown.length === 0 ? <p className="empty">No videos.</p> : null}
      </div>

      <div className="card card-pad collections-box">
        <h2 className="section-title">Collections</h2>
        <form className="inline-form" onSubmit={addCollection}>
          <input
            className="input"
            placeholder="New collection name"
            value={newCollection}
            onChange={(e) => setNewCollection(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm">
            Create
          </button>
        </form>
        <div className="chips">
          {collections.map((c) => (
            <span key={c.guid} className="chip">
              {c.name} ({c.videoCount})
              <button
                type="button"
                className="btn-icon"
                title="Delete collection"
                onClick={() => removeCollection(c.guid, c.name)}
              >
                <XIcon width={12} height={12} />
              </button>
            </span>
          ))}
          {collections.length === 0 ? <span className="muted">None yet.</span> : null}
        </div>
      </div>
    </div>
  );
}

// Collapsible rollup of existing per-share tracking for one video — reads
// only fields already stored (see lib/videoAnalytics.js), tracks nothing new.
function VideoAnalyticsPanel({ stats }) {
  if (!stats) {
    return (
      <div className="analytics-panel">
        <p className="muted">No shares yet for this video.</p>
      </div>
    );
  }
  return (
    <div className="analytics-panel">
      <div className="stat-cards mini">
        <div className="stat card card-pad">
          <span className="stat-num">{stats.shares}</span>
          <span className="stat-label">Shares</span>
        </div>
        <div className="stat card card-pad">
          <span className="stat-num">{stats.uniqueRecipients}</span>
          <span className="stat-label">Recipients</span>
        </div>
        <div className="stat card card-pad">
          <span className="stat-num">{stats.views}</span>
          <span className="stat-label">Views</span>
        </div>
        <div className="stat card card-pad">
          <span className="stat-num">{stats.started}</span>
          <span className="stat-label">Started</span>
        </div>
        <div className="stat card card-pad">
          <span className="stat-num">{stats.completed}</span>
          <span className="stat-label">Completed</span>
        </div>
        <div className="stat card card-pad">
          <span className="stat-num">{Math.round(stats.completionRate * 100)}%</span>
          <span className="stat-label">Completion rate</span>
        </div>
        <div className="stat card card-pad">
          <span className="stat-num">{stats.avgProgress}%</span>
          <span className="stat-label">Avg progress</span>
        </div>
      </div>
    </div>
  );
}

function ShareForm({ videoId, mailOn, onCreated, copyText, copiedId }) {
  const [email, setEmail] = useState('');
  const [hours, setHours] = useState(72);
  const [sendEmail, setSendEmail] = useState(false);
  const [watermark, setWatermark] = useState('default');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api('/api/admin/share', {
        method: 'POST',
        body: { videoId, email, hours: Number(hours), sendEmail, watermark },
      });
      setResult(data);
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="share-form" onSubmit={submit}>
      <input
        className="input"
        type="email"
        required
        placeholder="Recipient email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <label className="field-inline">
        Expires in
        <input
          className="input input-narrow"
          type="number"
          min={1}
          max={720}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
        />
        hours
      </label>
      <label className="field-inline">
        Watermark
        <select className="select" value={watermark} onChange={(e) => setWatermark(e.target.value)}>
          <option value="default">Default</option>
          <option value="always">Always</option>
          <option value="never">Never</option>
        </select>
      </label>
      {mailOn ? (
        <label className="field-inline">
          <input
            type="checkbox"
            checked={sendEmail}
            onChange={(e) => setSendEmail(e.target.checked)}
          />
          Email the link to the recipient
        </label>
      ) : null}
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
        {busy ? 'Creating…' : 'Create link'}
      </button>
      {error ? <span className="error-text">{error}</span> : null}
      {result ? (
        <span className="share-result">
          <code>{result.url}</code>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => copyText(result.url, result.id)}
          >
            {copiedId === result.id ? <CheckIcon /> : <CopyIcon />}
            {copiedId === result.id ? 'Copied' : 'Copy'}
          </button>
          {result.emailed ? (
            <span className="badge badge-ok">
              <MailIcon /> Emailed
            </span>
          ) : null}
        </span>
      ) : null}
    </form>
  );
}

function BulkShareForm({ videoIds, mailOn, onCreated }) {
  const [emailsText, setEmailsText] = useState('');
  const [hours, setHours] = useState(72);
  const [sendEmail, setSendEmail] = useState(false);
  const [watermark, setWatermark] = useState('default');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const emails = [...new Set(
    emailsText
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  )];
  const totalLinks = videoIds.length * emails.length;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const data = await api('/api/admin/bulk-share', {
        method: 'POST',
        body: { videoIds, emails, hours: Number(hours), sendEmail, watermark },
      });
      setResult(data);
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card card-pad bulk-share-form" onSubmit={submit}>
      <label className="field-block">
        Recipients (one per line, or comma-separated)
        <textarea
          className="input"
          rows={3}
          required
          placeholder={'alice@example.com\nbob@example.com'}
          value={emailsText}
          onChange={(e) => setEmailsText(e.target.value)}
        />
      </label>
      <div className="field-row">
        <label className="field-inline">
          Expires in
          <input
            className="input input-narrow"
            type="number"
            min={1}
            max={720}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          hours
        </label>
        <label className="field-inline">
          Watermark
          <select className="select" value={watermark} onChange={(e) => setWatermark(e.target.value)}>
            <option value="default">Default</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </label>
        {mailOn ? (
          <label className="field-inline">
            <input
              type="checkbox"
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
            />
            Email each recipient their links
          </label>
        ) : null}
      </div>
      <p className="muted">
        {videoIds.length} video{videoIds.length === 1 ? '' : 's'} × {emails.length} recipient
        {emails.length === 1 ? '' : 's'} = {totalLinks} link{totalLinks === 1 ? '' : 's'}
      </p>
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || totalLinks === 0}>
        {busy ? 'Creating…' : `Create ${totalLinks || ''} link${totalLinks === 1 ? '' : 's'}`}
      </button>
      {error ? <span className="error-text">{error}</span> : null}
      {result ? (
        <ul className="bulk-share-result">
          {result.recipients.map((r) => (
            <li key={r.email}>
              {r.email}: {r.links} link{r.links === 1 ? '' : 's'}
              {mailOn && sendEmail ? (r.emailed ? ' · emailed' : ' · email failed') : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

// --------------------------------------------------------------- Viewers tab

function ViewersTab({ viewers, reload }) {
  const [email, setEmail] = useState('');
  const [bulk, setBulk] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [status, setStatus] = useState('');

  async function add(e) {
    e.preventDefault();
    const input = showBulk ? bulk : email;
    if (!input.trim()) return;
    setStatus('');
    try {
      const data = await api('/api/admin/viewers', { method: 'POST', body: { emails: input } });
      setStatus(
        `Added ${data.added} of ${data.submitted}${
          data.invalid?.length ? ` — invalid: ${data.invalid.join(', ')}` : ''
        }`
      );
      setEmail('');
      setBulk('');
      reload();
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function remove(target) {
    if (!window.confirm(`Remove ${target} from approved viewers?`)) return;
    try {
      await api('/api/admin/viewers', { method: 'DELETE', body: { email: target } });
      reload();
    } catch {}
  }

  return (
    <div className="tab-body">
      <div className="card card-pad">
        <h2 className="section-title">Approved viewers</h2>
        <form className="inline-form" onSubmit={add}>
          {showBulk ? (
            <textarea
              className="textarea"
              rows={4}
              placeholder="Paste emails separated by commas, spaces, or new lines"
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
            />
          ) : (
            <input
              className="input"
              type="email"
              placeholder="viewer@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
          <button type="submit" className="btn btn-primary btn-sm">
            Add
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowBulk((b) => !b)}
          >
            {showBulk ? 'Single' : 'Bulk add'}
          </button>
        </form>
        {status ? <p className="muted">{status}</p> : null}
      </div>

      <div className="admin-rows">
        {viewers.map((v) => (
          <div key={v.email} className="admin-row card">
            <div className="row-main">
              <span className="row-title">{v.email}</span>
              <span className="row-meta muted">Last seen: {fmtWhen(v.lastSeen)}</span>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm danger"
              onClick={() => remove(v.email)}
            >
              <TrashIcon /> Remove
            </button>
          </div>
        ))}
        {viewers.length === 0 ? <p className="empty">No approved viewers yet.</p> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Shares tab

function SharesTab({ shares, reload, mailOn }) {
  const [copiedId, setCopiedId] = useState('');
  const [copiedBundleId, setCopiedBundleId] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [bulkHours, setBulkHours] = useState(72);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelect() {
    setSelected(new Set());
    setBulkResult(null);
  }

  async function copy(id) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/s/${id}`);
      setCopiedId(id);
      setTimeout(() => setCopiedId(''), 1500);
    } catch {}
  }

  async function copyBundle(bundleId) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/b/${bundleId}`);
      setCopiedBundleId(bundleId);
      setTimeout(() => setCopiedBundleId(''), 1500);
    } catch {}
  }

  async function resend(id) {
    setStatus('');
    try {
      const data = await api('/api/admin/share', { method: 'POST', body: { resend: id } });
      setStatus(data.emailed ? 'Email re-sent.' : 'Email could not be sent.');
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function revoke(id) {
    if (!window.confirm('Revoke this link immediately?')) return;
    try {
      await api(`/api/admin/shares?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      reload();
    } catch {}
  }

  async function unrevoke(id) {
    setStatus('');
    try {
      await api('/api/admin/shares', { method: 'PUT', body: { id } });
      setStatus('Link un-revoked.');
      reload();
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function purge(id) {
    if (
      !window.confirm(
        'Permanently delete this revoked link? This cannot be undone — the link will no longer appear anywhere, even here.'
      )
    )
      return;
    try {
      await api(`/api/admin/shares?id=${encodeURIComponent(id)}&permanent=1`, { method: 'DELETE' });
      reload();
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function extend(id) {
    const input = window.prompt('Extend expiry by how many hours (from now)?', '72');
    if (input === null) return;
    const hours = Number(input);
    if (!Number.isFinite(hours) || hours <= 0) return;
    setStatus('');
    try {
      const data = await api('/api/admin/share', { method: 'POST', body: { extend: id, hours } });
      setStatus(`Extended to ${fmtWhen(data.expiresAt)}.`);
      reload();
    } catch (err) {
      setStatus(err.message);
    }
  }

  // Every id is processed independently server-side — one bad/revoked item
  // never aborts the rest of the batch, and the per-id outcome is reported.
  async function runBulk(action) {
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const data = await api('/api/admin/shares-bulk', {
        method: 'POST',
        body: {
          action,
          ids: [...selected],
          hours: action === 'extend' ? Number(bulkHours) : undefined,
        },
      });
      setBulkResult(data.results);
      reload();
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="tab-body">
      {status ? <p className="muted">{status}</p> : null}

      {shares.length > 0 ? (
        <p className="row-meta muted">
          <button
            type="button"
            className="linklike"
            onClick={() => setSelected(new Set(shares.map((s) => s.id)))}
          >
            Select all
          </button>
          {selected.size > 0 ? (
            <>
              {' · '}
              <button type="button" className="linklike" onClick={clearSelect}>
                Clear
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {selected.size > 0 ? (
        <div className="bulk-toolbar card card-pad">
          <span>{selected.size} selected</span>
          {mailOn ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={bulkBusy}
              onClick={() => runBulk('resend')}
            >
              <MailIcon /> Resend {selected.size}
            </button>
          ) : null}
          <label className="field-inline">
            <input
              className="input input-narrow"
              type="number"
              min={1}
              max={720}
              value={bulkHours}
              onChange={(e) => setBulkHours(e.target.value)}
            />
            hours
          </label>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={bulkBusy}
            onClick={() => runBulk('extend')}
          >
            Extend {selected.size}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm danger"
            disabled={bulkBusy}
            onClick={() => runBulk('revoke')}
          >
            <XIcon /> Revoke {selected.size}
          </button>
        </div>
      ) : null}
      {bulkResult ? (
        <ul className="bulk-share-result">
          {bulkResult.map((r) => (
            <li key={r.id}>
              {r.id.slice(0, 8)}…: {r.ok ? 'done' : r.error || 'failed'}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="admin-rows">
        {shares.map((s) => (
          <div key={s.id} className="admin-row card">
            <input
              type="checkbox"
              checked={selected.has(s.id)}
              onChange={() => toggleSelect(s.id)}
              aria-label={`Select share for ${s.email}`}
            />
            <div className="row-main">
              <span className="row-title">{s.videoTitle || s.videoId}</span>
              <span className="row-meta muted">
                For {s.email} · created {fmtWhen(s.createdAt)} · expires {fmtWhen(s.expiresAt)}
                {s.viewedAt
                  ? ` · ${s.views || 1} view${(s.views || 1) === 1 ? '' : 's'}, last ${fmtWhen(s.lastViewedAt || s.viewedAt)}`
                  : ''}
                {s.plays ? ` · played ${s.plays}×` : ''}
                {typeof s.furthestPercent === 'number' ? ` · watched ${s.furthestPercent}%` : ''}
                {s.bundleId ? (
                  <>
                    {' · '}
                    <a href={`/b/${s.bundleId}`} target="_blank" rel="noreferrer">
                      part of a bundle
                    </a>
                  </>
                ) : null}
              </span>
            </div>
            {s.status === 'revoked' ? (
              <span className="badge badge-err">Revoked</span>
            ) : s.status === 'expired' ? (
              <span className="badge badge-warn">Expired</span>
            ) : s.completedAt ? (
              <span className="badge badge-ok" title={`Completed ${fmtWhen(s.completedAt)}`}>
                Completed
              </span>
            ) : s.viewedAt ? (
              <span className="badge badge-ok" title={`First viewed ${fmtWhen(s.viewedAt)}`}>
                Viewed
              </span>
            ) : (
              <span className="badge">Not viewed</span>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(s.id)}>
              {copiedId === s.id ? <CheckIcon /> : <CopyIcon />}
              {copiedId === s.id ? 'Copied' : 'Copy'}
            </button>
            {s.bundleId ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title="This link's bundle groups every active link for this recipient"
                onClick={() => copyBundle(s.bundleId)}
              >
                {copiedBundleId === s.bundleId ? <CheckIcon /> : <LinkIcon />}
                {copiedBundleId === s.bundleId ? 'Bundle link copied' : 'Bundle link'}
              </button>
            ) : null}
            {mailOn && s.status !== 'revoked' ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => resend(s.id)}>
                <MailIcon /> Resend email
              </button>
            ) : null}
            {s.status !== 'revoked' ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => extend(s.id)}>
                Extend
              </button>
            ) : null}
            {s.status !== 'revoked' ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm danger"
                onClick={() => revoke(s.id)}
              >
                <XIcon /> Revoke
              </button>
            ) : null}
            {s.status === 'revoked' ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => unrevoke(s.id)}>
                Un-revoke
              </button>
            ) : null}
            {s.status === 'revoked' ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm danger"
                onClick={() => purge(s.id)}
              >
                <TrashIcon /> Delete permanently
              </button>
            ) : null}
          </div>
        ))}
        {shares.length === 0 ? <p className="empty">No active share links.</p> : null}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- Settings tab

function SettingsTab({ pushOn }) {
  const [homeCount, setHomeCount] = useState('');
  const [countStatus, setCountStatus] = useState('');
  const [theme, setTheme] = useState(null);
  const [custom, setCustom] = useState(null);
  const [paletteStatus, setPaletteStatus] = useState('');
  const [bTitle, setBTitle] = useState('');
  const [bBody, setBBody] = useState('');
  const [bStatus, setBStatus] = useState('');
  const [wmDefault, setWmDefault] = useState(false);
  const [wmExempt, setWmExempt] = useState([]);
  const [wmNewExempt, setWmNewExempt] = useState('');
  const [wmStatus, setWmStatus] = useState('');

  useEffect(() => {
    api('/api/admin/settings')
      .then((d) => {
        setHomeCount(String(d.homeCount));
        setWmDefault(Boolean(d.watermarkDefault));
        setWmExempt(d.watermarkExempt || []);
      })
      .catch(() => {});
    fetch('/api/theme')
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => {
        const valid = validateTheme(t);
        if (valid) {
          setTheme(valid);
          setCustom(valid.colors);
        }
      })
      .catch(() => {});
  }, []);

  async function saveCount(e) {
    e.preventDefault();
    setCountStatus('');
    try {
      const data = await api('/api/admin/settings', {
        method: 'POST',
        body: { homeCount: Number(homeCount) },
      });
      setHomeCount(String(data.homeCount));
      setCountStatus('Saved.');
    } catch (err) {
      setCountStatus(err.message);
    }
  }

  async function savePalette(next) {
    setPaletteStatus('');
    try {
      const saved = await api('/api/theme', { method: 'POST', body: next });
      setTheme(saved);
      setCustom(saved.colors);
      applyTheme(saved);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(saved));
      } catch {}
      setPaletteStatus(`Palette "${saved.name}" applied for all visitors.`);
    } catch (err) {
      setPaletteStatus(err.message);
    }
  }

  async function toggleWmDefault(on) {
    setWmStatus('');
    try {
      const data = await api('/api/admin/settings', { method: 'POST', body: { watermarkDefault: on } });
      setWmDefault(Boolean(data.watermarkDefault));
      setWmStatus('Saved.');
    } catch (err) {
      setWmStatus(err.message);
    }
  }

  async function addWmExempt(e) {
    e.preventDefault();
    const target = wmNewExempt.trim();
    if (!target) return;
    setWmStatus('');
    try {
      const data = await api('/api/admin/settings', {
        method: 'POST',
        body: { addWatermarkExempt: target },
      });
      setWmExempt(data.exempt || []);
      setWmNewExempt('');
    } catch (err) {
      setWmStatus(err.message);
    }
  }

  async function removeWmExempt(target) {
    try {
      await api('/api/admin/settings', { method: 'DELETE', body: { removeWatermarkExempt: target } });
      setWmExempt((list) => list.filter((e) => e !== target));
    } catch {}
  }

  async function broadcast(e) {
    e.preventDefault();
    setBStatus('Sending…');
    try {
      const data = await api('/api/admin/broadcast', {
        method: 'POST',
        body: { title: bTitle, body: bBody },
      });
      setBStatus(`Sent to ${data.sent} devices${data.pruned ? ` (${data.pruned} stale pruned)` : ''}.`);
      setBTitle('');
      setBBody('');
    } catch (err) {
      setBStatus(err.message);
    }
  }

  return (
    <div className="tab-body">
      <div className="card card-pad">
        <h2 className="section-title">Homepage</h2>
        <form className="inline-form" onSubmit={saveCount}>
          <label className="field-inline">
            Max videos on the homepage
            <input
              className="input input-narrow"
              type="number"
              min={1}
              max={200}
              value={homeCount}
              onChange={(e) => setHomeCount(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-primary btn-sm">
            Save
          </button>
          {countStatus ? <span className="muted">{countStatus}</span> : null}
        </form>
      </div>

      <div className="card card-pad">
        <h2 className="section-title">Color palette</h2>
        <p className="muted">Applied to all visitors, live — no redeploy.</p>
        <div className="palette-grid">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={theme?.name === p.name ? 'swatch active' : 'swatch'}
              style={{ background: p.colors.bg }}
              onClick={() => savePalette(p)}
              title={p.name}
            >
              <span className="swatch-dot" style={{ background: p.colors.accent }} />
              <span className="swatch-dot" style={{ background: p.colors.accent2 }} />
              <span className="swatch-name" style={{ color: p.colors.text }}>
                {p.name}
              </span>
            </button>
          ))}
        </div>
        {custom ? (
          <form
            className="hex-grid"
            onSubmit={(e) => {
              e.preventDefault();
              savePalette({ name: 'custom', colors: custom });
            }}
          >
            {COLOR_KEYS.map((key) => (
              <label key={key} className="hexfield">
                <span className="muted">{key}</span>
                <input
                  className="input"
                  value={custom[key]}
                  onChange={(e) => setCustom({ ...custom, [key]: e.target.value })}
                  pattern="#[0-9a-fA-F]{6}"
                />
              </label>
            ))}
            <button type="submit" className="btn btn-primary btn-sm">
              Apply custom palette
            </button>
          </form>
        ) : null}
        {paletteStatus ? <p className="muted">{paletteStatus}</p> : null}
      </div>

      {pushOn ? (
        <div className="card card-pad">
          <h2 className="section-title">Push broadcast</h2>
          <form className="stack-form" onSubmit={broadcast}>
            <input
              className="input"
              placeholder="Title"
              maxLength={80}
              required
              value={bTitle}
              onChange={(e) => setBTitle(e.target.value)}
            />
            <textarea
              className="textarea"
              rows={2}
              placeholder="Message (optional)"
              maxLength={200}
              value={bBody}
              onChange={(e) => setBBody(e.target.value)}
            />
            <button type="submit" className="btn btn-primary btn-sm">
              Send to all opted-in devices
            </button>
            {bStatus ? <span className="muted">{bStatus}</span> : null}
          </form>
        </div>
      ) : null}

      <div className="card card-pad">
        <h2 className="section-title">Viewer watermark</h2>
        <p className="muted">
          Overlays the viewer&apos;s email on playback for traceability. The global
          default set here can be overridden per video (Videos tab) or per share
          link (share forms) — the most specific choice wins, and an exempted
          viewer never sees a watermark regardless of any other setting.
        </p>
        <label className="field-inline">
          <input
            type="checkbox"
            checked={wmDefault}
            onChange={(e) => toggleWmDefault(e.target.checked)}
          />
          Watermark by default
        </label>
        <form className="inline-form" onSubmit={addWmExempt}>
          <input
            className="input"
            type="email"
            placeholder="Exempt viewer email"
            value={wmNewExempt}
            onChange={(e) => setWmNewExempt(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm">
            Exempt
          </button>
        </form>
        <div className="chips">
          {wmExempt.map((email) => (
            <span key={email} className="chip">
              {email}
              <button
                type="button"
                className="btn-icon"
                title="Remove exemption"
                onClick={() => removeWmExempt(email)}
              >
                <XIcon width={12} height={12} />
              </button>
            </span>
          ))}
          {wmExempt.length === 0 ? <span className="muted">No exemptions.</span> : null}
        </div>
        {wmStatus ? <p className="muted">{wmStatus}</p> : null}
      </div>

      <div className="card card-pad">
        <h2 className="section-title">Content protection</h2>
        <p className="muted">
          Every play uses a signed, time-limited bunny.net embed token generated fresh per request —
          there is no permanent public URL. Thumbnails are CDN token-signed. For full lockdown,
          enable <strong>Block Direct URL File Access</strong> on the library&apos;s Security tab in
          bunny.net, and keep Auth0 sign-ups disabled so nobody can self-register as an approved
          email.
        </p>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- Activity tab

function ActivityTab() {
  const [actions, setActions] = useState(null);

  useEffect(() => {
    api('/api/admin/audit')
      .then((d) => setActions(d.actions || []))
      .catch(() => setActions([]));
  }, []);

  if (actions === null) return <p className="muted">Loading…</p>;
  return (
    <div className="tab-body">
      <div className="admin-rows">
        {actions.map((a, i) => (
          <div key={i} className="admin-row card audit-row">
            <div className="row-main">
              <span className="row-title">
                {a.action} {a.detail ? <span className="muted">— {a.detail}</span> : null}
              </span>
              <span className="row-meta muted">
                {a.actor} · {fmtWhen(a.at)}
              </span>
            </div>
          </div>
        ))}
        {actions.length === 0 ? <p className="empty">No recorded actions yet.</p> : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- Analytics tab

function AnalyticsTab({ shareRollup }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/admin/analytics')
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const max = Math.max(1, ...data.chart.map((d) => d.views));
  const sharePerformance = Object.entries(shareRollup || {})
    .map(([videoId, stats]) => ({ videoId, ...stats }))
    .sort((a, b) => b.shares - a.shares || b.views - a.views);
  return (
    <div className="tab-body">
      <div className="stat-cards">
        <div className="stat card card-pad">
          <span className="stat-num">{data.totalViews}</span>
          <span className="stat-label">Total views</span>
        </div>
        <div className="stat card card-pad">
          <span className="stat-num">{data.views30}</span>
          <span className="stat-label">Views (30 days)</span>
        </div>
        <div className="stat card card-pad">
          <span className="stat-num">{data.watchHours}</span>
          <span className="stat-label">Watch hours (30 days)</span>
        </div>
        <div className="stat card card-pad">
          <span className="stat-num">{data.videoCount}</span>
          <span className="stat-label">Videos</span>
        </div>
      </div>

      <div className="card card-pad">
        <h2 className="section-title">Views — last 30 days</h2>
        <div className="barchart">
          {data.chart.map((d) => (
            <span
              key={d.date}
              className="bar"
              style={{ height: `${(d.views / max) * 100}%` }}
              title={`${d.date}: ${d.views} views`}
            />
          ))}
        </div>
      </div>

      <div className="card card-pad">
        <h2 className="section-title">Most watched</h2>
        {data.top.map((t) => (
          <div key={t.guid} className="top-row">
            <span>{t.title}</span>
            <span className="muted">{t.views} views</span>
          </div>
        ))}
        {data.top.length === 0 ? <p className="empty">No stats yet.</p> : null}
      </div>

      <div className="card card-pad">
        <h2 className="section-title">Share performance by video</h2>
        <p className="muted">
          Rolled up from existing share tracking — reads no new data, adds no new
          tracking. Sorted by shares.
        </p>
        {sharePerformance.map((v) => (
          <div key={v.videoId} className="top-row">
            <span>{v.videoTitle}</span>
            <span className="muted">
              {v.shares} share{v.shares === 1 ? '' : 's'} · {v.uniqueRecipients} recipient
              {v.uniqueRecipients === 1 ? '' : 's'} · {v.views} view{v.views === 1 ? '' : 's'} ·{' '}
              {v.started} started · {v.completed} completed ({Math.round(v.completionRate * 100)}%) ·{' '}
              {v.avgProgress}% avg progress
            </span>
          </div>
        ))}
        {sharePerformance.length === 0 ? <p className="empty">No shares yet.</p> : null}
      </div>
    </div>
  );
}
