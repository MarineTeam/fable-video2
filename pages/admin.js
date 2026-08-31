import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppShell from '../components/AppShell';
import EmailTagInput from '../components/EmailTagInput';
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
import { trustedEmail } from '../lib/auth';
import { resolveActor } from '../lib/guard';
import { CAP } from '../lib/capabilities';
import { PRESETS, COLOR_KEYS, applyTheme, validateTheme, THEME_STORAGE_KEY } from '../lib/theme';
import { rollupSharesByVideo } from '../lib/videoAnalytics';
import { windowState } from '../lib/schedule';
import { isGeoAllowed } from '../lib/geo';
import { withMonitorPage } from '../lib/monitor';
import { resetMonitorCalls } from '../lib/monitorClient';

// Server-side gate: non-admins are redirected before any admin UI is sent.
async function gssp({ req, res }) {
  const session = await auth0.getSession(req, res);
  if (!session) {
    return { redirect: { destination: '/auth/login?returnTo=/admin', permanent: false } };
  }
  // Unverified sessions are not signed in as far as access is concerned; '/'
  // explains why rather than looping through login.
  const email = trustedEmail(session.user);
  if (!email) {
    return { redirect: { destination: '/', permanent: false } };
  }
  // The admin area is open to owners (ADMIN_EMAILS) and to anyone holding at
  // least one capability. Which tabs they see is filtered from the same set
  // below — that filtering is a convenience, never the gate: every route
  // re-checks the capability server-side on each call.
  const actor = await resolveActor(email);
  if (!actor.staff) {
    return { redirect: { destination: '/', permanent: false } };
  }
  if (!(await isGeoAllowed(req, { admin: true, email }))) {
    return { redirect: { destination: '/', permanent: false } };
  }
  return {
    props: {
      user: { email, name: session.user.name || email },
      mailOn: Boolean(process.env.RESEND_API_KEY),
      pushOn: Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
      owner: actor.owner,
      capabilities: actor.capabilities,
    },
  };
}

export const getServerSideProps = withMonitorPage(gssp);

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

// Tab -> the capabilities that make it worth showing (any one is enough).
// Purely presentational: the server-side guard on each route is the actual
// access decision, so a hidden tab is a tidier UI, not a security boundary.
const TAB_CAPS = {
  Videos: [CAP.VIDEOS_READ, CAP.VIDEOS_MANAGE, CAP.VIDEOS_UPLOAD],
  Viewers: [CAP.VIEWERS_READ, CAP.VIEWERS_MANAGE],
  Shares: [CAP.SHARES_READ, CAP.SHARES_MANAGE],
  Groups: [CAP.GROUPS_MANAGE],
  Roles: [CAP.ROLES_MANAGE],
  Settings: [CAP.SETTINGS_MANAGE],
  Activity: [CAP.AUDIT_READ],
  Analytics: [CAP.ANALYTICS_READ],
};
const TAB_ORDER = ['Videos', 'Viewers', 'Groups', 'Roles', 'Shares', 'Settings', 'Activity', 'Analytics'];

export default function Admin({ user, mailOn, pushOn, owner, capabilities }) {
  const caps = useMemo(() => new Set(capabilities || []), [capabilities]);
  const can = useCallback((cap) => owner || caps.has(cap), [owner, caps]);
  const TABS = useMemo(
    () => TAB_ORDER.filter((name) => owner || TAB_CAPS[name].some((c) => caps.has(c))),
    [owner, caps]
  );
  const [tab, setTab] = useState(TABS[0] || 'Videos');
  // The tabs below are pure React state, not routes — switching tabs fires
  // no navigation event, so the Query Monitor's per-view call log wouldn't
  // otherwise reset here. Without this, a tab that lazily fetches its own
  // data would show the previous tab's calls too, and a tab whose data
  // loaded once upfront would look frozen forever.
  useEffect(() => {
    resetMonitorCalls();
  }, [tab]);
  const [videos, setVideos] = useState([]);
  const [collections, setCollections] = useState([]);
  const [viewers, setViewers] = useState([]);
  const [shares, setShares] = useState([]);
  const [loadError, setLoadError] = useState('');

  // Each loader is skipped when the caller lacks the capability to read it —
  // otherwise a staff member with, say, only shares.read would greet every
  // page load with a 403 banner for data they were never meant to see.
  const loadVideos = useCallback(async () => {
    if (!can(CAP.VIDEOS_READ)) return;
    try {
      const data = await api('/api/admin/videos');
      setVideos(data.videos || []);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    }
  }, [can]);
  const loadCollections = useCallback(async () => {
    if (!can(CAP.VIDEOS_READ)) return;
    try {
      setCollections((await api('/api/admin/collections')).collections || []);
    } catch {}
  }, [can]);
  const loadViewers = useCallback(async () => {
    if (!can(CAP.VIEWERS_READ)) return;
    try {
      setViewers((await api('/api/admin/viewers')).viewers || []);
    } catch {}
  }, [can]);
  const loadShares = useCallback(async () => {
    if (!can(CAP.SHARES_READ)) return;
    try {
      setShares((await api('/api/admin/shares')).shares || []);
    } catch {}
  }, [can]);

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
          viewers={viewers}
          reloadVideos={loadVideos}
          reloadCollections={loadCollections}
          reloadShares={loadShares}
          mailOn={mailOn}
          shareRollup={shareRollup}
        />
      ) : null}
      {tab === 'Viewers' ? <ViewersTab viewers={viewers} reload={loadViewers} /> : null}
      {tab === 'Groups' ? (
        <GroupsTab viewers={viewers} videos={videos} collections={collections} />
      ) : null}
      {tab === 'Roles' ? <RolesTab viewers={viewers} owner={owner} /> : null}
      {tab === 'Shares' ? <SharesTab shares={shares} reload={loadShares} mailOn={mailOn} /> : null}
      {tab === 'Settings' ? <SettingsTab pushOn={pushOn} /> : null}
      {tab === 'Activity' ? <ActivityTab /> : null}
      {tab === 'Analytics' ? <AnalyticsTab shareRollup={shareRollup} /> : null}
    </AppShell>
  );
}

// ---------------------------------------------------------------- Videos tab

// A collection can hold more videos than one bulk-share action accepts —
// keep this in lockstep with MAX_VIDEOS in pages/api/admin/bulk-share.js.
const BULK_SHARE_MAX_VIDEOS = 50;

function VideosTab({
  videos,
  setVideos,
  collections,
  viewers,
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
  const [privateListFor, setPrivateListFor] = useState(null); // guid
  const [scheduleFor, setScheduleFor] = useState(null); // guid
  const [scheduleDraft, setScheduleDraft] = useState({ from: '', until: '' });
  const [scheduleError, setScheduleError] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [newCollection, setNewCollection] = useState('');
  const [collectionShareNotice, setCollectionShareNotice] = useState('');
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
    setCollectionShareNotice('');
  }

  function openSchedule(guid, current) {
    setScheduleError('');
    setScheduleFor(scheduleFor === guid ? null : guid);
    setScheduleDraft({
      from: current?.from ? current.from.slice(0, 16) : '',
      until: current?.until ? current.until.slice(0, 16) : '',
    });
  }

  function toggleAnalytics(guid) {
    setOpenAnalytics((prev) => {
      const next = new Set(prev);
      if (next.has(guid)) next.delete(guid);
      else next.add(guid);
      return next;
    });
  }

  async function saveSchedule(guid, from, until) {
    try {
      await api('/api/admin/schedule', { method: 'POST', body: { guid, from, until } });
      setScheduleFor(null);
      reloadVideos();
    } catch (err) {
      setScheduleError(err.message);
    }
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

  // Reuses the exact same bulk-share machinery as selecting videos by hand:
  // populate the multi-select with every video in the collection and open
  // the same BulkShareForm used by the toolbar above.
  function shareCollection(guid) {
    const ids = videos.filter((v) => v.collectionId === guid).map((v) => v.guid);
    if (!ids.length) return;
    setCollectionShareNotice(
      ids.length > BULK_SHARE_MAX_VIDEOS
        ? `Collection has ${ids.length} videos — only the first ${BULK_SHARE_MAX_VIDEOS} were selected.`
        : ''
    );
    setSelected(new Set(ids.slice(0, BULK_SHARE_MAX_VIDEOS)));
    setBulkOpen(true);
    setBulkVideoResult(null);
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
          viewers={viewers}
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
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPrivateListFor(privateListFor === v.guid ? null : v.guid)}
            >
              Private list
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => openSchedule(v.guid, v.schedule)}
              title="Hide this video until a date, after a date, or both"
            >
              Schedule
              {windowState(v.schedule) === 'scheduled' ? (
                <span className="badge badge-warn">Scheduled</span>
              ) : null}
              {windowState(v.schedule) === 'expired' ? (
                <span className="badge badge-err">Expired</span>
              ) : null}
              {windowState(v.schedule) === 'live' ? (
                <span className="badge badge-ok">Windowed</span>
              ) : null}
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
                viewers={viewers}
                onCreated={() => reloadShares()}
                copyText={copyText}
                copiedId={copiedId}
              />
            ) : null}
            {privateListFor === v.guid ? (
              <PrivateListPanel
                videoId={v.guid}
                mailOn={mailOn}
                viewers={viewers}
                onChanged={() => reloadShares()}
              />
            ) : null}
            {scheduleFor === v.guid ? (
              <div className="card card-pad">
                <h3 className="section-title">Publish window</h3>
                <p className="muted">
                  Leave both blank for always visible. Staff always see the video regardless, so
                  you can preview what you scheduled. This hides a video from viewers — it is a
                  publishing convenience, not an embargo.
                </p>
                <div className="field-row">
                  <label className="field-block">
                    Visible from
                    <input
                      type="datetime-local"
                      className="input"
                      value={scheduleDraft.from}
                      onChange={(e) => setScheduleDraft({ ...scheduleDraft, from: e.target.value })}
                    />
                  </label>
                  <label className="field-block">
                    Hidden again from
                    <input
                      type="datetime-local"
                      className="input"
                      value={scheduleDraft.until}
                      onChange={(e) => setScheduleDraft({ ...scheduleDraft, until: e.target.value })}
                    />
                  </label>
                </div>
                {scheduleError ? <p className="error-text">{scheduleError}</p> : null}
                <div className="field-row">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => saveSchedule(v.guid, scheduleDraft.from, scheduleDraft.until)}
                  >
                    Save window
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => saveSchedule(v.guid, '', '')}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setScheduleFor(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
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
                title="Share this whole collection"
                disabled={c.videoCount === 0}
                onClick={() => shareCollection(c.guid)}
              >
                <LinkIcon width={12} height={12} />
              </button>
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
        {collectionShareNotice ? <p className="muted">{collectionShareNotice}</p> : null}
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

// A tag is a label an admin can attach to approved viewers (Viewers tab).
// This lets any multi-email recipient form add every viewer with a given
// tag in one click, instead of typing each email by hand. Shared by
// ShareForm and PrivateListPanel; BulkShareForm keeps its own longer-lived
// inline version since it drives a raw textarea, not an array.
function AddViewersByTag({ viewers, onAdd }) {
  const [tagPick, setTagPick] = useState('');
  const loadRequests = useCallback(async () => {
    try {
      setRequests((await api('/api/admin/access-requests')).requests || []);
    } catch {
      // A staff member without viewers.read simply has no queue to show.
    }
  }, []);

  useEffect(() => {
    loadRequests();
    // The group picker is a convenience on approval; silently absent for
    // someone without groups.manage, same idiom as the tab loaders above.
    api('/api/admin/groups')
      .then((d) => setGroups(d.groups || []))
      .catch(() => {});
  }, [loadRequests]);

  async function approveRequest(target) {
    const picked = [...(approveGroups[target] || [])];
    try {
      await api('/api/admin/access-requests', {
        method: 'POST',
        body: { email: target, groupIds: picked },
      });
      setStatus(`Approved ${target}.`);
      loadRequests();
      reload();
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function dismissRequest(target) {
    if (!window.confirm(`Dismiss the access request from ${target}? They can ask again later.`)) {
      return;
    }
    try {
      await api('/api/admin/access-requests', { method: 'DELETE', body: { email: target } });
      loadRequests();
    } catch (err) {
      setStatus(err.message);
    }
  }

  function toggleApproveGroup(target, groupId) {
    setApproveGroups((prev) => {
      const next = new Set(prev[target] || []);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return { ...prev, [target]: next };
    });
  }

  const availableTags = useMemo(
    () => [...new Set((viewers || []).flatMap((v) => v.tags || []))].sort(),
    [viewers]
  );
  if (availableTags.length === 0) return null;

  function add() {
    if (!tagPick) return;
    const tagged = (viewers || []).filter((v) => (v.tags || []).includes(tagPick)).map((v) => v.email);
    if (tagged.length > 0) onAdd(tagged);
  }

  return (
    <div className="field-row">
      <label className="field-inline">
        Add viewers by tag
        <select className="select" value={tagPick} onChange={(e) => setTagPick(e.target.value)}>
          <option value="">Pick a tag…</option>
          {availableTags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!tagPick} onClick={add}>
        Add
      </button>
    </div>
  );
}

function ShareForm({ videoId, mailOn, viewers, onCreated, copyText, copiedId }) {
  const [emails, setEmails] = useState([]);
  const [hours, setHours] = useState(72);
  const [sendEmail, setSendEmail] = useState(false);
  const [watermark, setWatermark] = useState('default');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (emails.length === 0) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const data = await api('/api/admin/share', {
        method: 'POST',
        body: { videoId, emails, hours: Number(hours), sendEmail, watermark },
      });
      setResult(data);
      setEmails([]);
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="share-form" onSubmit={submit}>
      <AddViewersByTag
        viewers={viewers}
        onAdd={(tagged) => setEmails((prev) => [...new Set([...prev, ...tagged])])}
      />
      <EmailTagInput
        value={emails}
        onChange={setEmails}
        placeholder="Recipient email(s)"
        ariaLabel="Recipient email(s)"
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
          Email the link to each recipient
        </label>
      ) : null}
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || emails.length === 0}>
        {busy ? 'Creating…' : `Create ${emails.length || ''} link${emails.length === 1 ? '' : 's'}`}
      </button>
      {error ? <span className="error-text">{error}</span> : null}
      {result ? (
        <ul className="share-result-list">
          {result.created.map((r) => (
            <li key={r.id}>
              <span className="muted">{r.email}</span>
              <code>{r.url}</code>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(r.url, r.id)}>
                {copiedId === r.id ? <CheckIcon /> : <CopyIcon />}
                {copiedId === r.id ? 'Copied' : 'Copy'}
              </button>
              {r.emailed ? (
                <span className="badge badge-ok">
                  <MailIcon /> Emailed
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

// A persistent, editable invite for one video, layered on top of the same
// share primitive Share/Bulk Share use but tracked as its own list (see
// lib/privateList.js) — a share for the same video+email created through the
// regular Share/Bulk Share button is invisible to this list and untouched by
// it. Adding emails skips anyone the list already has a live invite for (no
// duplicate share, no re-sent email); removing revokes exactly the share the
// list itself created for that recipient, and inviting them again later is
// a fresh share.
function PrivateListPanel({ videoId, mailOn, viewers, onChanged }) {
  const [entries, setEntries] = useState([]);
  const [emails, setEmails] = useState([]);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const loadEntries = useCallback(async () => {
    try {
      const data = await api(`/api/admin/private-list?videoId=${encodeURIComponent(videoId)}`);
      setEntries(data.entries || []);
    } catch {}
  }, [videoId]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  async function submit(e) {
    e.preventDefault();
    if (emails.length === 0) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const data = await api('/api/admin/private-list', {
        method: 'POST',
        body: { videoId, emails, sendEmail: notify },
      });
      setResult(data);
      setEmails([]);
      await loadEntries();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(email) {
    setRemoving(email);
    try {
      await api(
        `/api/admin/private-list?videoId=${encodeURIComponent(videoId)}&email=${encodeURIComponent(email)}`,
        { method: 'DELETE' }
      );
      await loadEntries();
      onChanged();
    } catch {
    } finally {
      setRemoving('');
    }
  }

  return (
    <div className="private-list-panel">
      <div className="private-list-rows">
        {entries.map((s) => (
          <span key={s.id} className="chip">
            {s.email}
            <button
              type="button"
              className="btn-icon"
              title="Revoke access"
              disabled={removing === s.email}
              onClick={() => remove(s.email)}
            >
              <XIcon width={12} height={12} />
            </button>
          </span>
        ))}
        {entries.length === 0 ? <p className="muted">No one has private access yet.</p> : null}
      </div>
      <form className="private-list-form" onSubmit={submit}>
        <AddViewersByTag
          viewers={viewers}
          onAdd={(tagged) => setEmails((prev) => [...new Set([...prev, ...tagged])])}
        />
        <EmailTagInput
          value={emails}
          onChange={setEmails}
          placeholder="alice@example.com, bob@example.com"
          ariaLabel="Emails to add to the private list"
        />
        {mailOn ? (
          <label className="field-inline">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            Notify new people by email
          </label>
        ) : null}
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Adding…' : 'Add to list'}
        </button>
        {error ? <span className="error-text">{error}</span> : null}
      </form>
      {result ? (
        <p className="muted">
          {result.added.length > 0
            ? `Added ${result.added.length}${
                mailOn && notify ? ` (${result.added.filter((a) => a.emailed).length} emailed)` : ''
              }`
            : ''}
          {result.skipped.length > 0
            ? `${result.added.length > 0 ? ' · ' : ''}Already on the list: ${result.skipped.join(', ')}`
            : ''}
        </p>
      ) : null}
    </div>
  );
}

function BulkShareForm({ videoIds, mailOn, viewers, onCreated }) {
  const [emailsText, setEmailsText] = useState('');
  const [hours, setHours] = useState(72);
  const [sendEmail, setSendEmail] = useState(false);
  const [watermark, setWatermark] = useState('default');
  const [tagPick, setTagPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const availableTags = useMemo(
    () => [...new Set((viewers || []).flatMap((v) => v.tags || []))].sort(),
    [viewers]
  );

  const emails = [...new Set(
    emailsText
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  )];
  const totalLinks = videoIds.length * emails.length;

  function addByTag() {
    if (!tagPick) return;
    const tagged = (viewers || [])
      .filter((v) => (v.tags || []).includes(tagPick))
      .map((v) => v.email);
    if (!tagged.length) return;
    setEmailsText((prev) => {
      const existing = new Set(
        prev.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
      );
      const merged = [...existing, ...tagged];
      return merged.join('\n');
    });
  }

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
      {availableTags.length > 0 ? (
        <div className="field-row">
          <label className="field-inline">
            Add viewers by tag
            <select
              className="select"
              value={tagPick}
              onChange={(e) => setTagPick(e.target.value)}
            >
              <option value="">Pick a tag…</option>
              {availableTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!tagPick} onClick={addByTag}>
            Add
          </button>
        </div>
      ) : null}
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
  const [requests, setRequests] = useState([]);
  const [groups, setGroups] = useState([]);
  const [approveGroups, setApproveGroups] = useState({}); // email -> Set(groupId)
  const [email, setEmail] = useState('');
  const [bulk, setBulk] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [status, setStatus] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [bulkTag, setBulkTag] = useState('');
  const [bulkTagBusy, setBulkTagBusy] = useState(false);
  const [rowTagInputs, setRowTagInputs] = useState({}); // email -> draft tag text

  const availableTags = useMemo(
    () => [...new Set(viewers.flatMap((v) => v.tags || []))].sort(),
    [viewers]
  );
  const shown = tagFilter ? viewers.filter((v) => (v.tags || []).includes(tagFilter)) : viewers;

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

  function toggleSelect(target) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  }

  async function tagOne(target, tag) {
    const clean = tag.trim();
    if (!clean) return;
    try {
      await api('/api/admin/viewers-bulk', {
        method: 'POST',
        body: { action: 'add-tag', emails: [target], tag: clean },
      });
      setRowTagInputs((prev) => ({ ...prev, [target]: '' }));
      reload();
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function untagOne(target, tag) {
    try {
      await api('/api/admin/viewers-bulk', {
        method: 'POST',
        body: { action: 'remove-tag', emails: [target], tag },
      });
      reload();
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function runBulkTag(action) {
    const clean = bulkTag.trim();
    if (!clean || selected.size === 0) return;
    setBulkTagBusy(true);
    setStatus('');
    try {
      const data = await api('/api/admin/viewers-bulk', {
        method: 'POST',
        body: { action, emails: [...selected], tag: clean },
      });
      const okCount = data.results.filter((r) => r.ok).length;
      setStatus(`${action === 'add-tag' ? 'Tagged' : 'Untagged'} ${okCount}/${selected.size}.`);
      reload();
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBulkTagBusy(false);
    }
  }

  return (
    <div className="tab-body">
      {requests.length > 0 ? (
        <div className="card card-pad">
          <h2 className="section-title">
            Pending access requests <span className="tab-badge">{requests.length}</span>
          </h2>
          <div className="admin-rows">
            {requests.map((r) => (
              <div key={r.email} className="admin-row">
                <div className="row-main">
                  <span className="row-title">{r.email}</span>
                  <span className="row-meta muted">
                    Asked {fmtWhen(r.at)}
                    {r.note ? ` · “${r.note}”` : ''}
                  </span>
                  {groups.length > 0 ? (
                    <div className="chips">
                      {groups.map((g) => (
                        <label key={g.id} className="field-row">
                          <input
                            type="checkbox"
                            checked={(approveGroups[r.email] || new Set()).has(g.id)}
                            onChange={() => toggleApproveGroup(r.email, g.id)}
                          />
                          <span>{g.name}</span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="row-meta">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => approveRequest(r.email)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => dismissRequest(r.email)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

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

      {availableTags.length > 0 ? (
        <div className="field-row">
          <label className="field-inline">
            Filter by tag
            <select className="select" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
              <option value="">All viewers</option>
              {availableTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {selected.size > 0 ? (
        <div className="bulk-toolbar card card-pad">
          <span>{selected.size} selected</span>
          <input
            className="input input-narrow"
            placeholder="Tag name, e.g. Team A"
            value={bulkTag}
            onChange={(e) => setBulkTag(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={bulkTagBusy || !bulkTag.trim()}
            onClick={() => runBulkTag('add-tag')}
          >
            Tag selected
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={bulkTagBusy || !bulkTag.trim()}
            onClick={() => runBulkTag('remove-tag')}
          >
            Untag selected
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}

      <div className="admin-rows">
        {shown.map((v) => (
          <div key={v.email} className="admin-row card">
            <input
              type="checkbox"
              checked={selected.has(v.email)}
              onChange={() => toggleSelect(v.email)}
              aria-label={`Select ${v.email}`}
            />
            <div className="row-main">
              <span className="row-title">{v.email}</span>
              <span className="row-meta muted">Last seen: {fmtWhen(v.lastSeen)}</span>
              <div className="chips">
                {(v.tags || []).map((tag) => (
                  <span key={tag} className="chip">
                    {tag}
                    <button
                      type="button"
                      className="btn-icon"
                      title={`Remove tag "${tag}"`}
                      onClick={() => untagOne(v.email, tag)}
                    >
                      <XIcon width={12} height={12} />
                    </button>
                  </span>
                ))}
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    tagOne(v.email, rowTagInputs[v.email] || '');
                  }}
                >
                  <input
                    className="input input-narrow"
                    placeholder="+ tag"
                    value={rowTagInputs[v.email] || ''}
                    onChange={(e) =>
                      setRowTagInputs((prev) => ({ ...prev, [v.email]: e.target.value }))
                    }
                    aria-label={`Add tag to ${v.email}`}
                  />
                </form>
              </div>
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
        {shown.length === 0 ? <p className="empty">No approved viewers{tagFilter ? ` tagged "${tagFilter}"` : ' yet'}.</p> : null}
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
  const [cleanupBusy, setCleanupBusy] = useState(false);

  async function cleanup() {
    setCleanupBusy(true);
    setStatus('');
    try {
      const data = await api('/api/admin/cleanup', { method: 'POST' });
      setStatus(
        `Cleaned up: ${data.goneShares} expired share reference${data.goneShares === 1 ? '' : 's'}, ` +
          `${data.staleBundles} empty bundle${data.staleBundles === 1 ? '' : 's'}, ` +
          `${data.goneBundles} gone bundle reference${data.goneBundles === 1 ? '' : 's'}.`
      );
      reload();
    } catch (err) {
      setStatus(err.message);
    } finally {
      setCleanupBusy(false);
    }
  }

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
    if (action === 'delete') {
      const count = selected.size;
      if (
        !window.confirm(
          `Permanently delete ${count} revoked link${count === 1 ? '' : 's'}? This cannot be undone — non-revoked links in the selection are skipped and reported as failed.`
        )
      )
        return;
    }
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

      <p className="row-meta muted">
        <button type="button" className="linklike" disabled={cleanupBusy} onClick={cleanup}>
          {cleanupBusy ? 'Cleaning up…' : 'Clean up stale items'}
        </button>
      </p>

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
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={bulkBusy}
            onClick={() => runBulk('unrevoke')}
          >
            Un-revoke {selected.size}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm danger"
            disabled={bulkBusy}
            onClick={() => runBulk('delete')}
          >
            <TrashIcon /> Delete {selected.size}
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
                {s.viaPrivateList ? (
                  <>
                    {' · '}
                    <span title="Created via this video's Private list — revoking or deleting it here also removes it from that list.">
                      via Private list
                    </span>
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
  const [geoEnforcement, setGeoEnforcement] = useState(false);
  const [geoWhitelist, setGeoWhitelist] = useState([]);
  const [geoStatus, setGeoStatus] = useState('');
  const [adminGeoEnforcement, setAdminGeoEnforcement] = useState(false);
  const [adminGeoWhitelist, setAdminGeoWhitelist] = useState([]);
  const [adminGeoStatus, setAdminGeoStatus] = useState('');
  const [adminGeoBypassEmails, setAdminGeoBypassEmails] = useState([]);

  useEffect(() => {
    api('/api/admin/settings')
      .then((d) => {
        setHomeCount(String(d.homeCount));
        setWmDefault(Boolean(d.watermarkDefault));
        setWmExempt(d.watermarkExempt || []);
        setGeoEnforcement(Boolean(d.geoEnforcement));
        setGeoWhitelist(d.geoWhitelist || []);
        setAdminGeoEnforcement(Boolean(d.adminGeoEnforcement));
        setAdminGeoWhitelist(d.adminGeoWhitelist || []);
        setAdminGeoBypassEmails(d.adminGeoBypassEmails || []);
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

  async function toggleGeoEnforcement(on) {
    setGeoStatus('');
    try {
      const data = await api('/api/admin/settings', { method: 'POST', body: { geoEnforcement: on } });
      setGeoEnforcement(Boolean(data.geoEnforcement));
      setGeoStatus('Saved.');
    } catch (err) {
      setGeoStatus(err.message);
    }
  }

  async function toggleAdminGeoEnforcement(on) {
    setAdminGeoStatus('');
    try {
      const data = await api('/api/admin/settings', {
        method: 'POST',
        body: { adminGeoEnforcement: on },
      });
      setAdminGeoEnforcement(Boolean(data.adminGeoEnforcement));
      setAdminGeoStatus('Saved.');
    } catch (err) {
      setAdminGeoStatus(err.message);
    }
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
        <h2 className="section-title">Geo location whitelist — viewers</h2>
        <p className="muted">
          Restricts viewer access (and share/bundle links) to countries in{' '}
          <code>GEO_WHITELIST</code>, a Vercel environment variable — edit it there, then redeploy.
          Off by default.
        </p>
        <label className="field-inline">
          <input
            type="checkbox"
            checked={geoEnforcement}
            onChange={(e) => toggleGeoEnforcement(e.target.checked)}
          />
          Enforce viewer geo whitelist
        </label>
        <div className="chips">
          {geoWhitelist.map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
          {geoWhitelist.length === 0 ? (
            <span className="muted">No countries configured — enforcement is inert.</span>
          ) : null}
        </div>
        {geoStatus ? <p className="muted">{geoStatus}</p> : null}
      </div>

      <div className="card card-pad">
        <h2 className="section-title">Geo location whitelist — admins</h2>
        <p className="muted">
          Separate whitelist for admin access, from <code>ADMIN_GEO_WHITELIST</code> (also a Vercel
          environment variable). Kept independent from the viewer whitelist above so a traveling
          admin is never locked out by it — and if this whitelist itself ever locks an admin out,
          it can still be fixed directly in Vercel without needing this page. Off by default.
        </p>
        <label className="field-inline">
          <input
            type="checkbox"
            checked={adminGeoEnforcement}
            onChange={(e) => toggleAdminGeoEnforcement(e.target.checked)}
          />
          Enforce admin geo whitelist
        </label>
        <div className="chips">
          {adminGeoWhitelist.map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
          {adminGeoWhitelist.length === 0 ? (
            <span className="muted">No countries configured — enforcement is inert.</span>
          ) : null}
        </div>
        {adminGeoStatus ? <p className="muted">{adminGeoStatus}</p> : null}
        <p className="muted" style={{ marginTop: '0.75rem' }}>
          <code>ADMIN_GEO_BYPASS_EMAILS</code> (Vercel env var) lists admin emails that always skip
          this check, regardless of country or the toggle above — a standing safety net to arm
          before traveling, not an in-the-moment fix, since it needs a redeploy to take effect.
        </p>
        <div className="chips">
          {adminGeoBypassEmails.map((e) => (
            <span key={e} className="chip">
              {e}
            </span>
          ))}
          {adminGeoBypassEmails.length === 0 ? (
            <span className="muted">No bypass emails configured.</span>
          ) : null}
        </div>
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

// ----------------------------------------------------------------- Roles tab

// Checkbox grid over the capability catalog. `allowed` is the set the current
// actor may hand out — anything outside it renders disabled, so the
// no-escalation rule the API enforces is visible in the UI instead of only
// showing up as a 403.
function CapabilityPicker({ catalog, selected, onToggle, allowed }) {
  const groups = useMemo(() => {
    const out = new Map();
    for (const item of catalog) {
      if (!out.has(item.group)) out.set(item.group, []);
      out.get(item.group).push(item);
    }
    return [...out.entries()];
  }, [catalog]);

  return (
    <div className="field-block">
      {groups.map(([groupName, items]) => (
        <div key={groupName} className="field-block">
          <span className="muted">{groupName}</span>
          {items.map((item) => {
            const permitted = allowed.has(item.cap);
            return (
              <label key={item.cap} className="field-row" title={permitted ? '' : 'Outside your own capabilities'}>
                <input
                  type="checkbox"
                  checked={selected.has(item.cap)}
                  disabled={!permitted}
                  onChange={() => onToggle(item.cap)}
                />
                <span>{item.label}</span>
                <code className="muted">{item.cap}</code>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function RolesTab({ viewers, owner }) {
  const [roles, setRoles] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [catalog, setCatalog] = useState([]);
  const [actorCaps, setActorCaps] = useState([]);
  const [status, setStatus] = useState('');
  const [newName, setNewName] = useState('');
  const [newCaps, setNewCaps] = useState(new Set());
  const [editing, setEditing] = useState(null);
  const [assignEmail, setAssignEmail] = useState('');
  const [assignRoles, setAssignRoles] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api('/api/admin/roles');
      setRoles(data.roles || []);
      setAssignments(data.assignments || {});
      setCatalog(data.catalog || []);
      setActorCaps(data.actor?.capabilities || []);
    } catch (err) {
      setStatus(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const allowed = useMemo(() => new Set(actorCaps), [actorCaps]);
  const roleById = useMemo(() => Object.fromEntries(roles.map((r) => [r.id, r])), [roles]);

  function toggleIn(setter) {
    return (value) =>
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
  }

  async function create(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setStatus('');
    try {
      await api('/api/admin/roles', {
        method: 'POST',
        body: { name: newName, capabilities: [...newCaps] },
      });
      setNewName('');
      setNewCaps(new Set());
      load();
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    setStatus('');
    try {
      await api('/api/admin/roles', {
        method: 'PUT',
        body: { id: editing.id, name: editing.name, capabilities: [...editing.caps] },
      });
      setEditing(null);
      load();
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(role) {
    const holders = Object.entries(assignments).filter(([, ids]) => ids.includes(role.id)).length;
    const warning = holders
      ? `Delete the role "${role.name}"? ${holders} ${holders === 1 ? 'person' : 'people'} will lose it.`
      : `Delete the role "${role.name}"?`;
    if (!window.confirm(warning)) return;
    try {
      await api(`/api/admin/roles?id=${encodeURIComponent(role.id)}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function saveAssignment(e) {
    e.preventDefault();
    const email = assignEmail.trim();
    if (!email) return;
    setBusy(true);
    setStatus('');
    try {
      await api('/api/admin/roles', {
        method: 'PATCH',
        body: { email, roleIds: [...assignRoles] },
      });
      setStatus(`Saved roles for ${email}.`);
      setAssignEmail('');
      setAssignRoles(new Set());
      load();
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Loading an existing assignment into the editor when an email is picked.
  function pickAssignee(email) {
    setAssignEmail(email);
    setAssignRoles(new Set(assignments[email] || []));
  }

  return (
    <div className="tab-body">
      {status ? <p className="error-text">{status}</p> : null}

      <div className="card card-pad notice">
        <p>
          Roles grant capabilities to people who are <strong>not</strong> in <code>ADMIN_EMAILS</code>.
          Accounts in that env var are owners: they always hold every capability, cannot be demoted
          from here, and changing that list still needs an env edit and a redeploy.
          {owner ? null : ' You can only grant capabilities you hold yourself.'}
        </p>
      </div>

      <div className="card card-pad">
        <h2 className="section-title">Roles</h2>
        {roles.length === 0 ? <p className="empty">No roles yet.</p> : null}
        <div className="admin-rows">
          {roles.map((role) => {
            const holders = Object.entries(assignments)
              .filter(([, ids]) => ids.includes(role.id))
              .map(([email]) => email);
            const isEditing = editing?.id === role.id;
            return (
              <div key={role.id} className="admin-row">
                <div className="row-main">
                  {isEditing ? (
                    <>
                      <input
                        className="input"
                        value={editing.name}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        aria-label="Role name"
                      />
                      <CapabilityPicker
                        catalog={catalog}
                        selected={editing.caps}
                        allowed={allowed}
                        onToggle={(cap) =>
                          setEditing((prev) => {
                            const next = new Set(prev.caps);
                            if (next.has(cap)) next.delete(cap);
                            else next.add(cap);
                            return { ...prev, caps: next };
                          })
                        }
                      />
                      <div className="field-row">
                        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={saveEdit}>
                          Save
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="row-title">{role.name}</span>
                      <div className="chips">
                        {role.capabilities.length === 0 ? (
                          <span className="muted">no capabilities</span>
                        ) : (
                          role.capabilities.map((cap) => (
                            <span key={cap} className="chip">
                              {cap}
                            </span>
                          ))
                        )}
                      </div>
                      <span className="row-meta muted">
                        {holders.length ? `Held by ${holders.join(', ')}` : 'Held by nobody'}
                      </span>
                    </>
                  )}
                </div>
                {isEditing ? null : (
                  <div className="row-meta">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setEditing({ id: role.id, name: role.name, caps: new Set(role.capabilities) })}
                    >
                      Edit
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(role)}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="card card-pad">
        <h2 className="section-title">New role</h2>
        <form className="stack-form" onSubmit={create}>
          <input
            className="input"
            placeholder="Role name, e.g. Producer"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New role name"
          />
          <CapabilityPicker
            catalog={catalog}
            selected={newCaps}
            allowed={allowed}
            onToggle={toggleIn(setNewCaps)}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !newName.trim()}>
            Create role
          </button>
        </form>
      </div>

      <div className="card card-pad">
        <h2 className="section-title">Who holds what</h2>
        <form className="stack-form" onSubmit={saveAssignment}>
          <div className="field-row">
            <select
              className="select"
              value={assignEmail}
              onChange={(e) => pickAssignee(e.target.value)}
              aria-label="Person"
            >
              <option value="">Pick an approved viewer…</option>
              {viewers.map((v) => (
                <option key={v.email} value={v.email}>
                  {v.email}
                </option>
              ))}
            </select>
            <input
              className="input"
              placeholder="…or type any email"
              value={assignEmail}
              onChange={(e) => pickAssignee(e.target.value)}
              aria-label="Email to assign roles to"
            />
          </div>
          {roles.length === 0 ? (
            <p className="muted">Create a role first.</p>
          ) : (
            <div className="field-block">
              {roles.map((role) => (
                <label key={role.id} className="field-row">
                  <input
                    type="checkbox"
                    checked={assignRoles.has(role.id)}
                    onChange={() => toggleIn(setAssignRoles)(role.id)}
                  />
                  <span>{role.name}</span>
                  <code className="muted">{role.capabilities.join(', ') || 'no capabilities'}</code>
                </label>
              ))}
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy || !assignEmail.trim()}>
            Save roles for this person
          </button>
        </form>

        <div className="admin-rows">
          {Object.keys(assignments).length === 0 ? (
            <p className="empty">Nobody holds a role yet.</p>
          ) : (
            Object.entries(assignments)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([email, ids]) => (
                <div key={email} className="admin-row">
                  <div className="row-main">
                    <span className="row-title">{email}</span>
                    <div className="chips">
                      {ids.map((id) => (
                        <span key={id} className="chip">
                          {roleById[id]?.name || id}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="row-meta">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => pickAssignee(email)}>
                      Edit
                    </button>
                  </div>
                </div>
              ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Groups tab

function GroupsTab({ viewers, videos, collections }) {
  const [groups, setGroups] = useState([]);
  const [gating, setGating] = useState({ enabled: false, defaultAccess: 'open' });
  const [status, setStatus] = useState('');
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api('/api/admin/groups');
      setGroups(data.groups || []);
      setGating(data.gating || { enabled: false, defaultAccess: 'open' });
    } catch (err) {
      setStatus(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setStatus('');
    try {
      await api('/api/admin/groups', { method: 'POST', body: { name: newName } });
      setNewName('');
      load();
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    setStatus('');
    try {
      await api('/api/admin/groups', {
        method: 'PUT',
        body: {
          id: editing.id,
          name: editing.name,
          collectionIds: [...editing.collectionIds],
          videoIds: [...editing.videoIds],
        },
      });
      await api('/api/admin/groups', {
        method: 'PATCH',
        body: { action: 'set-members', groupId: editing.id, emails: [...editing.members] },
      });
      setEditing(null);
      load();
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(group) {
    if (!window.confirm(`Delete the group "${group.name}"? Its ${group.members.length} members keep their access.`)) {
      return;
    }
    try {
      await api(`/api/admin/groups?id=${encodeURIComponent(group.id)}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function setDefaultAccess(value) {
    setStatus('');
    try {
      const data = await api('/api/admin/groups', {
        method: 'PATCH',
        body: { action: 'set-default-access', defaultAccess: value },
      });
      setGating((prev) => ({ ...prev, defaultAccess: data.defaultAccess }));
    } catch (err) {
      setStatus(err.message);
    }
  }

  function toggleInEditing(field, value) {
    setEditing((prev) => {
      const next = new Set(prev[field]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, [field]: next };
    });
  }

  return (
    <div className="tab-body">
      {status ? <p className="error-text">{status}</p> : null}

      <div className="card card-pad notice">
        <h2 className="section-title">Content gating</h2>
        {gating.enabled ? (
          <>
            <p>
              <span className="badge badge-ok">On</span> Each group&apos;s scope is enforced.
              A viewer in one or more groups sees only the union of those groups&apos; collections
              and videos — on the homepage, in collection filters, and on direct
              <code> /watch/… </code> links alike. A group scoped to nothing grants nothing.
            </p>
            <div className="field-row">
              <span>Viewers in no group see:</span>
              <label className="field-row">
                <input
                  type="radio"
                  name="groupDefaultAccess"
                  checked={gating.defaultAccess !== 'closed'}
                  onChange={() => setDefaultAccess('open')}
                />
                <span>the whole library</span>
              </label>
              <label className="field-row">
                <input
                  type="radio"
                  name="groupDefaultAccess"
                  checked={gating.defaultAccess === 'closed'}
                  onChange={() => setDefaultAccess('closed')}
                />
                <span>nothing</span>
              </label>
            </div>
          </>
        ) : (
          <p>
            <span className="badge badge-warn">Off</span> Groups are membership bookkeeping only —
            scopes are recorded but change nobody&apos;s library. Set{' '}
            <code>GROUP_CONTENT_GATING=1</code> and redeploy to enforce them.
          </p>
        )}
        <p className="muted">
          Share links are never group-gated: a share is an explicit per-recipient grant for one
          video, and its recipients need not be approved viewers at all.
        </p>
      </div>

      <div className="card card-pad">
        <h2 className="section-title">Groups</h2>
        {groups.length === 0 ? <p className="empty">No groups yet.</p> : null}
        <div className="admin-rows">
          {groups.map((group) => {
            const isEditing = editing?.id === group.id;
            if (!isEditing) {
              return (
                <div key={group.id} className="admin-row">
                  <div className="row-main">
                    <span className="row-title">{group.name}</span>
                    <span className="row-meta muted">
                      {group.members.length} {group.members.length === 1 ? 'member' : 'members'} ·{' '}
                      {group.collectionIds.length} collections · {group.videoIds.length} videos
                    </span>
                    <div className="chips">
                      {group.members.slice(0, 8).map((email) => (
                        <span key={email} className="chip">
                          {email}
                        </span>
                      ))}
                      {group.members.length > 8 ? (
                        <span className="muted">+{group.members.length - 8} more</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="row-meta">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        setEditing({
                          id: group.id,
                          name: group.name,
                          members: new Set(group.members),
                          collectionIds: new Set(group.collectionIds),
                          videoIds: new Set(group.videoIds),
                        })
                      }
                    >
                      Edit
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(group)}>
                      Delete
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <div key={group.id} className="admin-row">
                <div className="row-main">
                  <input
                    className="input"
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    aria-label="Group name"
                  />

                  <div className="field-block">
                    <span className="muted">Members</span>
                    {viewers.length === 0 ? (
                      <p className="muted">No approved viewers yet.</p>
                    ) : (
                      viewers.map((v) => (
                        <label key={v.email} className="field-row">
                          <input
                            type="checkbox"
                            checked={editing.members.has(v.email)}
                            onChange={() => toggleInEditing('members', v.email)}
                          />
                          <span>{v.email}</span>
                        </label>
                      ))
                    )}
                  </div>

                  <div className="field-block">
                    <span className="muted">Collections this group can see</span>
                    {collections.length === 0 ? (
                      <p className="muted">No collections.</p>
                    ) : (
                      collections.map((c) => (
                        <label key={c.guid} className="field-row">
                          <input
                            type="checkbox"
                            checked={editing.collectionIds.has(c.guid)}
                            onChange={() => toggleInEditing('collectionIds', c.guid)}
                          />
                          <span>
                            {c.name} <span className="muted">({c.videoCount})</span>
                          </span>
                        </label>
                      ))
                    )}
                  </div>

                  <div className="field-block">
                    <span className="muted">Individual videos this group can see</span>
                    {videos.length === 0 ? (
                      <p className="muted">No videos.</p>
                    ) : (
                      videos.map((v) => (
                        <label key={v.guid} className="field-row">
                          <input
                            type="checkbox"
                            checked={editing.videoIds.has(v.guid)}
                            onChange={() => toggleInEditing('videoIds', v.guid)}
                          />
                          <span>{v.title || 'Untitled'}</span>
                        </label>
                      ))
                    )}
                  </div>

                  {gating.enabled &&
                  editing.collectionIds.size === 0 &&
                  editing.videoIds.size === 0 &&
                  editing.members.size > 0 ? (
                    <p className="error-text">
                      This group grants no content. With gating on, its members will see an empty
                      library.
                    </p>
                  ) : null}

                  <div className="field-row">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={saveEdit}>
                      Save
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card card-pad">
        <h2 className="section-title">New group</h2>
        <form className="inline-form" onSubmit={create}>
          <input
            className="input"
            placeholder="Group name, e.g. Deck crew"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New group name"
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !newName.trim()}>
            Create group
          </button>
        </form>
      </div>
    </div>
  );
}
