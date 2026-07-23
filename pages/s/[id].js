import ResumablePlayer from '../../components/ResumablePlayer';
import ShareShell from '../../components/ShareShell';
import { auth0 } from '../../lib/auth0';
import { isAdmin, normalizeEmail } from '../../lib/auth';
import { redis, k } from '../../lib/redis';
import { getVideo, signedEmbedUrl } from '../../lib/bunny';
import { isShareActive } from '../../lib/share';
import { resolveWatermark, isExempt, getVideoMode, getGlobalDefault } from '../../lib/watermark';
import { isGeoAllowed } from '../../lib/geo';

export async function getServerSideProps({ req, res, params }) {
  const id = String(params.id || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    return { props: { state: 'gone' } };
  }

  const session = await auth0.getSession(req, res);
  if (!session) {
    return {
      redirect: { destination: `/auth/login?returnTo=${encodeURIComponent(`/s/${id}`)}`, permanent: false },
    };
  }
  const email = normalizeEmail(session.user.email);
  const user = { email };

  if (!(await isGeoAllowed(req, { admin: isAdmin(email), email }))) {
    return { props: { state: 'blocked', user } };
  }

  const key = k(`share:${id}`);
  let share = null;
  try {
    share = await redis().get(key);
  } catch {}
  // Revoked or past its logical expiry — treated as gone even though the
  // record may still physically exist during its post-expiry grace window
  // (see lib/share.js GRACE_SECONDS). Checked before the recipient match so
  // a dead link never leaks anything about who it was for either way.
  if (!isShareActive(share)) return { props: { state: 'gone', user } };

  // Generic mismatch message — never reveals who the link was for.
  if (normalizeEmail(share.email) !== email) {
    return { props: { state: 'mismatch', user } };
  }

  // Count every view (not just the first), preserving the remaining TTL.
  try {
    const r = redis();
    const ttl = await r.ttl(key);
    if (ttl > 0) {
      const now = new Date().toISOString();
      await r.set(
        key,
        {
          ...share,
          viewedAt: share.viewedAt || now,
          views: (share.views || 0) + 1,
          lastViewedAt: now,
        },
        { ex: ttl }
      );
    }
  } catch {}

  let title = 'Shared video';
  try {
    title = (await getVideo(share.videoId))?.title || title;
  } catch {}

  // Best-effort — a watermark hiccup must never block playback (see
  // lib/watermark.js: this is a deterrence accessory, not access control).
  let watermark = false;
  try {
    const [exempt, videoMode, globalDefault] = await Promise.all([
      isExempt(email),
      getVideoMode(share.videoId),
      getGlobalDefault(),
    ]);
    watermark = resolveWatermark({ exempt, shareMode: share.watermark, videoMode, globalDefault });
  } catch {}

  return {
    props: {
      state: 'ok',
      user,
      title,
      embedUrl: signedEmbedUrl(share.videoId),
      videoId: share.videoId,
      expiresAt: share.expiresAt || null,
      shareId: id,
      watermark,
    },
  };
}

export default function Share({ state, user, title, embedUrl, videoId, expiresAt, shareId, watermark }) {
  if (state === 'gone') {
    return (
      <ShareShell user={user}>
        <div className="card card-pad notice">
          <h1>Link unavailable</h1>
          <p>This share link has expired or doesn&apos;t exist.</p>
        </div>
      </ShareShell>
    );
  }
  if (state === 'mismatch') {
    return (
      <ShareShell user={user}>
        <div className="card card-pad notice">
          <h1>Wrong account</h1>
          <p>
            This private link was created for a different account. If you received it directly,
            sign out and sign back in with the email address the link was sent to.
          </p>
        </div>
      </ShareShell>
    );
  }
  if (state === 'blocked') {
    return (
      <ShareShell user={user}>
        <div className="card card-pad notice">
          <h1>Not available in your region</h1>
          <p>This link isn&apos;t accessible from your current location.</p>
        </div>
      </ShareShell>
    );
  }
  return (
    <ShareShell user={user}>
      <h1 className="watch-title">{title}</h1>
      <ResumablePlayer
        embedUrl={embedUrl}
        videoId={videoId}
        title={title}
        shareId={shareId}
        watermark={watermark}
        watermarkLabel={user.email}
      />
      {expiresAt ? (
        <p className="muted share-expiry">
          This link expires {new Date(expiresAt).toLocaleString()}.
        </p>
      ) : null}
    </ShareShell>
  );
}
