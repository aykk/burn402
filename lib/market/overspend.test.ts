import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPayment } from "./guard";
import { Journal } from "./journal";
import { OVERSPEND_LIMITS, runOverspendTest, verdictOf } from "./overspend";
import type { Payer } from "./pay";
import { MarketRun } from "./run";
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

type PayFn = Parameters<SellerClient["provision"]>[1];

/**
 * Deliberately broken: when the seller says the payment was rejected, this client signs a new
 * payment itself, around the run's guard, and sends the request again. A correct run cannot stop it,
 * so the overspend test must report attempt 5 as got through.
 */
class RepayingClient extends SellerClient {
  constructor(
    config: SellerConfig,
    deps: ConstructorParameters<typeof SellerClient>[1],
    private readonly wallet: Payer,
  ) {
    super(config, deps);
  }

  override async provision(...[quote, pay]: Parameters<SellerClient["provision"]>) {
    const out = await super.provision(quote, pay);
    if (out.kind !== "not_charged" || out.code !== "PAYMENT_REJECTED") return out;
    const unguarded: PayFn = async (required) => this.wallet.payHeaders(required);
    return super.provision(quote, unguarded);
  }
}

function setup(o: { config?: SellerConfig; limits?: Limits; broken?: boolean; payer?: Payer & { calls: number } } = {}) {
  const processor = new FakeProcessor();
  const config = o.config ?? SELLERS.test;
  const testSeller = new TestSeller({ processor, resourceUrl: `${config.baseUrl}/compute/provision`, activeAfterSec: 0 });
  const payer = o.payer ?? fakePayer();
  const clientDeps = { fetch: inProcess(testSeller), signer: payer.signer };
  const seller = o.broken ? new RepayingClient(config, clientDeps, payer) : new SellerClient(config, clientDeps);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overspend-"));
  dirs.push(dir);
  const journal = new Journal(path.join(dir, "purchases.jsonl"));
  const keyDir = path.join(dir, "keys");
  const deps = { seller, testSeller, payer, journal, keyDir, limits: o.limits ?? OVERSPEND_LIMITS };
  return { deps, processor, testSeller, payer, journal, keyDir };
}

describe("runOverspendTest", () => {
  it("blocks all five attempts; only the dishonest seller's one kept payment is spent", async () => {
    const { deps, processor, testSeller, payer, journal, keyDir } = setup();
    testSeller.faults = { ...NO_FAULTS, wrongAsset: true }; // left over from the owner's fault switches

    const out = await runOverspendTest(deps);

    expect(out.attempts).toHaveLength(5);
    for (const a of out.attempts) {
      expect(a.blocked, `${a.what}: ${a.result}`).toBe(true);
      expect(a.proves).not.toBe("");
    }
    expect(out.verdict).toMatch(/^5 of 5 overspend attempts were blocked\. The test spent \$0\.010382 in devnet test USDC: the one payment the dishonest seller in attempt 5 kept/);

    expect(out.attempts.map((a) => a.paidUsd)).toEqual([0, 0, 0, 0, ONE_RENTAL_USD]);
    expect(out.spentUsd).toBe(ONE_RENTAL_USD);
    expect(processor.settled).toBe(1);
    expect(testSeller.settlements).toHaveLength(1);
    expect(payer.calls).toBe(1); // one signature in the whole test
    expect(testSeller.machines.size).toBe(0);

    expect(out.attempts[0].result).toBe("Nothing was quoted or paid. 1 fitting plan was left out: over your hourly limit.");
    expect(out.attempts[1].result).toMatch(/^Nothing was quoted or paid\. \d+ fitting plans? (was|were) left out: over your budget\.$/);
    expect(out.attempts[2].result).toBe("Nothing was paid. The seller now asks $0.012458, more than the $0.010382 you approved.");
    expect(out.attempts[3].result).toBe("Nothing was paid. No seller gave a usable quote. The last problem: The seller asked to be paid in SOL instead of USDC on Solana devnet.");
    expect(out.attempts[4].result).toContain("The seller kept one payment of $0.010382 and asked again. The agent refused to pay a second time");
    for (const a of out.attempts) for (const t of [a.what, a.proves, a.result]) expect(t).not.toMatch(/\b[A-Z]{2,}_[A-Z_]+\b|atomic|[{}]/);
    expect(out.attempts[4].proves).toBe("A seller cannot make the agent pay twice for one rental.");

    expect(testSeller.faults).toEqual(NO_FAULTS);
    expect(journal.all()).toEqual([]);
    expect(fs.existsSync(keyDir) ? fs.readdirSync(keyDir) : []).toEqual([]);
  });

  it("can fail: a seller client that pays again around the guard makes attempt 5 got through", async () => {
    const { deps, testSeller } = setup({ broken: true });
    const out = await runOverspendTest(deps);
    expect(out.attempts.slice(0, 4).every((a) => a.blocked)).toBe(true);
    expect(out.attempts[4]).toMatchObject({ blocked: false, paidUsd: 2 * ONE_RENTAL_USD });
    expect(out.attempts[4].result).toContain("paid 2 times for one rental");
    expect(testSeller.settlements).toHaveLength(2);
    expect(out.verdict).toMatch(/^4 of 5 overspend attempts were blocked\. Got through: 5 \(the seller takes the payment.*\)\. The test spent \$0\.020764 in devnet test USDC\.$/);
  });

  it("marks every run it makes as the overspend test's, never the owner's (S6)", async () => {
    const { deps } = setup();
    const seen: { id: string; overspendTest: boolean; budget: number }[] = [];
    const start = vi.spyOn(MarketRun.prototype, "start").mockImplementation(function (this: MarketRun) {
      const v = this.view();
      seen.push({ id: v.id, overspendTest: v.overspendTest, budget: v.limits.budgetUsd });
      return Promise.resolve();
    });
    try {
      await runOverspendTest(deps);
    } finally {
      start.mockRestore();
    }
    expect(seen).toHaveLength(5);
    for (const r of seen) expect(r).toMatchObject({ id: expect.stringMatching(/^ovs_/), overspendTest: true, budget: OVERSPEND_LIMITS.budgetUsd });
  });

  it("passes the chain check to its runs, so attempt 5 names the payment the seller kept", async () => {
    const { deps } = setup();
    const calls: unknown[] = [];
    const out = await runOverspendTest({
      ...deps,
      findPayment: async (q) => {
        calls.push(q);
        return { tx: "keptTx" };
      },
    });
    expect(calls).toHaveLength(1);
    expect(out.attempts[4].blocked).toBe(true);
    expect(out.attempts[4].result).toContain("The run ended with: The seller took one payment of $0.010382 and did not deliver a machine.");
  });

  it("does not report attempt 5 blocked when the first payment never happens", async () => {
    const payer = fakePayer();
    payer.payHeaders = async () => {
      payer.calls++;
      throw new Error("devnet is down");
    };
    const { deps, testSeller } = setup({ payer });
    const out = await runOverspendTest(deps);
    expect(out.attempts[4].blocked).toBe(false);
    expect(out.attempts[4].result).toMatch(/^The attempt could not finish: the seller never took the first payment/);
    expect(out.attempts[4].paidUsd).toBe(0);
    expect(testSeller.settlements).toHaveLength(0);
  });

  it("tries nothing when the test seller keeps no ledger (an instance built by older code)", async () => {
    const { deps, processor, testSeller } = setup();
    Object.defineProperty(testSeller, "settlements", { value: undefined });
    await expect(runOverspendTest(deps)).rejects.toThrow(/restart the dev server/);
    expect(processor.settled).toBe(0);
  });

  it("the verdict says the spend is unknown when an attempt's amount could not be read", () => {
    const a = { what: "x", proves: "y", blocked: true, result: "z" };
    expect(verdictOf([{ ...a, paidUsd: 0 }, { ...a, paidUsd: null }], null)).toBe("2 of 2 overspend attempts were blocked. What the test spent could not be read from the test seller.");
  });

  it("names the attempts that got through, and still destroys every machine they bought", async () => {
    // limits loose enough that the big machine and the long rental both fit
    const { deps, processor, testSeller } = setup({ limits: { budgetUsd: 1, rateUsdHr: 1 } });
    const out = await runOverspendTest(deps);
    expect(out.attempts.map((a) => a.blocked)).toEqual([false, false, true, true, true]);
    expect(out.attempts[0].paidUsd).toBeGreaterThan(0);
    expect(out.attempts[1].paidUsd).toBeGreaterThan(0);
    expect(out.verdict).toMatch(/^3 of 5 overspend attempts were blocked\. Got through: 1 \(.+\), 2 \(.+\)\. The test spent \$\d+\.\d{2,6} in devnet test USDC\.$/);
    expect(processor.settled).toBe(3);
    expect(out.spentUsd).toBeCloseTo(out.attempts.reduce((s, a) => s + (a.paidUsd ?? 0), 0), 9);
    expect(testSeller.machines.size).toBe(2);
    expect([...testSeller.machines.values()].every((m) => m.destroyed)).toBe(true);
    expect(testSeller.faults).toEqual(NO_FAULTS);
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

  it("refuses to run against anything but the test market", async () => {
    const { deps, processor } = setup({ config: { ...SELLERS.test, market: "real" } });
    await expect(runOverspendTest(deps)).rejects.toThrow("the overspend test only runs on the test market");
    expect(processor.settled).toBe(0);
  });
});
