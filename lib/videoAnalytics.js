// Pure rollup of existing per-share tracking, grouped by video. Reads only
// fields already written elsewhere (lib/share.js createShare/views tracking,
// pages/api/share-event.js plays/furthestPercent/completedAt) — adds no new
// tracking of its own.
export function rollupSharesByVideo(shares) {
  const byVideo = new Map();
  for (const s of shares || []) {
    if (!s?.videoId) continue;
    if (!byVideo.has(s.videoId)) {
      byVideo.set(s.videoId, {
        videoTitle: '',
        recipients: new Set(),
        shares: 0,
        views: 0,
        started: 0,
        completed: 0,
        progressSum: 0,
        progressCount: 0,
      });
    }
    const agg = byVideo.get(s.videoId);
    agg.shares += 1;
    // videoTitle is already attached by the shares API (a Bunny title
    // lookup) — reused here, not fetched again. Survives video deletion,
    // since it's whatever title was on the share record at share time.
    if (!agg.videoTitle && s.videoTitle) agg.videoTitle = s.videoTitle;
    if (s.email) agg.recipients.add(s.email);
    agg.views += s.views || 0;
    if (s.plays > 0) agg.started += 1;
    if (s.completedAt) agg.completed += 1;
    if (typeof s.furthestPercent === 'number') {
      agg.progressSum += s.furthestPercent;
      agg.progressCount += 1;
    }
  }
  const out = {};
  for (const [videoId, agg] of byVideo) {
    out[videoId] = {
      videoTitle: agg.videoTitle || videoId,
      shares: agg.shares,
      uniqueRecipients: agg.recipients.size,
      views: agg.views,
      started: agg.started,
      completed: agg.completed,
      completionRate: agg.started > 0 ? agg.completed / agg.started : 0,
      avgProgress: agg.progressCount > 0 ? Math.round(agg.progressSum / agg.progressCount) : 0,
    };
  }
  return out;
}
