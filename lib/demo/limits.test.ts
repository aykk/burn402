import { describe, expect, it } from "vitest";
import { allow, DEMO_BUSY, PUBLIC_LIMITS, publicLimit, TOO_MANY } from "./limits";
import type { Visitor } from "../market/access";

const pub = (sid: string, ip: string): Visitor => ({ kind: "public", host: "demo.example.com", ip, sid });

describe("allow", () => {
  it("lets max uses through per window and forgets old ones", () => {
    const store = new Map<string, number[]>();
    expect(allow("k", 2, 1000, 0, store)).toBe(true);
    expect(allow("k", 2, 1000, 10, store)).toBe(true);
    expect(allow("k", 2, 1000, 20, store)).toBe(false);
    expect(allow("k", 2, 1000, 1005, store)).toBe(true);
  });
});

describe("publicLimit", () => {
  it("never limits the owner", () => {
    const store = new Map<string, number[]>();
    for (let i = 0; i < 500; i++) expect(publicLimit("run", { kind: "owner" }, i, store)).toBeNull();
  });
  it("limits one session, then one address across sessions", () => {
    const store = new Map<string, number[]>();
    for (let i = 0; i < PUBLIC_LIMITS.run.session; i++) expect(publicLimit("run", pub("a", "1.1.1.1"), i, store)).toBeNull();
    expect(publicLimit("run", pub("a", "1.1.1.1"), 100, store)).toBe(TOO_MANY);
    for (let i = 0; i < PUBLIC_LIMITS.run.ip - PUBLIC_LIMITS.run.session; i++) expect(publicLimit("run", pub(`b${i}`, "1.1.1.1"), 200 + i, store)).toBeNull();
    expect(publicLimit("run", pub("fresh", "1.1.1.1"), 300, store)).toBe(TOO_MANY);
    expect(publicLimit("run", pub("fresh", "2.2.2.2"), 300, store)).toBeNull();
  });
  it("limits everyone together, and a refused start is not counted", () => {
    const store = new Map<string, number[]>();
    for (let i = 0; i < PUBLIC_LIMITS.overspend.everyone; i++) expect(publicLimit("overspend", pub(`s${i}`, `10.0.0.${i}`), i, store)).toBeNull();
    expect(publicLimit("overspend", pub("late", "10.9.9.9"), 50, store)).toBe(DEMO_BUSY);
    expect(store.get("overspend:sid:late")).toBeUndefined();
    // an hour later there is room again
    expect(publicLimit("overspend", pub("late", "10.9.9.9"), 3_600_100, store)).toBeNull();
  });
});
