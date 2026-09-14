import ResumablePlayer from '../../../components/ResumablePlayer';
import ShareShell from '../../../components/ShareShell';
import { publicWatchProps } from '../../../lib/publicWatch';
import { withMonitorPage } from '../../../lib/monitor';

// The public door. Every access decision for this route lives in
// lib/publicWatch.js — read that file to audit what an anonymous visitor can
// reach; this file only renders what that returns.
export const getServerSideProps = withMonitorPage(publicWatchProps);

export default function PublicWatch({ state, siteName, video, embedUrl, chapters, notes }) {
  if (state === 'blocked') {
    return (
      <ShareShell siteName={siteName}>
        <div className="card card-pad notice">
          <h1>Not available in your region</h1>
          <p>This video isn&apos;t available from your current location.</p>
        </div>
      </ShareShell>
    );
  }

  return (
    <ShareShell siteName={siteName}>
      <h1 className="watch-title">{video.title}</h1>
      <ResumablePlayer
        embedUrl={embedUrl}
        videoId={video.guid}
        title={video.title}
        chapters={chapters}
        trackProgress={false}
      />
      {notes ? (
        <section className="card card-pad video-notes">
          <h2 className="section-title">Notes</h2>
          <p className="notes-body">{notes}</p>
        </section>
      ) : null}
    </ShareShell>
  );
}
