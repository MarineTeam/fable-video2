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
  setTranscriptLanguage,
  setTranscriptLanguages,
  setVideoTranscript,
} from './captionsStore';
import { planCollection } from './transcribeQueue';

const LANG = /^[A-Za-z0-9-]{2,12}$/;

// Stores EVERY track bunny produced, not one: translation is billed per
// language, so a portal that paid for Spanish and got only English back has
// paid for nothing. The default track — English when present, otherwise the
// first — goes in the main hash and is what a viewer sees before choosing.
async function collectOne(guid) {
  const video = await getVideo(guid);
  const languages = (video?.captions || [])
    .map((caption) => String(caption?.srclang || '').trim().toLowerCase())
    .filter((lang) => LANG.test(lang));
  if (!languages.length) return null;

  const language = languages.includes('en') ? 'en' : languages[0];
  const cues = parseVtt(await fetchCaptionVtt(guid, language));
  // Nothing is stored until the DEFAULT track parses. Storing translations
  // around an absent default would leave a video whose transcript panel has a
  // language picker and no transcript under it.
  if (!cues.length) return null;

  const result = await setVideoTranscript(guid, cues);
  // This store reports failure rather than throwing, so an unsuccessful write
  // has to be read — treating it as collected would clear the marker and lose
  // a transcript that was already paid for.
  if (!result?.ok) return null;

  const stored = [language];
  for (const code of languages) {
    if (code === language) continue;
    try {
      const extra = parseVtt(await fetchCaptionVtt(guid, code));
      if (!extra.length) continue;
      const saved = await setTranscriptLanguage(guid, code, extra);
      if (saved?.ok) stored.push(code);
    } catch {
      // One unreadable translation must not cost the others, or the default.
    }
  }
  await setTranscriptLanguages(guid, language, stored);

  return { language, cues: cues.length, languages: stored };
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
