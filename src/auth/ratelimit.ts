// Minimal in-memory sliding-window rate limiter. Used to bound unauthenticated
// Dynamic Client Registration so an anonymous caller cannot exhaust memory by
// registering clients in a loop. Deliberately dependency-free and self-pruning
// so the limiter itself cannot become an unbounded map.
interface Window {
  hits: number[];
}

const windows = new Map<string, Window>();
const MAX_KEYS = 50_000; // hard cap so the limiter can't be memory-exhausted itself

// Returns true if the action is allowed (and records it), false if the key has
// already used its quota within the window. `now` is injectable for tests.
export function rateLimitAllow(key: string, max: number, windowMs: number, now: number = Date.now()): boolean {
  let w = windows.get(key);
  if (!w) {
    if (windows.size >= MAX_KEYS) pruneOldest(windowMs, now);
    w = { hits: [] };
    windows.set(key, w);
  }
  const cutoff = now - windowMs;
  w.hits = w.hits.filter(t => t > cutoff);
  if (w.hits.length >= max) return false;
  w.hits.push(now);
  return true;
}

function pruneOldest(windowMs: number, now: number): void {
  const cutoff = now - windowMs;
  for (const [k, w] of windows) {
    w.hits = w.hits.filter(t => t > cutoff);
    if (w.hits.length === 0) windows.delete(k);
  }
  // If still at the cap (all keys active), drop the arbitrary oldest to make room.
  if (windows.size >= MAX_KEYS) {
    const firstKey = windows.keys().next().value;
    if (firstKey !== undefined) windows.delete(firstKey);
  }
}

// Test/ops helper.
export function _resetRateLimiter(): void {
  windows.clear();
}
