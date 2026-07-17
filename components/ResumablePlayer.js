import { useEffect, useRef } from 'react';

// Wraps the tokenized Bunny embed with player.js so we can resume playback
// and report progress. Degrades gracefully: if the player.js protocol is
// unavailable, the video still plays — it just won't remember position.
export default function ResumablePlayer({ embedUrl, videoId, initialTime = 0, title = '' }) {
  const iframeRef = useRef(null);
  const lastSentRef = useRef(0);

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
          player.on('timeupdate', ({ seconds, duration }) => {
            const now = Date.now();
            if (!duration || now - lastSentRef.current < 5000) return;
            lastSentRef.current = now;
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
          player.off('ready');
        }
      } catch {}
    };
  }, [embedUrl, videoId, initialTime, title]);

  return (
    <div className="player-frame">
      <iframe
        ref={iframeRef}
        src={embedUrl}
        title={title || 'Video player'}
        allow="accelerometer; gyroscope; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
      />
    </div>
  );
}
