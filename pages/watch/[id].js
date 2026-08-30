import Link from 'next/link';
import AppShell from '../../components/AppShell';
import ResumablePlayer from '../../components/ResumablePlayer';
import { ChevronLeftIcon } from '../../components/icons';
import { auth0 } from '../../lib/auth0';
import { normalizeEmail } from '../../lib/auth';
import { redis, k } from '../../lib/redis';
import { viewerAccessFor } from '../../lib/guard';
import { contentScopeFor, isVideoVisible } from '../../lib/groups';
import { getVideo, signedEmbedUrl } from '../../lib/bunny';
import { resolveWatermark, isExempt, getVideoMode, getGlobalDefault } from '../../lib/watermark';
import { isGeoAllowed } from '../../lib/geo';
import { withMonitorPage } from '../../lib/monitor';

async function gssp({ req, res, params }) {
  const id = String(params.id || '');
  if (!/^[0-9a-f-]{10,64}$/i.test(id)) return { notFound: true };

  const session = await auth0.getSession(req, res);
  if (!session) {
    return {
      redirect: { destination: `/auth/login?returnTo=${encodeURIComponent(`/watch/${id}`)}`, permanent: false },
    };
  }
  const email = normalizeEmail(session.user.email);
  // Same approval decision as /api/videos and the homepage, resolved in one
  // place so the three cannot drift (lib/guard.js).
  const { approved, owner, staff } = await viewerAccessFor(email);
  const admin = owner || staff;
  if (!(await isGeoAllowed(req, { admin, email }))) {
    return { redirect: { destination: '/', permanent: false } };
  }
  if (!approved) {
    return { redirect: { destination: '/', permanent: false } };
  }

  let video;
  try {
    video = await getVideo(id);
  } catch {
    return { notFound: true };
  }
  if (!video?.guid) return { notFound: true };

  // Group content gating, enforcement point 3 of 3 (with /api/videos and
  // /api/collections). Filtering the list without gating direct URLs would
  // not be a gate at all. Inert unless GROUP_CONTENT_GATING=1.
  const scope = await contentScopeFor(email, { staff: admin });
  if (!isVideoVisible(scope, video)) {
    return { redirect: { destination: '/', permanent: false } };
  }

  // Resume position, if any.
  let initialTime = 0;
  try {
    const entry = await redis().hget(k(`progress:${email}`), video.guid);
    const parsed = typeof entry === 'string' ? JSON.parse(entry) : entry;
    if (parsed && Number.isFinite(Number(parsed.seconds))) {
      initialTime = Number(parsed.seconds);
    }
  } catch {}

  redis()
    .hset(k('viewer:lastseen'), { [email]: new Date().toISOString() })
    .catch(() => {});

  // Best-effort — a watermark hiccup must never block playback (see
  // lib/watermark.js). No share record on a regular watch page, so only the
  // video's own setting and the global default can apply.
  let watermark = false;
  try {
    const [exempt, videoMode, globalDefault] = await Promise.all([
      isExempt(email),
      getVideoMode(video.guid),
      getGlobalDefault(),
    ]);
    watermark = resolveWatermark({ exempt, videoMode, globalDefault });
  } catch {}

  return {
    props: {
      user: { email, name: session.user.name || email },
      isAdmin: admin,
      video: { guid: video.guid, title: video.title || 'Untitled', length: video.length || 0 },
      // Signed fresh on every request — never a permanent URL.
      embedUrl: signedEmbedUrl(video.guid),
      initialTime,
      watermark,
    },
  };
}

export const getServerSideProps = withMonitorPage(gssp);

export default function Watch({ user, isAdmin: admin, video, embedUrl, initialTime, watermark }) {
  return (
    <AppShell user={user} isAdmin={admin} approved wide>
      <Link href="/" className="back-link">
        <ChevronLeftIcon /> Library
      </Link>
      <h1 className="watch-title">{video.title}</h1>
      <ResumablePlayer
        embedUrl={embedUrl}
        videoId={video.guid}
        initialTime={initialTime}
        title={video.title}
        watermark={watermark}
        watermarkLabel={user.email}
      />
    </AppShell>
  );
}
