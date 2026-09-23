import { pruneVideoFromGroups } from '../../../lib/groups';
import { withMonitorApi } from "../../../lib/monitor";
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import {
  listVideos,
  updateVideo,
  deleteVideo,
  thumbnailUrl,
} from '../../../lib/bunny';
import { redis, k } from '../../../lib/redis';
import { applyOrder } from '../../../lib/order';
import { loadSchedule, clearVideoWindow } from '../../../lib/scheduleStore';
import { loadAllChapters, clearVideoChapters } from '../../../lib/chaptersStore';
import { loadAllNotes, clearVideoNotes } from '../../../lib/notesStore';
import { clearVideoTranscript } from '../../../lib/captionsStore';
import { loadPublicVideoGuids, clearVideoPublic } from '../../../lib/publicVideosStore';
import { clearVideoRatingCounts, getRatingCounts } from '../../../lib/ratingsStore';
import { countsByVideo, countsFor, summarize } from '../../../lib/ratings';
import { announceNewVideos } from '../../../lib/push';
import { collectFinishedTranscripts } from '../../../lib/transcriptCollect';
import { logAction } from '../../../lib/audit';
import { getVideoModes, setVideoMode, clampWatermarkMode } from '../../../lib/watermark';

async function handler(req, res) {
  const admin = await requireCapability(req, res, req.method === 'GET' ? CAP.VIDEOS_READ : CAP.VIDEOS_MANAGE);
  if (!admin) return;
  const r = redis();

  if (req.method === 'GET') {
    try {
      const data = await listVideos({ page: 1, perPage: 100 });
      const items = data?.items || [];
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
    try {
      await deleteVideo(id);
      // Prune the deleted video from the saved order.
      try {
        const orderRaw = await r.get(k('order'));
        if (Array.isArray(orderRaw) && orderRaw.includes(id)) {
          await r.set(k('order'), orderRaw.filter((g) => g !== id));
        }
      } catch {}
      // And from the publish-window hash, same no-orphans contract.
      await clearVideoWindow(id);
      await clearVideoChapters(id);
      await clearVideoNotes(id);
      // Third per-video decoration, cleared with the other two — a transcript
      // that outlives its video is a row nothing will ever collect.
      await clearVideoTranscript(id);
      await clearVideoPublic(id);
      // A recycled bunny.net guid must not inherit another video's score.
      await clearVideoRatingCounts(id);
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
