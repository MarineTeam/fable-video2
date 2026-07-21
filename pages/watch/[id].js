import Link from 'next/link';
import AppShell from '../../components/AppShell';
import ResumablePlayer from '../../components/ResumablePlayer';
import { ChevronLeftIcon } from '../../components/icons';
import { auth0 } from '../../lib/auth0';
import { isAdmin, normalizeEmail } from '../../lib/auth';
import { redis, k } from '../../lib/redis';
import { getVideo, signedEmbedUrl } from '../../lib/bunny';
import { resolveWatermark, isExempt, getVideoMode, getGlobalDefault } from '../../lib/watermark';

export async function getServerSideProps({ req, res, params }) {
  const id = String(params.id || '');
  if (!/^[0-9a-f-]{10,64}$/i.test(id)) return { notFound: true };

  const session = await auth0.getSession(req, res);
  if (!session) {
    return {
      redirect: { destination: `/auth/login?returnTo=${encodeURIComponent(`/watch/${id}`)}`, permanent: false },
    };
  }
  const email = normalizeEmail(session.user.email);
  const admin = isAdmin(email);
  let approved = admin;
  if (!approved) {
    try {
      approved = (await redis().sismember(k('viewers'), email)) === 1;
    } catch {
      approved = false;
    }
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
