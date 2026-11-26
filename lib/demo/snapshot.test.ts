import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshot } from "./snapshot";
import type { Runtime } from "./runtime";
import type { DemoSession } from "./script";

const root = mkdtempSync(join(tmpdir(), "burn402-snap-"));
const rt = { config: { root }, network: "testnet", log: { lines: [{ seq: 1, at: 0, kind: "info", code: "X", text: "the owner's line" }] } } as unknown as Runtime;
const machine = { id: "tsm-1", ip: "203.0.113.5", ssh: "ssh -i '/Users/owner/app/.burn402/keys/rentals/run-x' root@203.0.113.5", status: "active" };
const session = (kind: "owner" | "public") =>
  ({
    kind,
    runIds: new Set(["mkt_mine"]),
    log: { lines: [{ seq: 1, at: 0, kind: "info", code: "MARKET", text: `${kind} line` }] },
    market: { view: () => ({ id: "mkt_mine", phase: "ready", approval: { code: "secret-code" }, machine }) },
  }) as unknown as DemoSession;

describe("snapshot", () => {
  it("a public visitor with nothing started gets an idle page and nobody else's lines", () => {
    const s = snapshot(rt, null, "public");
    expect(s).toMatchObject({ visitor: "public", market: null, log: [], openPurchases: [], models: null });
    expect(s.walletReady.real).toBe(false);
  });
  it("a public visitor never sees where the key sits on the server", () => {
    const s = snapshot(rt, session("public"), "public");
    expect(s.market?.machine?.ssh).toBe("ssh root@203.0.113.5");
    expect(JSON.stringify(s)).not.toContain("/Users/owner");
    expect(s.log.map((l) => l.text)).toEqual(["public line"]);
    expect(s.models).toBeNull();
  });
  it("the owner sees the full command and the model picker", () => {
    const s = snapshot(rt, session("owner"), "owner");
    expect(s.visitor).toBe("owner");
    expect(s.market?.machine?.ssh).toBe(machine.ssh);
    expect(s.models).not.toBeNull();
  });
});
