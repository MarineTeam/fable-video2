// Collects transcriptions bunny has finished, for videos an admin queued and
// has not fetched by hand.
//
// SERVER ONLY — this talks to bunny and Redis. Which queued jobs to look at is
// decided by lib/transcribeQueue.js, which is pure; this module only does what
// that one decided.
//
// It runs on the admin video list, the same place the new-video push announce
// already rides, and is best-effort end to end: an admin loading their own
// video list must never see an error because a transcript could not be
// collected. Whatever fails is tried again next time, until the job ages out.
import { fetchCaptionVtt, getVideo } from './bunny';
import { parseVtt } from './captions';
import {
  clearTranscribePending,
  getTranscribePending,
  setVideoTranscript,
} from './captionsStore';
import { planCollection } from './transcribeQueue';

const LANG = /^[A-Za-z0-9-]{2,12}$/;

async function collectOne(guid) {
  const video = await getVideo(guid);
  const languages = (video?.captions || [])
    .map((caption) => String(caption?.srclang || '').trim())
    .filter((lang) => LANG.test(lang));
  if (!languages.length) return null;

  // The same deterministic choice the manual ingest makes: English when bunny
  // produced several, otherwise the first. Collecting a different track than
  // the button would have is a surprise nobody needs.
  const language = languages.includes('en') ? 'en' : languages[0];
  const cues = parseVtt(await fetchCaptionVtt(guid, language));
  if (!cues.length) return null;

  const result = await setVideoTranscript(guid, cues);
  // This store reports failure rather than throwing, so an unsuccessful write
  // has to be read — treating it as collected would clear the marker and lose
  // a transcript that was already paid for.
  if (!result?.ok) return null;
  return { language, cues: cues.length };
}

export async function collectFinishedTranscripts() {
  const pending = await getTranscribePending();
  if (!Object.keys(pending).length) return { collected: [], expired: [] };

  const { collect, expired } = planCollection(pending);
  // Dropped without another attempt: a job this old is not going to finish,
  // and retrying it costs two bunny calls on every admin page load forever.
  if (expired.length) await clearTranscribePending(expired);

  const collected = [];
  for (const guid of collect) {
    try {
      const result = await collectOne(guid);
      if (!result) continue; // still running — leave the marker for next time
      await clearTranscribePending(guid);
      collected.push({ guid, ...result });
    } catch {
      // Left pending on purpose: a transient bunny failure should be retried,
      // and a permanent one ages out on its own.
    }
  }
  return { collected, expired };
}
