// Custom homepage ordering. Videos an admin has placed follow the saved order;
// anything not yet placed (new uploads) floats to the top, newest first.

export function applyOrder(videos, order) {
  const list = Array.isArray(videos) ? videos : [];
  const saved = Array.isArray(order) ? order : [];
  const pos = new Map(saved.map((guid, i) => [guid, i]));
  const placed = list
    .filter((v) => pos.has(v.guid))
    .sort((a, b) => pos.get(a.guid) - pos.get(b.guid));
  const fresh = list
    .filter((v) => !pos.has(v.guid))
    .sort((a, b) => Date.parse(b.dateUploaded || 0) - Date.parse(a.dateUploaded || 0));
  return [...fresh, ...placed];
}

// Drop guids that no longer exist (e.g. after a delete).
export function pruneOrder(order, existingGuids) {
  const keep = new Set(existingGuids || []);
  return (Array.isArray(order) ? order : []).filter((guid) => keep.has(guid));
}
