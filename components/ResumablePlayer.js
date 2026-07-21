import { useEffect, useRef } from 'react';

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
  title = '',
  shareId = '',
  watermark = false,
  watermarkLabel = '',
}) {
  const iframeRef = useRef(null);
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
        player.on('ready', () => {
          if (initialTime > 5) {
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
      try {
        if (player && player.off) {
          player.off('timeupdate');
          player.off('play');
          player.off('ended');
          player.off('ready');
        }
      } catch {}
    };
  }, [embedUrl, videoId, initialTime, title, shareId]);

  return (
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
  );
}
