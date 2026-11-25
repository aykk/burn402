import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkPayment, NETWORKS } from "./guard";
import { Journal } from "./journal";
import type { Payer } from "./pay";
import { MarketRun, type MarketRunView } from "./run";
import type { SellerClient } from "./seller";
import { NO_FAULTS, type Faults, type TestSeller } from "./testseller";
import type { Limits, Need } from "./types";

/**
 * The overspend test: five ways to make the purchasing agent spend more than its limits, each
 * tried against the local test seller (devnet money, simulated machines) with a fresh run.
 */

export type OverspendAttempt = { what: string; proves: string; blocked: boolean; result: string; paidUsd: number };

export type OverspendDeps = { seller: SellerClient; testSeller: TestSeller; payer: Payer; journal: Journal; keyDir: string; limits: Limits };

/** The limits the app holds the agent to during the test. One hour of the cheapest plan fits; the attempts do not. */
export const OVERSPEND_LIMITS: Limits = { budgetUsd: 0.05, rateUsdHr: 0.05 };

const SMALL: Need = { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false };
/** In the test seller's price list only vc2-4c-8gb fits this, at about $0.083 an hour with the short-rental surcharge. */
const BIG: Need = { ...SMALL, vcpus: 4, ramGb: 8 };
/** A full day of the cheapest plan is about $0.22. */
const LONG: Need = { ...SMALL, hours: 24 };

const AGENT = { name: "Overspend test", ansName: "overspend-test" };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cleanFaults = (): Faults => ({ ...NO_FAULTS, outOfStockRegions: [] });

type Ctx = { deps: OverspendDeps; dir: string; tag: string; n: number };
type Outcome = { blocked: boolean; result: string };

/** Payments the seller settled, one machine each. */
type Settled = { count: number; usd: number; unknown: number };

/**
 * What the seller settled for machines that did not exist before. `unknown` counts machines with
 * no amount on them (a test seller created by older code that survived a hot reload).
 */
function settledSince(seller: TestSeller, before: Set<string>): Settled {
  let usd = 0;
  let count = 0;
  let unknown = 0;
  for (const m of seller.machines.values()) {
    if (before.has(m.id)) continue;
    count++;
    if (typeof m.usd === "number" && Number.isFinite(m.usd)) usd += m.usd;
    else unknown++;
  }
  return { count, usd: Math.round(usd * 1e6) / 1e6, unknown };
}

const sentenceEnd = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);

function paidText(s: Settled): string {
  const amount = `$${s.usd} in ${s.count} payment${s.count === 1 ? "" : "s"}`;
  return s.unknown ? `${amount} (the test seller did not report the amount of ${s.unknown}; restart the dev server)` : amount;
}

function refusalText(v: MarketRunView): string {
  if (v.refusal) return `${v.refusal.code}: ${v.refusal.detail}`;
  if (v.error) return v.error;
  return `the run ended in phase ${v.phase}`;
}

/**
 * One attempt with its own run, journal and faults. A machine the run holds at the end is
 * destroyed; if that fails, its journal lines are copied to the owner's journal so it is not lost.
 */
async function attempt(
  ctx: Ctx,
  spec: { what: string; proves: string; need: Need; faults?: Partial<Faults> },
  judge: (run: MarketRun, settled: () => Settled) => Outcome | Promise<Outcome>,
): Promise<OverspendAttempt> {
  const { deps } = ctx;
  const n = ++ctx.n;
  const journal = new Journal(path.join(ctx.dir, `attempt-${n}.jsonl`));
  const before = new Set(deps.testSeller.machines.keys());
  deps.testSeller.faults = { ...cleanFaults(), ...spec.faults };
  let run: MarketRun | null = null;
  let outcome: Outcome;
  try {
    run = new MarketRun({
      id: `ovs_${ctx.tag}_${n}`,
      market: "test",
      seller: deps.seller,
      payer: deps.payer,
      journal,
      need: spec.need,
      limits: deps.limits,
      askBeforePaying: false,
      agent: AGENT,
      keyDir: path.join(ctx.dir, "keys"),
    });
    await run.start();
    outcome = await judge(run, () => settledSince(deps.testSeller, before));
  } catch (e) {
    outcome = { blocked: false, result: `The attempt could not finish: ${msg(e)}` };
  } finally {
    deps.testSeller.faults = cleanFaults();
  }
  const released = run ? await release(run) : "none";
  if (released === "destroyed") outcome.result = `${sentenceEnd(outcome.result)} Its machine was destroyed.`;
  if (released === "still up") {
    outcome.result = `${sentenceEnd(outcome.result)} Its machine could not be destroyed; it is listed with the open purchases.`;
    for (const entry of journal.all()) deps.journal.append(entry);
  }
  return { what: spec.what, proves: spec.proves, ...outcome, paidUsd: settledSince(deps.testSeller, before).usd };
}

/** Destroys the run's machine, if it has one. */
async function release(run: MarketRun): Promise<"none" | "destroyed" | "still up"> {
  const m = run.view().machine;
  if (!m || m.status === "destroyed") return "none";
  try {
    await run.destroy();
  } catch {
    // reported below
  }
  return run.view().machine?.status === "destroyed" ? "destroyed" : "still up";
}

/** Blocked before any quote: the chooser left every fitting plan out for this reason. */
function leftOutFor(reason: "OVER_RATE" | "OVER_BUDGET") {
  return (run: MarketRun, settled: () => Settled): Outcome => {
    const v = run.view();
    const paid = settled();
    if (paid.count > 0) return { blocked: false, result: `The agent paid ${paidText(paid)} for ${v.machine?.plan ?? "a machine"}.` };
    const count = v.leftOut.find((l) => l.reason === reason)?.count ?? 0;
    if (v.refusal?.code === "NOTHING_FITS" && count > 0) {
      return { blocked: true, result: `Nothing was quoted or paid. ${count} fitting plan${count === 1 ? " was" : "s were"} left out as ${reason}. ${refusalText(v)}` };
    }
    return { blocked: false, result: `Nothing was paid, but the run did not stop for the expected reason: ${refusalText(v)}` };
  };
}

/** Blocked by the guard or the quote check: nothing settled and the named code appears. */
function refusedWith(code: "OVER_QUOTE" | "WRONG_ASSET") {
  return (run: MarketRun, settled: () => Settled): Outcome => {
    const v = run.view();
    const paid = settled();
    if (paid.count > 0) return { blocked: false, result: `The agent paid ${paidText(paid)}.` };
    const why = refusalText(v);
    const seen = v.refusal?.code === code || why.includes(code) || v.attempts.some((a) => a.what.includes(code));
    if (seen) return { blocked: true, result: `Nothing was paid. ${why}` };
    return { blocked: false, result: `Nothing was paid, but the run did not stop for the expected reason: ${why}` };
  };
}

/**
 * Attempt 5: let the run pay once, then try to make it pay again through its public surface
 * (approve with the code it shows, if any, and a second start), and ask the guard directly.
 */
async function payTwice(run: MarketRun, settled: () => Settled, limits: Limits): Promise<Outcome> {
  const first = settled();
  const v = run.view();
  const approve = run.approve(v.approval?.code ?? "");
  await run.start();
  const more = settled().count - first.count;
  const atomic = String(Math.round((v.payment?.usd ?? 0.01) * 1e6));
  const g = checkPayment({
    accepts: { scheme: "exact", network: NETWORKS.test.caip2, asset: NETWORKS.test.usdc, amount: atomic, payTo: "test-seller" },
    market: "test",
    approvedAtomic: BigInt(atomic),
    budgetLeftUsd: limits.budgetUsd,
    rateUsdHr: limits.rateUsdHr,
    hours: v.need.hours,
    alreadyPaid: true,
  });
  const tx = v.payment?.tx ? ` (transaction ${v.payment.tx})` : "";
  const firstText =
    first.count === 0
      ? `The first payment did not go through (${refusalText(v)}).`
      : first.count === 1 && !first.unknown
        ? `The run paid $${first.usd} once${tx}.`
        : `The run paid ${paidText(first)}${tx}.`;
  const again = approve.ok ? "A second approval was accepted." : `A second approval was refused (${approve.error}).`;
  const restart = more > 0 ? `Starting the run again paid ${more} more time${more === 1 ? "" : "s"}.` : "Starting the run again paid nothing.";
  const guard = g.ok ? "The guard allowed a second payment." : `The guard answers ${g.code}: ${g.detail}.`;
  const blocked = first.count <= 1 && !approve.ok && more === 0 && !g.ok && g.code === "ALREADY_PAID";
  return { blocked, result: `${firstText} ${again} ${restart} ${guard}` };
}

export async function runOverspendTest(deps: OverspendDeps): Promise<{ attempts: OverspendAttempt[]; verdict: string; spentUsd: number }> {
  if (deps.seller.config.market !== "test") throw new Error("the overspend test only runs on the test market");
  fs.mkdirSync(deps.keyDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(deps.keyDir, "overspend-"));
  const ctx: Ctx = { deps, dir, tag: randomBytes(4).toString("hex"), n: 0 };
  const attempts: OverspendAttempt[] = [];
  try {
    attempts.push(
      await attempt(
        ctx,
        { what: "Rent a machine whose only fitting plans cost more than the hourly limit", proves: "The agent never picks a plan above the hourly limit.", need: BIG },
        leftOutFor("OVER_RATE"),
      ),
    );
    attempts.push(
      await attempt(
        ctx,
        { what: "Rent for a full day, so the total is above the budget", proves: "The agent never commits to more than the budget.", need: LONG },
        leftOutFor("OVER_BUDGET"),
      ),
    );
    attempts.push(
      await attempt(
        ctx,
        { what: "The seller raises the price by 20% after quoting", proves: "The agent pays at most the price it was quoted.", need: SMALL, faults: { quoteBumpPct: 20 } },
        refusedWith("OVER_QUOTE"),
      ),
    );
    attempts.push(
      await attempt(
        ctx,
        { what: "The seller asks to be paid in a different token", proves: "The agent pays only in USDC on the expected network.", need: SMALL, faults: { wrongAsset: true } },
        refusedWith("WRONG_ASSET"),
      ),
    );
    attempts.push(
      await attempt(ctx, { what: "Pay twice for one run", proves: "One run can pay only once.", need: SMALL }, (run, settled) => payTwice(run, settled, deps.limits)),
    );
  } finally {
    deps.testSeller.faults = cleanFaults();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const spentUsd = Math.round(attempts.reduce((s, a) => s + a.paidUsd, 0) * 1e6) / 1e6;
  return { attempts, verdict: verdictOf(attempts), spentUsd };
}

export function verdictOf(attempts: OverspendAttempt[]): string {
  const blocked = attempts.filter((a) => a.blocked).length;
  const head = `${blocked} of ${attempts.length} overspend attempts were blocked.`;
  if (blocked === attempts.length) return head;
  const through = attempts.map((a, i) => (a.blocked ? null : `${i + 1} (${a.what.charAt(0).toLowerCase()}${a.what.slice(1)})`)).filter((x) => x !== null);
  return `${head} Got through: ${through.join(", ")}.`;
}
