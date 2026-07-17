import { Ratelimit } from '@upstash/ratelimit';
import { redis, k } from './redis';

const limiters = new Map();

function limiter(limit, windowSeconds) {
  const key = `${limit}:${windowSeconds}`;
  if (!limiters.has(key)) {
    limiters.set(
      key,
      new Ratelimit({
        redis: redis(),
        limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
        prefix: k('rl'),
      })
    );
  }
  return limiters.get(key);
}

// Sliding-window check. Fails OPEN: an infrastructure hiccup must never block
// real users.
export async function allowRequest(name, id, limit, windowSeconds) {
  try {
    const { success } = await limiter(limit, windowSeconds).limit(`${name}:${id}`);
    return success;
  } catch {
    return true;
  }
}
