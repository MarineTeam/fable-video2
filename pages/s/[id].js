import ResumablePlayer from '../../components/ResumablePlayer';
import { LogoIcon } from '../../components/icons';
import { auth0 } from '../../lib/auth0';
import { normalizeEmail } from '../../lib/auth';
import { redis, k } from '../../lib/redis';
import { getVideo, signedEmbedUrl } from '../../lib/bunny';

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

  const key = k(`share:${id}`);
  let share = null;
  try {
    share = await redis().get(key);
  } catch {}
  if (!share) return { props: { state: 'gone', user } };

  // Generic mismatch message — never reveals who the link was for.
  if (normalizeEmail(share.email) !== email) {
    return { props: { state: 'mismatch', user } };
  }

  // Stamp first view, preserving the remaining TTL.
  if (!share.viewedAt) {
    try {
      const r = redis();
      const ttl = await r.ttl(key);
      if (ttl > 0) {
        await r.set(key, { ...share, viewedAt: new Date().toISOString() }, { ex: ttl });
      }
    } catch {}
  }

  let title = 'Shared video';
  try {
    title = (await getVideo(share.videoId))?.title || title;
  } catch {}

  return {
    props: {
      state: 'ok',
      user,
      title,
      embedUrl: signedEmbedUrl(share.videoId),
      videoId: share.videoId,
      expiresAt: share.expiresAt || null,
    },
  };
}

// Minimal shell: recipients aren't necessarily approved viewers, so no
// library navigation here.
function ShareShell({ user, children }) {
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          <LogoIcon />
          <span>Marine Video Portal</span>
        </span>
        <div className="topbar-actions">
          {user ? <span className="user-email">{user.email}</span> : null}
          {user ? (
            <a href="/auth/logout" className="btn btn-ghost btn-sm">
              Sign out
            </a>
          ) : null}
        </div>
      </header>
      <main className="main wide">{children}</main>
      <footer className="footer">Private share — this link is tied to your email address.</footer>
    </div>
  );
}

export default function Share({ state, user, title, embedUrl, videoId, expiresAt }) {
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
  return (
    <ShareShell user={user}>
      <h1 className="watch-title">{title}</h1>
      <ResumablePlayer embedUrl={embedUrl} videoId={videoId} title={title} />
      {expiresAt ? (
        <p className="muted share-expiry">
          This link expires {new Date(expiresAt).toLocaleString()}.
        </p>
      ) : null}
    </ShareShell>
  );
}
