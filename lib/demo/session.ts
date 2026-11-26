import { OWNER, type Visitor } from "../market/access";
import { resetRefusal, settleOnReset } from "../market/recover";
import { configFromEnv, createRuntime, type Runtime } from "./runtime";
import { DemoSession } from "./script";

/**
 * Sessions. The owner (this computer) has one, as before. Every public visitor gets a private one,
 * named by their session cookie: its own run, log and open purchases. All of them share one runtime
 * (the identities and the record store). Public sessions are capped and dropped when idle.
 */

export const MAX_PUBLIC_SESSIONS = 300;
export const MAX_SESSIONS_PER_ADDRESS = 8;
export const IDLE_MS = 45 * 60_000;

type Entry = { session: DemoSession; lastSeen: number; ip: string | null };
type Holder = { runtime: Promise<Runtime> | null; owner: DemoSession | null; sessions: Map<string, Entry> };

const holder = ((globalThis as unknown as { __burn402Sessions?: Holder }).__burn402Sessions ??= { runtime: null, owner: null, sessions: new Map() });

export function getRuntime(): Promise<Runtime> {
  holder.runtime ??= createRuntime(configFromEnv());
  holder.runtime.catch(() => {
    holder.runtime = null;
  });
  return holder.runtime;
}

/** No room for another public session; the route answers 503 with the message. */
export class SessionLimitError extends Error {
  constructor(message = "The demo is full right now. Try again in a few minutes.") {
    super(message);
    this.name = "SessionLimitError";
  }
}

/** A public request with no session cookie; the route answers 400. */
export class NoSessionError extends Error {
  constructor() {
    super("Your session was not found. Reload the page.");
    this.name = "NoSessionError";
  }
}

/** Drops public sessions nobody has touched for IDLE_MS: an approval is cancelled, a test machine destroyed. */
export function sweepSessions(now: number = Date.now()): number {
  let dropped = 0;
  for (const [sid, entry] of holder.sessions) {
    if (now - entry.lastSeen < IDLE_MS) continue;
    // never while money is moving: the run is kept until it settles
    if (resetRefusal(entry.session.market)) continue;
    holder.sessions.delete(sid);
    dropped++;
    void settleOnReset(entry.session.market).catch(() => {});
  }
  return dropped;
}

/** The visitor's session, or null when a public visitor has none yet. Never creates one. */
export async function peekSession(v: Visitor = OWNER): Promise<DemoSession | null> {
  if (v.kind === "owner") return getSession(v);
  if (v.sid === null) return null;
  const entry = holder.sessions.get(v.sid);
  if (!entry) return null;
  entry.lastSeen = Date.now();
  return entry.session;
}

/** The visitor's session, created on first use. Public sessions are capped overall and per address. */
export async function getSession(v: Visitor = OWNER): Promise<DemoSession> {
  const rt = await getRuntime();
  if (v.kind === "owner") return (holder.owner ??= new DemoSession(rt, "owner"));
  if (v.sid === null) throw new NoSessionError();
  const now = Date.now();
  const existing = holder.sessions.get(v.sid);
  if (existing) {
    existing.lastSeen = now;
    return existing.session;
  }
  sweepSessions(now);
  if (holder.sessions.size >= MAX_PUBLIC_SESSIONS) throw new SessionLimitError();
  if (v.ip !== null) {
    let same = 0;
    for (const e of holder.sessions.values()) if (e.ip === v.ip) same++;
    if (same >= MAX_SESSIONS_PER_ADDRESS) throw new SessionLimitError("Too many sessions are open from your network. Try again later.");
  }
  const session = new DemoSession(rt, "public");
  holder.sessions.set(v.sid, { session, lastSeen: now, ip: v.ip });
  return session;
}

/** Every live session: the owner's and the public ones. */
export function allSessions(): DemoSession[] {
  return [...(holder.owner ? [holder.owner] : []), ...[...holder.sessions.values()].map((e) => e.session)];
}

/** A reset refused because a payment is in flight; the route answers 409 with the message. */
export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetRefusedError";
  }
}

/**
 * Forgets the visitor's session and gives them a fresh one: an approval is cancelled, a test machine
 * destroyed, a real machine kept (see settleOnReset). Refused while a payment is in flight. Other
 * visitors' sessions are untouched.
 */
export async function resetSession(v: Visitor = OWNER): Promise<DemoSession> {
  const previous = v.kind === "owner" ? holder.owner : v.sid !== null ? (holder.sessions.get(v.sid)?.session ?? null) : null;
  if (previous) {
    // checked before anything is dropped: a run paying or provisioning must stay visible and counted as busy
    const refused = resetRefusal(previous.market);
    if (refused) throw new ResetRefusedError(refused);
    if (v.kind === "owner") holder.owner = null;
    else if (v.sid !== null) holder.sessions.delete(v.sid);
    try {
      await settleOnReset(previous.market);
    } catch {}
  }
  return getSession(v);
}
