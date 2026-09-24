import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { isExplicitlyTrue, oneTrimmed } from '../../../lib/params';
import { allowRequest } from '../../../lib/ratelimit';
import { fetchCaptionVtt, getVideo, transcribeVideo } from '../../../lib/bunny';
import { parseVtt } from '../../../lib/captions';
import {
  clearTranscribePending,
  markTranscribePending,
  setVideoTranscript,
} from '../../../lib/captionsStore';
import { logAction } from '../../../lib/audit';
import { suggestedChapters } from '../../../lib/aiChapters';

// Queues bunny.net Transcribe AI for one video, and ingests the result.
//
//   POST { guid }               -> queue transcription (COSTS MONEY, below)
//   POST { guid, chapters }     -> ...and ask bunny for chapter suggestions
//   POST { guid, ingest }       -> pull the finished captions into Redis
//   POST { guid, suggestions }  -> read the suggested chapters back (writes
//                                  NOTHING — see lib/aiChapters.js)
//
// THIS ROUTE SPENDS MONEY. bunny bills $0.10 per minute of video, per
// language, so a 90-minute service is $9 — from one request. That is why it
// sits behind videos.manage, the same capability as deleting a video, and a
// tighter rate limit than anything else here.
//
// Transcription is ASYNCHRONOUS: queueing returns immediately and the captions
// appear minutes later. There is no webhook, so ingest is an explicit second
// action rather than a background poller — which keeps the cost and the timing
// visible to whoever pressed the button.
//
// Guard first, before req.method, so an unauthorised caller cannot learn the
// route's expected verb from a 405 — same ordering as the other admin routes.
const LANG = /^[A-Za-z0-9-]{2,12}$/;
const GUID = /^[0-9a-f-]{10,64}$/i;

async function handler(req, res) {
  const admin = await requireCapability(req, res, CAP.VIDEOS_MANAGE);
  if (!admin) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const guid = oneTrimmed(req.body?.guid);
  if (!guid || !GUID.test(guid)) return res.status(400).json({ error: 'Bad video id' });

  // Ingest only reads a file bunny already produced, so it is handled before
  // the rate limit that guards the paid half.
  if (isExplicitlyTrue(req.body?.ingest)) return ingest(res, admin, guid);

  // Reading suggestions back is cheaper still: one GET, no write anywhere, so
  // it sits in front of the money limiter too.
  if (isExplicitlyTrue(req.body?.suggestions)) return suggestions(res, guid);

  // Seconds as a NUMBER, not fable-video's '1 h' string. This repo's
  // allowRequest builds `${windowSeconds} s`, so a string here becomes the
  // unparseable window '1 h s', which throws — and the limiter fails OPEN,
  // so the endpoint that spends money would have had no rate limit at all.
  // 10/hour is deliberately tighter than upload's 20/hour: uploads are free.
  if (!(await allowRequest('transcribe', admin, 10, 3600))) {
    return res.status(429).json({ error: 'Too many transcription requests' });
  }

  // force=true re-runs transcription on a video that already has it — a
  // SECOND charge for the same minutes. It must be asked for in so many
  // words; a truthy value is not good enough for something that bills.
  const force = isExplicitlyTrue(req.body?.force);
  const sourceLanguage = oneTrimmed(req.body?.sourceLanguage);
  if (sourceLanguage && !LANG.test(sourceLanguage)) {
    return res.status(400).json({ error: 'Bad source language' });
  }

  // Chapter suggestions ride along with the same job — no extra per-minute
  // charge — but they are opt-in all the same: a video whose chapters an admin
  // has already typed has no use for a second opinion, and asking keeps 'what
  // did this job produce' a question with an answer.
  const chapters = isExplicitlyTrue(req.body?.chapters);

  try {
    await transcribeVideo(guid, { sourceLanguage, force, generateChapters: chapters });
  } catch {
    return res.status(502).json({ error: 'Could not queue transcription' });
  }

  // Recorded so the admin video list can collect the result without a second
  // click. Best-effort AT THE CALL SITE as well as inside the store: the money
  // has already been spent by this line, so a bookkeeping failure must not be
  // reported as a failed transcription — the admin would re-click and pay
  // twice for the same minutes.
  await markTranscribePending(guid).catch(() => {});

  await logAction(
    admin,
    force ? 'video.retranscribe' : 'video.transcribe',
    chapters ? `${guid} (with chapter suggestions)` : guid
  );
  return res.json({ ok: true, queued: true, chapters });
}

// Reads bunny's generated chapters back as a proposal. READ-ONLY on purpose:
// this never touches the `chapters` hash, so a transcription job can never
// replace a list an admin typed. The admin accepts by loading it into the
// textarea and saving through /api/admin/chapters — the same path a typed list
// takes. Not audit-logged, because nothing changed; the acceptance is what
// gets logged, by the chapters route, exactly as if the lines were typed.
async function suggestions(res, guid) {
  let video;
  try {
    video = await getVideo(guid);
  } catch {
    return res.status(404).json({ error: 'Video not found' });
  }

  const { chapters, ignored } = suggestedChapters(video, {
    durationSeconds: Number(video?.length) || 0,
  });
  return res.json({ ok: true, chapters, ignored });
}

// Pulls the finished captions off bunny's CDN and stores the parsed cues.
// Separate from queueing because at queue time there is nothing to fetch.
async function ingest(res, admin, guid) {
  let video;
  try {
    video = await getVideo(guid);
  } catch {
    return res.status(404).json({ error: 'Video not found' });
  }

  const languages = (video?.captions || [])
    .map((caption) => String(caption?.srclang || '').trim())
    .filter((lang) => LANG.test(lang));

  // Not an error: transcription is probably still running.
  if (!languages.length) return res.json({ ok: true, ready: false, cues: 0 });

  // One track is enough for the panel. Prefer English when bunny produced
  // several, otherwise take the first — deterministic beats whatever order
  // the API happened to return.
  const chosen = languages.includes('en') ? 'en' : languages[0];

  let vtt;
  try {
    vtt = await fetchCaptionVtt(guid, chosen);
  } catch {
    return res.status(502).json({ error: 'Could not fetch the captions' });
  }

  const cues = parseVtt(vtt);
  // The file exists but parsed to nothing — report it rather than silently
  // storing an empty transcript that looks like "never transcribed".
  if (!cues.length) {
    return res.json({ ok: true, ready: false, cues: 0, language: chosen });
  }

  const result = await setVideoTranscript(guid, cues);
  if (!result.ok) return res.status(502).json({ error: result.error });

  // Collected, one way or another — nothing left to wait for. Guarded for the
  // same reason: the transcript is already stored by this line.
  await clearTranscribePending(guid).catch(() => {});

  await logAction(admin, 'video.transcript_ingest', `${guid} (${chosen}, ${cues.length})`);
  return res.json({ ok: true, ready: true, cues: cues.length, language: chosen });
}

export default withMonitorApi(handler);
