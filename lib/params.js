// Strict readers for untrusted request parameters.
//
// Ported from the sibling repo fable-video, where it was written in response
// to a CodeQL "type confusion through parameter tampering" finding (Critical)
// on `Number(req.body?.length)`. This repo never had that alert, but it had
// the same shape of code in a dozen admin routes. Two distinct hazards, both
// verified against this tree before porting:
//
//  1. **A parameter can arrive as an array.** Next.js hands `req.query.x` back
//     as `string | string[]` when a key repeats (`?x=a&x=b`), and a JSON body
//     can carry an array for any field. `String(["a","b"])` quietly becomes
//     `"a,b"` — a value that was never sent, silently accepted. Worse, a
//     SINGLE-element array collapses to its element: `String(["abcdef1234"])`
//     is `"abcdef1234"`, which sails through a format check like the guid
//     regex in `pages/api/admin/chapters.js`. A validator on the *shape* of
//     the string cannot see that the type was wrong.
//  2. **`.length` is a built-in.** If `req.body` is itself an array or a
//     string rather than an object, `req.body.length` returns ITS size, not a
//     user field at all. That is the specific confusion CodeQL flagged in the
//     sibling.
//
// And the checks these replace were weaker than they look: an emptiness test
// on `String(x || "")` accepts every type. `true` becomes `"true"`, `5`
// becomes `"5"`, and `{a:1}` becomes `"[object Object]"` — all truthy, all
// past the guard.
//
// The rule these helpers encode: coercion is not validation. A value of the
// wrong TYPE is rejected, never bent into the right shape. Callers get a
// predictable `null`/`fallback` and decide what to do about it.

// One string, or null. An array, number, object, boolean, or missing value is
// rejected outright rather than stringified.
export function oneString(value) {
  return typeof value === 'string' ? value : null;
}

// One trimmed, non-empty string, or null.
export function oneTrimmed(value) {
  const text = oneString(value);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed || null;
}

// One finite number, or the fallback. Accepts a numeric string, because JSON
// bodies and query strings both legitimately carry numbers as text — but NOT
// an array, a boolean, or anything else that Number() would coerce into a
// plausible-looking value (`Number([5])` is 5; `Number(true)` is 1).
export function oneNumber(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

// Strict true. Used where a parameter switches on something consequential and
// "truthy" is not good enough — see pages/api/admin/public-video.js, where
// the value decides whether a video is readable by the whole internet.
export function isExplicitlyTrue(value) {
  return value === true;
}
