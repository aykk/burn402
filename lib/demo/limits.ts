/**
 * Rate limits for public visitors, in memory. The public demo spends one shared devnet wallet and
 * writes a record per purchase, so starts are counted per session, per address and for everyone.
 * The owner is never limited.
 */
import type { Visitor } from "../market/access";

const HOUR_MS = 3_600_000;

type Hits = Map<string, number[]>;
const hits: Hits = ((globalThis as unknown as { __burn402Hits?: Hits }).__burn402Hits ??= new Map());

/** Counts one use of `key` when fewer than `max` happened in the last `windowMs`; false (and no count) otherwise. */
export function allow(key: string, max: number, windowMs: number, now: number = Date.now(), store: Hits = hits): boolean {
  const recent = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    store.set(key, recent);
    return false;
  }
  recent.push(now);
  store.set(key, recent);
  return true;
}

/** True when `key` has room, without counting. */
function room(key: string, max: number, windowMs: number, now: number, store: Hits): boolean {
  return (store.get(key) ?? []).filter((t) => now - t < windowMs).length < max;
}

export const PUBLIC_LIMITS = {
  run: { session: 10, ip: 20, everyone: 150 },
  overspend: { session: 3, ip: 5, everyone: 20 },
} as const;

export const TOO_MANY = "You have used the demo a lot in the last hour. Try again later.";
export const DEMO_BUSY = "The demo is very busy right now. Try again in a few minutes.";

/**
 * Null when a public visitor may start one more `what` this hour (and counts it); else the message.
 * All three counters are checked before any is counted, so a refused start costs nothing.
 */
export function publicLimit(what: keyof typeof PUBLIC_LIMITS, v: Visitor, now: number = Date.now(), store: Hits = hits): string | null {
  if (v.kind === "owner") return null;
  const limit = PUBLIC_LIMITS[what];
  const keys: [string, number, string][] = [
    [`${what}:sid:${v.sid ?? "none"}`, limit.session, TOO_MANY],
    [`${what}:ip:${v.ip ?? "none"}`, limit.ip, TOO_MANY],
    [`${what}:all`, limit.everyone, DEMO_BUSY],
  ];
  for (const [key, max, message] of keys) if (!room(key, max, HOUR_MS, now, store)) return message;
  for (const [key, max] of keys) allow(key, max, HOUR_MS, now, store);
  return null;
}
