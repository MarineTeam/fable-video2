import { useEffect, useRef, useState } from 'react';
import { formatTimestamp } from '../lib/chapters';
import { linkAtTime } from '../lib/timestampLink';
import TranscriptPanel from './TranscriptPanel';

function postShareEvent(shareId, payload) {
  fetch('/api/share-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: shareId, ...payload }),
  }).catch(() => {});
}

// Wraps the tokenized Bunny embed with player.js so we can resume playback
// and report progress. Degrades gracefully: if the player.js protocol is
// unavailable, the video still plays — it just won't remember position.
// When shareId is set (private share links only), also reports real
// playback signal — first play, furthest progress %, completion — instead
// of the per-viewer resume history used on regular watch pages.
export default function ResumablePlayer({
  embedUrl,
  videoId,
  initialTime = 0,
  // True when initialTime came from a ?t= in the address rather than from the
  // saved resume position. It changes the seek rule below: a resume under
  // five seconds is not worth restoring, but a link to 0:03 is exactly what
  // the viewer asked for.
  startExplicit = false,
  title = '',
  shareId = '',
  watermark = false,
  watermarkLabel = '',
  chapters = [],
  trackProgress = true,
  // OFF by default: pages/watch/public/[id].js renders this same player for
  // signed-out visitors, and /api/transcript/[id] requires an approved
  // viewer — so a public page would fire a request that can only 404 and
  // then tell the visitor the video is 'not transcribed', which is false.
  showTranscript = false,
}) {
  const iframeRef = useRef(null);
  // The player instance lives here so the chapter list below can seek it, and
  // `canSeek` gates that: until player.js has loaded and reported ready, the
  // chapters render as plain text rather than as buttons that would do
  // nothing. A broken player must never produce a broken-looking list.
  const playerRef = useRef(null);
  const [canSeek, setCanSeek] = useState(false);
  // Where playback is now, for the copy-link button.
  const [position, setPosition] = useState(0);
  const [copied, setCopied] = useState(false);
  const lastSentRef = useRef(0);
  const playedRef = useRef(false);
  const furthestRef = useRef(0);
  const completedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let player;
    (async () => {
      try {
        const mod = await import('player.js');
        const playerjs = mod.default && mod.default.Player ? mod.default : mod;
        if (cancelled || !iframeRef.current || !playerjs.Player) return;
        player = new playerjs.Player(iframeRef.current);
        playerRef.current = player;
        player.on('ready', () => {
          setCanSeek(true);
          if (startExplicit ? initialTime >= 0 : initialTime > 5) {
            try {
              player.setCurrentTime(initialTime);
            } catch {}
          }
          if (shareId) {
            player.on('play', () => {
              if (playedRef.current) return;
              playedRef.current = true;
              postShareEvent(shareId, { type: 'play' });
            });
            player.on('ended', () => {
              if (completedRef.current) return;
              completedRef.current = true;
              postShareEvent(shareId, { type: 'complete' });
            });
          }
          player.on('timeupdate', ({ seconds, duration }) => {
            // Tracked even when trackProgress is off: the copy-link button is
            // useful on the public watch page too, and this costs nothing.
            setPosition(Math.floor(seconds || 0));
            // The public watch page passes trackProgress={false}: an anonymous
            // visitor has no email to key history against, so reporting would
            // only fire 401s at a guarded endpoint.
            if (!trackProgress) return;
            const now = Date.now();
            if (!duration || now - lastSentRef.current < 5000) return;
            lastSentRef.current = now;
            if (shareId) {
              const percent = Math.floor((seconds / duration) * 100);
              if (percent > furthestRef.current) {
                furthestRef.current = percent;
                postShareEvent(shareId, { type: 'progress', percent });
              }
              return;
            }
            fetch('/api/progress', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                videoId,
                seconds: Math.floor(seconds),
                duration: Math.floor(duration),
                title,
              }),
            }).catch(() => {});
          });
        });
      } catch {
        // player.js unavailable — playback still works via the raw embed
      }
    })();
    return () => {
      cancelled = true;
      playerRef.current = null;
      setCanSeek(false);
      try {
        if (player && player.off) {
          player.off('timeupdate');
          player.off('play');
          player.off('ended');
          player.off('ready');
        }
      } catch {}
    };
  }, [embedUrl, videoId, initialTime, startExplicit, title, shareId, trackProgress]);

  // Copies the address of this moment. Uses the CURRENT page URL rather than
  // rebuilding one, so it works from the regular watch page, a share page and
  // the public page alike without this component knowing their shapes.
  async function copyMoment() {
    try {
      await navigator.clipboard.writeText(linkAtTime(window.location.href, position));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused (insecure context, or permission). Leaving the
      // button as it was beats pretending it worked.
    }
  }

  function seekTo(seconds) {
    const player = playerRef.current;
    if (!player) return;
    try {
      player.setCurrentTime(seconds);
      player.play();
    } catch {
      // A seek that fails leaves playback exactly as it was.
    }
  }

  return (
    <>
      <div className="player-frame">
      <iframe
        ref={iframeRef}
        src={embedUrl}
        title={title || 'Video player'}
        allow="accelerometer; gyroscope; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
      />
      {watermark && watermarkLabel ? (
        <div className="watermark-overlay" aria-hidden="true">
          <span>{watermarkLabel}</span>
        </div>
      ) : null}
      </div>
      {/* Only once player.js is talking to us: a button that copied 0:00 for
          every video would be worse than no button, and this matches how the
          chapter list already degrades. */}
      {canSeek ? (
        <div className="field-row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={copyMoment}>
            {copied ? 'Link copied' : `Copy link at ${formatTimestamp(position)}`}
          </button>
        </div>
      ) : null}
      {chapters.length > 0 ? (
        <div className="chapter-list card card-pad">
          <h2 className="section-title">Chapters</h2>
          <ol className="chapter-rows">
            {chapters.map((c) => (
              <li key={c.at} className="chapter-row">
                {canSeek ? (
                  <button type="button" className="chapter-link" onClick={() => seekTo(c.at)}>
                    <span className="chapter-at">{formatTimestamp(c.at)}</span>
                    <span className="chapter-label">{c.label}</span>
                  </button>
                ) : (
                  <span className="chapter-link chapter-static">
                    <span className="chapter-at">{formatTimestamp(c.at)}</span>
                    <span className="chapter-label">{c.label}</span>
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {showTranscript ? (
        <TranscriptPanel videoId={videoId} seekable={canSeek} onSeek={seekTo} />
      ) : null}
    </>
  );
}
