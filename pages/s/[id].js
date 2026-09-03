import ResumablePlayer from '../../components/ResumablePlayer';
import ShareShell from '../../components/ShareShell';
import { auth0 } from '../../lib/auth0';
import { isAdmin, normalizeEmail, trustedEmail } from '../../lib/auth';
import { redis, k } from '../../lib/redis';
import { getVideo, signedEmbedUrl } from '../../lib/bunny';
import { isShareActive } from '../../lib/share';
import { resolveWatermark, isExempt, getVideoMode, getGlobalDefault } from '../../lib/watermark';
import { isGeoAllowed } from '../../lib/geo';
import { withMonitorPage } from '../../lib/monitor';
import { withSiteName } from '../../lib/siteNameStore';

async function gssp({ req, res, params }) {
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
  // Enforced here too, by explicit decision: share recipients are exactly the
  // users least likely to have verified emails, and leaving them out would keep
  // a slice of the hole open — a forged unverified session could match a link's
  // recipient address.
  const email = trustedEmail(session.user);
  if (!email) {
    return { props: { state: 'unverified', user: { email: normalizeEmail(session.user.email) } } };
  }
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

export const getServerSideProps = withMonitorPage(withSiteName(gssp));

export default function Share({ state, user, title, embedUrl, videoId, expiresAt, shareId, watermark, siteName }) {
  if (state === 'gone') {
    return (
      <ShareShell siteName={siteName} user={user}>
        <div className="card card-pad notice">
          <h1>Link unavailable</h1>
          <p>This share link has expired or doesn&apos;t exist.</p>
        </div>
      </ShareShell>
    );
  }
  if (state === 'unverified') {
    return (
      <ShareShell siteName={siteName}>
        <h1>Verify your email</h1>
        <p>
          You&apos;re signed in as <strong>{user?.email}</strong>, but that address hasn&apos;t been
          verified yet. Check your inbox for the verification link, then reload this page.
        </p>
      </ShareShell>
    );
  }

  if (state === 'mismatch') {
    return (
      <ShareShell siteName={siteName} user={user}>
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
      <ShareShell siteName={siteName} user={user}>
        <div className="card card-pad notice">
          <h1>Not available in your region</h1>
          <p>This link isn&apos;t accessible from your current location.</p>
        </div>
      </ShareShell>
    );
  }
  return (
    <ShareShell siteName={siteName} user={user}>
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
