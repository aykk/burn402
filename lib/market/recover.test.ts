import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORKS } from "./guard";
import { Journal, type OpenPurchase } from "./journal";
import { destroyOpenPurchase, dismissOpenPurchase, settleOnReset, visibleOpenPurchases } from "./recover";
import { MarketRun } from "./run";
import { SELLERS, SellerClient, type Instance } from "./seller";
import { FakeProcessor, fakePayer, inProcess } from "./testing";
import { TestSeller } from "./testseller";
import type { MarketId } from "./types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "market-recover-"));
  dirs.push(d);
  return d;
};

/** A real MarketRun against an in-process test seller (fake settlement, no money). */
function liveRun(market: MarketId, ask: boolean) {
  let t = 1_700_000_000_000;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
  };
  const processor = new FakeProcessor(market === "real" ? { network: NETWORKS.real.caip2, asset: NETWORKS.real.usdc } : {});
  const config = market === "real" ? { ...SELLERS.test, market: "real" as const } : SELLERS.test;
  const seller = new TestSeller({ processor, resourceUrl: `${config.baseUrl}/compute/provision`, now });
  const payer = fakePayer();
  const dir = tmp();
  const run = new MarketRun({
    id: `run-${market}`,
    market,
    seller: new SellerClient(config, { fetch: inProcess(seller), signer: payer.signer, now, sleep }),
    payer,
    journal: new Journal(path.join(dir, "purchases.jsonl")),
    need: { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false },
    limits: { budgetUsd: 1, rateUsdHr: 1 },
    askBeforePaying: ask,
    agent: { name: "Buyer", ansName: "buyer.agents.test" },
    keyDir: path.join(dir, "keys"),
    now,
    sleep,
    newCode: () => "code-1",
  });
  return { run, seller, payer };
}

describe("settleOnReset (the reset rule)", () => {
  it("never destroys a real-market machine", async () => {
    const { run, seller } = liveRun("real", true);
    await run.start();
    expect(run.approve("code-1")).toEqual({ ok: true });
    await vi.waitFor(() => expect(run.view().phase).toBe("ready"));
    const id = run.view().machine!.id;
    expect(await settleOnReset(run)).toBe("kept");
    expect(run.view().phase).toBe("ready");
    expect(seller.machines.get(id)?.destroyed).toBe(false);
    await run.destroy(); // test cleanup only
  });

  it("destroys an active test-market machine", async () => {
    const { run, seller } = liveRun("test", false);
    await run.start();
    expect(run.view().phase).toBe("ready");
    const id = run.view().machine!.id;
    expect(await settleOnReset(run)).toBe("destroyed");
    expect(run.view().phase).toBe("released");
    expect(seller.machines.get(id)?.destroyed).toBe(true);
  });

  it("cancels a run resting at approval, on either market, with nothing paid", async () => {
    for (const market of ["test", "real"] as const) {
      const { run, payer } = liveRun(market, true);
      await run.start();
      expect(run.view().phase).toBe("approval");
      expect(await settleOnReset(run)).toBe("cancelled");
      expect(run.view().refusal?.code).toBe("CANCELLED");
      expect(payer.calls).toBe(0);
    }
  });

  it("does nothing without a run", async () => {
    expect(await settleOnReset(null)).toBe("none");
  });
});

const OPEN: OpenPurchase = { run: "mkt_old", market: "test", seller: "testseller", plan: "vc2-1c-1gb", region: "ewr", usd: 0.0104, instance: null, tx: null, state: "unknown", at: 1, lastEvent: "intent", what: "", overspendTest: false };

/** A seller stub that can only list, read and destroy: any other call would be a bug. */
function fakeSeller(list: Instance[]) {
  const machines = new Map(list.map((i) => [i.id, { ...i }]));
  return {
    machines,
    instances: vi.fn(async () => [...machines.values()].filter((m) => m.status !== "destroyed")),
    instance: vi.fn(async (id: string) => machines.get(id) ?? null),
    destroy: vi.fn(async (id: string) => {
      const m = machines.get(id);
      if (m) m.status = "destroyed";
    }),
  };
}
const inst = (id: string, plan = "vc2-1c-1gb", region = "ewr", status = "active"): Instance => ({ id, plan, region, status, ip: "203.0.113.9", expiresAt: null });

describe("destroyOpenPurchase", () => {
  const journalIn = () => {
    const j = new Journal(path.join(tmp(), "purchases.jsonl"));
    j.append({ at: 1, run: OPEN.run, market: "test", seller: "testseller", event: "intent", plan: OPEN.plan, region: OPEN.region, usd: OPEN.usd });
    return j;
  };

  it("destroys the recorded machine and journals released", async () => {
    const j = journalIn();
    const s = fakeSeller([inst("m1"), inst("m2")]);
    const r = await destroyOpenPurchase({ ...OPEN, instance: "m1", state: "paid" }, s, j);
    expect(r).toMatchObject({ ok: true, destroyed: ["m1"] });
    expect(s.machines.get("m1")?.status).toBe("destroyed");
    expect(s.machines.get("m2")?.status).toBe("active");
    expect(s.instances).not.toHaveBeenCalled();
    expect(j.open()).toEqual([]);
  });

  it("with only an intent: destroys the wallet's live machines with the same plan and region, except excluded ones", async () => {
    const j = journalIn();
    const s = fakeSeller([inst("match"), inst("other-plan", "vc2-2c-4gb"), inst("other-region", "vc2-1c-1gb", "ord"), inst("gone", "vc2-1c-1gb", "ewr", "destroyed"), inst("someone-elses")]);
    const r = await destroyOpenPurchase(OPEN, s, j, { exclude: new Set(["someone-elses"]) });
    expect(r).toMatchObject({ ok: true, destroyed: ["match"] });
    expect(s.destroy.mock.calls.map((c) => c[0])).toEqual(["match"]);
    expect(s.machines.get("someone-elses")?.status).toBe("active");
    const last = j.all().at(-1)!;
    expect(last).toMatchObject({ run: OPEN.run, event: "released", instance: "match" });
    expect(j.open()).toEqual([]);
  });

  it("with only an intent and nothing matching: journals failed and says nothing is running", async () => {
    const j = journalIn();
    const s = fakeSeller([inst("x", "vc2-2c-4gb")]);
    const r = await destroyOpenPurchase(OPEN, s, j);
    expect(r).toMatchObject({ ok: true, destroyed: [] });
    expect(r.ok && r.message).toMatch(/No machine is running/);
    expect(s.destroy).not.toHaveBeenCalled();
    expect(j.all().at(-1)).toMatchObject({ event: "failed", detail: "no machine found for this payment" });
    expect(j.open()).toEqual([]);
  });

  it("a payment the seller kept, with no machine: does not search or destroy, leaves the journal untouched and says to Dismiss", async () => {
    const j = journalIn();
    j.append({ at: 2, run: OPEN.run, market: "test", seller: "testseller", event: "unknown", plan: OPEN.plan, region: OPEN.region, usd: OPEN.usd });
    j.append({ at: 3, run: OPEN.run, market: "test", seller: "testseller", event: "paid", plan: OPEN.plan, region: OPEN.region, usd: OPEN.usd, tx: "t1", instance: null });
    const s = fakeSeller([inst("unrelated")]);
    const before = j.all().length;
    const r = await destroyOpenPurchase(j.open()[0], s, j);
    expect(r).toEqual({ ok: true, destroyed: [], message: "The seller kept this payment and delivered no machine, so there is nothing to destroy. Use Dismiss to clear it from this list." });
    expect(s.instances).not.toHaveBeenCalled();
    expect(s.destroy).not.toHaveBeenCalled();
    expect(s.machines.get("unrelated")?.status).toBe("active");
    expect(j.all()).toHaveLength(before);
    expect(j.open()).toHaveLength(1);
  });

  it("an unknown outcome with no machine still searches by plan and region and destroys the match", async () => {
    const j = journalIn();
    j.append({ at: 2, run: OPEN.run, market: "test", seller: "testseller", event: "unknown", plan: OPEN.plan, region: OPEN.region, usd: OPEN.usd });
    const s = fakeSeller([inst("late")]);
    const r = await destroyOpenPurchase(j.open()[0], s, j);
    expect(r).toMatchObject({ ok: true, destroyed: ["late"] });
    expect(j.all().at(-1)).toMatchObject({ event: "released", instance: "late" });
  });

  it("a payment that may have gone through, with no machine: says so and stays listed", async () => {
    const j = journalIn();
    j.append({ at: 2, run: OPEN.run, market: "test", seller: "testseller", event: "unknown", plan: OPEN.plan, region: OPEN.region, usd: OPEN.usd });
    const s = fakeSeller([]);
    const r = await destroyOpenPurchase(j.open()[0], s, j);
    expect(r).toEqual({ ok: true, destroyed: [], message: "There is no machine to destroy for this purchase. The payment of $0.0104 may have gone through; no machine was found for it. It stays on the list." });
    expect(j.open()).toHaveLength(1);
  });

  it("a destroy the seller does not confirm is reported and the purchase stays open", async () => {
    const j = journalIn();
    const s = fakeSeller([inst("m1")]);
    s.destroy.mockImplementation(async () => {});
    const r = await destroyOpenPurchase({ ...OPEN, instance: "m1", state: "paid" }, s, j);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("still lists m1 as active") });
    expect(j.open()).toHaveLength(1);
  });

  it("a failed instance list is reported and nothing is journaled", async () => {
    const j = journalIn();
    const s = fakeSeller([]);
    s.instances.mockRejectedValue(new Error("401"));
    const r = await destroyOpenPurchase(OPEN, s, j);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("401") });
    expect(j.all()).toHaveLength(1);
  });
});

describe("dismissOpenPurchase", () => {
  const kept = () => {
    const j = new Journal(path.join(tmp(), "purchases.jsonl"));
    j.append({ at: 1, run: OPEN.run, market: "test", seller: "testseller", event: "intent", plan: OPEN.plan, region: OPEN.region, usd: OPEN.usd });
    j.append({ at: 2, run: OPEN.run, market: "test", seller: "testseller", event: "paid", plan: OPEN.plan, region: OPEN.region, usd: OPEN.usd, tx: "t1", instance: null });
    return j;
  };

  it("closes a kept payment with no machine: one journal line, dismissed by owner, and it leaves the list", () => {
    const j = kept();
    const r = dismissOpenPurchase(j.open()[0], j, { now: () => 5 });
    expect(r).toMatchObject({ ok: true, destroyed: [] });
    expect(j.all()).toHaveLength(3);
    expect(j.all().at(-1)).toMatchObject({ at: 5, run: OPEN.run, event: "failed", instance: null, tx: "t1", usd: OPEN.usd, detail: "dismissed by owner" });
    expect(j.open()).toEqual([]);
  });

  it("closes an unconfirmed payment with no machine", () => {
    const j = new Journal(path.join(tmp(), "purchases.jsonl"));
    j.append({ at: 1, run: OPEN.run, market: "test", seller: "testseller", event: "unknown", plan: OPEN.plan, region: OPEN.region, usd: OPEN.usd });
    expect(dismissOpenPurchase(j.open()[0], j).ok).toBe(true);
    expect(j.open()).toEqual([]);
  });

  it("refuses an entry with a machine on record, in plain words, and writes nothing", () => {
    const j = kept();
    j.append({ at: 3, run: OPEN.run, market: "test", seller: "testseller", event: "active", plan: OPEN.plan, region: OPEN.region, usd: OPEN.usd, instance: "m1" });
    const r = dismissOpenPurchase(j.open()[0], j);
    expect(r).toEqual({ ok: false, error: "This purchase has a machine on record (m1). Destroy it instead; it cannot be dismissed." });
    expect(j.all()).toHaveLength(3);
    expect(j.open()).toHaveLength(1);
  });
});

describe("visibleOpenPurchases", () => {
  const a = { ...OPEN, run: "a" };
  const b = { ...OPEN, run: "b" };
  it("hides the current run while it is going and lists it once it has ended", () => {
    expect(visibleOpenPurchases([a, b], null)).toEqual([a, b]);
    for (const phase of ["paying", "provisioning", "ready", "releasing"] as const) expect(visibleOpenPurchases([a, b], { id: "a", phase })).toEqual([b]);
    for (const phase of ["failed", "released", "refused"] as const) expect(visibleOpenPurchases([a, b], { id: "a", phase })).toEqual([a, b]);
  });
});
