import { afterEach, describe, expect, it } from "vitest";
import { IDLE_MS, MAX_PUBLIC_SESSIONS, MAX_SESSIONS_PER_ADDRESS, NoSessionError, peekSession, resetSession, ResetRefusedError, SessionLimitError, getSession, sweepSessions } from "./session";
import type { DemoSession } from "./script";
import type { Visitor } from "../market/access";

type Entry = { session: DemoSession; lastSeen: number; ip: string | null };
type Holder = { runtime: Promise<unknown> | null; owner: DemoSession | null; sessions: Map<string, Entry> };
// the module keeps its holder on globalThis; it exists once the module is loaded
const holder = (globalThis as unknown as { __burn402Sessions: Holder }).__burn402Sessions;

const pub = (sid: string | null, ip: string | null = "203.0.113.1"): Visitor => ({ kind: "public", host: "demo.example.com", ip, sid });
const fake = (phase: string | null, market = "test") => {
  const calls = { cancelled: 0, destroyed: 0 };
  const run = phase === null ? null : { view: () => ({ phase, market }), cancel: () => calls.cancelled++, destroy: async () => void calls.destroyed++ };
  return { session: { market: run } as unknown as DemoSession, calls };
};

afterEach(() => {
  holder.owner = null;
  holder.sessions.clear();
  holder.runtime = null;
});

describe("resetSession (I2b)", () => {
  it("refuses while the owner's run is paying or provisioning and drops nothing", async () => {
    for (const phase of ["paying", "provisioning"]) {
      const { session, calls } = fake(phase, "real");
      holder.owner = session;
      await expect(resetSession()).rejects.toThrow(new ResetRefusedError("A payment is in progress. Wait for it to finish before resetting."));
      expect(holder.owner).toBe(session);
      expect(calls.cancelled).toBe(0);
    }
  });
  it("resets one public session and leaves the others and the owner alone", async () => {
    holder.runtime = Promise.resolve({ log: { push() {} } });
    const a = fake("ready");
    const b = fake("approval");
    const owner = fake("ready", "real");
    holder.owner = owner.session;
    holder.sessions.set("a".repeat(32), { session: a.session, lastSeen: Date.now(), ip: "203.0.113.1" });
    holder.sessions.set("b".repeat(32), { session: b.session, lastSeen: Date.now(), ip: "203.0.113.2" });
    const fresh = await resetSession(pub("a".repeat(32)));
    expect(a.calls.destroyed).toBe(1);
    expect(fresh).not.toBe(a.session);
    expect(holder.sessions.get("a".repeat(32))?.session).toBe(fresh);
    expect(holder.sessions.get("b".repeat(32))?.session).toBe(b.session);
    expect(b.calls.cancelled).toBe(0);
    expect(holder.owner).toBe(owner.session);
    expect(owner.calls.destroyed).toBe(0);
  });
});

describe("public sessions", () => {
  it("peek never creates one; get creates one per cookie and the owner keeps its own", async () => {
    holder.runtime = Promise.resolve({ log: { push() {} } });
    expect(await peekSession(pub("c".repeat(32)))).toBeNull();
    expect(holder.sessions.size).toBe(0);
    const one = await getSession(pub("c".repeat(32)));
    expect(await getSession(pub("c".repeat(32)))).toBe(one);
    expect(await peekSession(pub("c".repeat(32)))).toBe(one);
    const two = await getSession(pub("d".repeat(32)));
    expect(two).not.toBe(one);
    const owner = await getSession();
    expect(owner).not.toBe(one);
    expect(owner.kind).toBe("owner");
    expect(one.kind).toBe("public");
  });
  it("a public request with no cookie gets no session", async () => {
    holder.runtime = Promise.resolve({ log: { push() {} } });
    await expect(getSession(pub(null))).rejects.toThrow(NoSessionError);
    expect(await peekSession(pub(null))).toBeNull();
  });
  it("caps sessions per address and overall", async () => {
    holder.runtime = Promise.resolve({ log: { push() {} } });
    for (let i = 0; i < MAX_SESSIONS_PER_ADDRESS; i++) await getSession(pub(i.toString(16).padStart(32, "0"), "198.51.100.7"));
    await expect(getSession(pub("e".repeat(32), "198.51.100.7"))).rejects.toThrow(SessionLimitError);
    await getSession(pub("e".repeat(32), "198.51.100.8"));
    holder.sessions.clear();
    for (let i = 0; i < MAX_PUBLIC_SESSIONS; i++) holder.sessions.set(`s${i}`, { session: fake(null).session, lastSeen: Date.now(), ip: `10.0.${i >> 8}.${i & 255}` });
    await expect(getSession(pub("f".repeat(32), "198.51.100.9"))).rejects.toThrow(SessionLimitError);
  });
  it("drops idle sessions (destroying a test machine), but never one whose payment is in flight", () => {
    const idle = fake("ready");
    const paying = fake("paying");
    const live = fake("ready");
    const old = Date.now() - IDLE_MS - 1000;
    holder.sessions.set("idle", { session: idle.session, lastSeen: old, ip: null });
    holder.sessions.set("paying", { session: paying.session, lastSeen: old, ip: null });
    holder.sessions.set("live", { session: live.session, lastSeen: Date.now(), ip: null });
    expect(sweepSessions()).toBe(1);
    expect([...holder.sessions.keys()].sort()).toEqual(["live", "paying"]);
    expect(idle.calls.destroyed).toBe(1);
    expect(live.calls.destroyed).toBe(0);
  });
});
