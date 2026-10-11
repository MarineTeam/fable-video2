// Group-scoped staff: the route helpers that need Redis or bunny.
//
// The rules are pure (lib/staffScopeRules.js); storage is
// lib/staffScopeStore.js; the actor's scope and content are resolved once in
// lib/guard.js resolveActor(). Everything here fails CLOSED — an error reads
// as "not in scope", never the reverse.
import { getVideo } from './bunny';
import { loadGroups } from './groups';
import { loadShares } from './share';
import { isScoped, mayDeleteVideo, videoInScope } from './staffScopeRules';

export const SCOPED_REFUSAL = "Your access is limited to certain groups, so you can't do that";

// The guids, of those given, a scoped caller may touch. A guid named by the
// scope directly needs no lookup; any other is looked up once, because a
// video can be in scope through its collection. All of them for an unscoped
// caller.
export async function guidsInScope(actor, guids) {
  const list = [...new Set((guids || []).map(String).filter(Boolean))];
  if (!isScoped(actor)) return new Set(list);
  const scope = actor.contentScope || { videoIds: [], collectionIds: [] };
  const out = new Set(list.filter((g) => scope.videoIds.includes(g)));
  const rest = list.filter((g) => !out.has(g));
  if (rest.length && scope.collectionIds.length) {
    await Promise.all(
      rest.map(async (guid) => {
        try {
          const video = await getVideo(guid);
          if (videoInScope(actor, video)) out.add(guid);
        } catch {
          // Unknown or unreadable: out of scope.
        }
      })
    );
  }
  return out;
}

export async function guidInScope(actor, guid) {
  return (await guidsInScope(actor, [guid])).has(String(guid || ''));
}

// Why a scoped caller may not delete this video, as { status, error }, or
// null when they may (always null for an unscoped caller).
export async function scopedDeleteProblem(actor, guid) {
  if (!isScoped(actor)) return null;
  let video;
  let groupsById;
  try {
    [video, groupsById] = await Promise.all([getVideo(guid), loadGroups()]);
  } catch {
    return { status: 404, error: 'Video not found' };
  }
  if (!videoInScope(actor, video)) return { status: 404, error: 'Video not found' };
  if (!mayDeleteVideo(actor, video, groupsById)) {
    return {
      status: 403,
      error: 'Another group can also see this video, so only someone without a group limit can delete it',
    };
  }
  return null;
}

// The share ids a scoped caller may not touch: links to videos outside their
// scope, and ids naming no link. Empty for an unscoped caller. Callers refuse
// the whole request when this is non-empty — the Shares tab only ever offers
// in-scope links, so a mixed list is a crafted one.
export async function shareIdsOutsideScope(actor, ids) {
  if (!isScoped(actor) || !ids.length) return [];
  const shares = await loadShares(ids);
  const allowed = await guidsInScope(actor, shares.filter(Boolean).map((s) => s.videoId));
  return ids.filter((id, i) => !shares[i] || !allowed.has(shares[i].videoId));
}
