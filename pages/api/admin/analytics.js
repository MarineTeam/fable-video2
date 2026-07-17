import { requireAdmin } from '../../../lib/guard';
import { listVideos, getStatistics } from '../../../lib/bunny';

// Views / watch time / most-watched from bunny.net video stats + the
// statistics API. Every sub-fetch is best-effort so a partial outage still
// renders a dashboard.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const [list, stats] = await Promise.all([
    listVideos({ page: 1, perPage: 100 }).catch(() => null),
    getStatistics({
      dateFrom: from.toISOString().slice(0, 10),
      dateTo: now.toISOString().slice(0, 10),
    }).catch(() => null),
  ]);

  const items = list?.items || [];
  const totalViews = items.reduce((sum, v) => sum + (v.views || 0), 0);
  const top = [...items]
    .sort((a, b) => (b.views || 0) - (a.views || 0))
    .slice(0, 8)
    .map((v) => ({ guid: v.guid, title: v.title, views: v.views || 0 }));

  // viewsChart / watchTimeChart come back as { "<ISO date>": count } maps.
  const chartMap = stats?.viewsChart && typeof stats.viewsChart === 'object' ? stats.viewsChart : {};
  const chart = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const match = Object.keys(chartMap).find((key) => key.startsWith(day));
    chart.push({ date: day, views: match ? Number(chartMap[match]) || 0 : 0 });
  }
  const views30 = chart.reduce((sum, d) => sum + d.views, 0);

  const watchMap =
    stats?.watchTimeChart && typeof stats.watchTimeChart === 'object' ? stats.watchTimeChart : {};
  const watchMinutes = Object.values(watchMap).reduce((sum, v) => sum + (Number(v) || 0), 0);

  res.json({
    videoCount: list?.totalItems ?? items.length,
    totalViews,
    views30,
    watchHours: Math.round((watchMinutes / 60) * 10) / 10,
    chart,
    top,
  });
}
