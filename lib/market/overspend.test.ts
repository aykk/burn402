import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPayment } from "./guard";
import { Journal } from "./journal";
import { OVERSPEND_LIMITS, runOverspendTest } from "./overspend";
import { SELLERS, SellerClient, type SellerConfig } from "./seller";
import { FakeProcessor, fakePayer, inProcess } from "./testing";
import { NO_FAULTS, TestSeller } from "./testseller";
import type { Limits } from "./types";

/** vc2-1c-1gb for 1 hour: 0.009027 x 1.15, rounded up to the next atomic unit */
const ONE_RENTAL_USD = 0.010382;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(o: { config?: SellerConfig; limits?: Limits } = {}) {
  const processor = new FakeProcessor();
  const config = o.config ?? SELLERS.test;
  const testSeller = new TestSeller({ processor, resourceUrl: `${config.baseUrl}/compute/provision`, activeAfterSec: 0 });
  const payer = fakePayer();
  const seller = new SellerClient(config, { fetch: inProcess(testSeller), signer: payer.signer });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overspend-"));
  dirs.push(dir);
  const journalFile = path.join(dir, "purchases.jsonl");
  const journal = new Journal(journalFile);
  const keyDir = path.join(dir, "keys");
  const deps = { seller, testSeller, payer, journal, keyDir, limits: o.limits ?? OVERSPEND_LIMITS };
  return { deps, processor, testSeller, payer, journal, journalFile, keyDir };
}

describe("runOverspendTest", () => {
  it("blocks all five attempts; exactly one rental is settled, and its machine is destroyed", async () => {
    const { deps, processor, testSeller, payer, journal, keyDir } = setup();
    testSeller.faults = { ...NO_FAULTS, wrongAsset: true }; // left over from the owner's fault switches

    const out = await runOverspendTest(deps);

    expect(out.attempts).toHaveLength(5);
    for (const a of out.attempts) {
      expect(a.blocked, `${a.what}: ${a.result}`).toBe(true);
      expect(a.what).not.toBe("");
      expect(a.proves).not.toBe("");
      expect(a.result).not.toBe("");
    }
    expect(out.verdict).toBe("5 of 5 overspend attempts were blocked.");

    // only the first half of attempt 5 paid, once
    expect(out.attempts.map((a) => a.paidUsd)).toEqual([0, 0, 0, 0, ONE_RENTAL_USD]);
    expect(out.spentUsd).toBe(ONE_RENTAL_USD);
    expect(processor.settled).toBe(1);
    expect(payer.calls).toBe(1);
    expect(testSeller.machines.size).toBe(1);
    expect([...testSeller.machines.values()].every((m) => m.destroyed)).toBe(true);

    // what each attempt ran into
    expect(out.attempts[0].result).toContain("OVER_RATE");
    expect(out.attempts[1].result).toContain("OVER_BUDGET");
    expect(out.attempts[2].result).toContain("OVER_QUOTE");
    expect(out.attempts[3].result).toContain("WRONG_ASSET");
    expect(out.attempts[4].result).toContain("ALREADY_PAID");

    // faults are clean afterwards, the owner's journal got no test lines, the temp files are gone
    expect(testSeller.faults).toEqual(NO_FAULTS);
    expect(journal.all()).toEqual([]);
    expect(fs.existsSync(keyDir) ? fs.readdirSync(keyDir) : []).toEqual([]);
  });

  it("the guard refuses a second payment outright", () => {
    const g = checkPayment({
      accepts: { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amount: "10382", payTo: "x" },
      market: "test",
      approvedAtomic: BigInt(10382),
      budgetLeftUsd: 1,
      rateUsdHr: 1,
      hours: 1,
      alreadyPaid: true,
    });
    expect(g).toMatchObject({ ok: false, code: "ALREADY_PAID" });
  });

  it("names the attempts that got through, and still destroys every machine they bought", async () => {
    // limits loose enough that the big machine and the long rental both fit
    const { deps, processor, testSeller } = setup({ limits: { budgetUsd: 1, rateUsdHr: 1 } });
    const out = await runOverspendTest(deps);
    expect(out.attempts.map((a) => a.blocked)).toEqual([false, false, true, true, true]);
    expect(out.attempts[0].paidUsd).toBeGreaterThan(0);
    expect(out.attempts[1].paidUsd).toBeGreaterThan(0);
    expect(out.verdict).toMatch(/^3 of 5 overspend attempts were blocked\. Got through: 1 \(.+\), 2 \(.+\)\.$/);
    expect(processor.settled).toBe(3);
    expect(out.spentUsd).toBeCloseTo(out.attempts.reduce((s, a) => s + a.paidUsd, 0), 9);
    expect([...testSeller.machines.values()].every((m) => m.destroyed)).toBe(true);
    expect(testSeller.faults).toEqual(NO_FAULTS);
  });

  it("does not crash on a test seller whose machines carry no amount (older code kept across a hot reload)", async () => {
    const { deps, processor, testSeller } = setup();
    const set = testSeller.machines.set.bind(testSeller.machines);
    testSeller.machines.set = (id, m) => set(id, { ...m, usd: undefined as unknown as number });
    const out = await runOverspendTest(deps);
    expect(out.attempts.every((a) => a.blocked)).toBe(true);
    expect(out.attempts[4].result).toContain("restart the dev server");
    expect(Number.isFinite(out.spentUsd)).toBe(true);
    expect(processor.settled).toBe(1);
  });

  it("refuses to run against anything but the test market", async () => {
    const { deps, processor } = setup({ config: { ...SELLERS.test, market: "real" } });
    await expect(runOverspendTest(deps)).rejects.toThrow("the overspend test only runs on the test market");
    expect(processor.settled).toBe(0);
  });
});
