import { pruneVideoFromGroups } from '../../../lib/groups';
import { withMonitorApi } from "../../../lib/monitor";
import { requireActor } from '../../../lib/guard';
import { SCOPED_REFUSAL, guidInScope, scopedDeleteProblem } from '../../../lib/staffScope';
import { isScoped, videoInScope } from '../../../lib/staffScopeRules';
import { CAP } from '../../../lib/capabilities';
import {
  updateVideo,
  deleteVideo,
  thumbnailUrl,
} from '../../../lib/bunny';
import { listAllVideos } from '../../../lib/videoLibrary';
import { redis, k } from '../../../lib/redis';
import { applyOrder } from '../../../lib/order';
import { loadSchedule } from '../../../lib/scheduleStore';
import { loadAllChapters } from '../../../lib/chaptersStore';
import { loadAllNotes } from '../../../lib/notesStore';
import { loadPublicVideoGuids } from '../../../lib/publicVideosStore';
import { getRatingCounts } from '../../../lib/ratingsStore';
import { forgetVideo } from '../../../lib/videoCleanup';
import { countsByVideo, countsFor, summarize } from '../../../lib/ratings';
import { announceNewVideos } from '../../../lib/push';
import { collectFinishedTranscripts } from '../../../lib/transcriptCollect';
import { logAction } from '../../../lib/audit';
import { getVideoModes, setVideoMode, clampWatermarkMode } from '../../../lib/watermark';

async function handler(req, res) {
  const actor = await requireActor(req, res, req.method === 'GET' ? CAP.VIDEOS_READ : CAP.VIDEOS_MANAGE);
  if (!actor) return;
  const admin = actor.email;
  // Group-scoped staff (lib/staffScopeRules.js) see and change only the
  // videos their groups grant, and none of the library-wide acts.
  const scoped = isScoped(actor);
  const r = redis();

  if (req.method === 'GET') {
    try {
      // The whole library, not bunny's newest 100 — a video past the first
      // page used to have no row here, so it could not be renamed, scheduled
      // or transcribed. See lib/videoLibrary.js.
      const { videos: library, truncated } = await listAllVideos();
      const items = scoped ? library.filter((v) => videoInScope(actor, v)) : library;
      // Announce freshly finished uploads (atomic once-only guard inside).
      await announceNewVideos(items).catch(() => {});
      // Best-effort, same contract: collect any transcription bunny has
      // finished since it was queued, so the admin does not have to remember a
      // second click minutes later. Bounded per request by
      // lib/transcribeQueue.js; failures are retried next load and age out.
      const { collected } = await collectFinishedTranscripts().catch(() => ({ collected: [] }));
      for (const item of collected) {
        await logAction(
          admin,
          'video.transcript_ingest',
          `${item.guid} (${item.language}, ${item.cues}, collected automatically)`
        ).catch(() => {});
      }
      const orderRaw = await r.get(k('order')).catch(() => null);
      const ordered = applyOrder(items, Array.isArray(orderRaw) ? orderRaw : []);
      const watermarkModes = await getVideoModes(ordered.map((v) => v.guid));
      // Served with the list, like watermark modes, so the Videos tab renders
      // publish-window badges without a second round trip.
      const schedule = await loadSchedule();
      // Same reasoning as the publish windows above: shipped with the list so
      // the Videos tab needs one fetch rather than two.
      const chapters = await loadAllChapters();
      const notes = await loadAllNotes();
      const publicGuids = await loadPublicVideoGuids();
      // Totals only — the counters hold no identity, so this cannot tell an
      // admin WHO rated anything. See lib/ratings.js.
      const ratings = countsByVideo(await getRatingCounts());
      return res.json({
        // True only for a library past lib/videoLibrary.js's bound; the tab
        // says so rather than presenting the list as complete.
        truncated,
        videos: ordered.map((v) => ({
          guid: v.guid,
          title: v.title,
          length: v.length || 0,
          status: v.status,
          encodeProgress: v.encodeProgress || 0,
          views: v.views || 0,
          collectionId: v.collectionId || '',
          dateUploaded: v.dateUploaded || null,
          thumbnail: thumbnailUrl(v),
          watermarkMode: watermarkModes[v.guid] || 'default',
          schedule: schedule[v.guid] || null,
          chapters: chapters[v.guid] || [],
          notes: notes[v.guid] || '',
          isPublic: publicGuids.has(v.guid),
          // null when nobody has voted, so the UI shows nothing rather than a
          // row of zeroes that reads like a bad score.
          rating: summarize(countsFor(ratings, v.guid)),
        })),
      });
    } catch {
      return res.status(502).json({ error: 'Video service unavailable' });
    }
  }

  if (req.method === 'PUT') {
    const { id, title, collectionId, watermarkMode } = req.body || {};
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'Bad id' });
    if (scoped) {
      // Collections are shared across groups: moving a video between them
      // changes who else can see it.
      if (collectionId !== undefined) return res.status(403).json({ error: SCOPED_REFUSAL });
      if (!(await guidInScope(actor, id))) return res.status(404).json({ error: 'Video not found' });
    }
    const fields = {};
    if (typeof title === 'string' && title.trim()) fields.title = title.trim().slice(0, 200);
    if (typeof collectionId === 'string') fields.collectionId = collectionId;
    const hasWatermark = watermarkMode !== undefined;
    if (!Object.keys(fields).length && !hasWatermark) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    try {
      if (Object.keys(fields).length) {
        await updateVideo(id, fields);
        if (fields.title) await logAction(admin, 'video.rename', `${id} → "${fields.title}"`);
        if ('collectionId' in fields) await logAction(admin, 'video.collection', id);
      }
      // Watermark mode is portal-only metadata, never sent to Bunny.
      if (hasWatermark) {
        const mode = await setVideoMode(id, clampWatermarkMode(watermarkMode));
        await logAction(admin, 'video.watermark', `${id} → ${mode}`);
      }
      return res.json({ ok: true });
    } catch {
      return res.status(502).json({ error: 'Update failed' });
    }
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'Bad id' });
    const refused = await scopedDeleteProblem(actor, id);
    if (refused) return res.status(refused.status).json({ error: refused.error });
    try {
      await deleteVideo(id);
      // Prune the deleted video from the saved order.
      try {
        const orderRaw = await r.get(k('order'));
        if (Array.isArray(orderRaw) && orderRaw.includes(id)) {
          await r.set(k('order'), orderRaw.filter((g) => g !== id));
        }
      } catch {}
      // Everything stored ABOUT the video — schedule, chapters, notes,
      // transcript, public flag, score, comments — in one shared list, so the
      // bulk delete forgets exactly the same things (lib/videoCleanup.js).
      await forgetVideo(id);
      // Nor stay granted to a group — a cancelled upload is deleted here, and
      // the upload may already have ticked it into groups.
      await pruneVideoFromGroups(id);
      await logAction(admin, 'video.delete', id);
      return res.json({ ok: true });
    } catch {
      return res.status(502).json({ error: 'Delete failed' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
