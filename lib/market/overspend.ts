import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Journal } from "./journal";
import type { Payer } from "./pay";
import { usdPlain } from "./money";
import { leftOutWords, MarketRun, type MarketRunDeps, type MarketRunView } from "./run";
import type { SellerClient } from "./seller";
import { NO_FAULTS, type Faults, type TestSeller } from "./testseller";
import type { Limits, Need } from "./types";

/**
 * The overspend test: five ways to make the purchasing agent spend more than its limits, each
 * tried against the local test seller (devnet money, simulated machines) with a fresh run.
 * What was paid is read from the test seller's settlements ledger, never from the run.
 */

/** `paidUsd` is what the seller settled during the attempt; null when that cannot be read. */
export type OverspendAttempt = { what: string; proves: string; blocked: boolean; result: string; paidUsd: number | null };

export type OverspendResult = { attempts: OverspendAttempt[]; verdict: string; spentUsd: number | null };

/** `findPayment` (optional) lets attempt 5 find the kept payment on devnet, as the owner's runs do. */
export type OverspendDeps = { seller: SellerClient; testSeller: TestSeller; payer: Payer; journal: Journal; keyDir: string; limits: Limits; findPayment?: MarketRunDeps["findPayment"] };

/** The limits the app holds the agent to during the test. One hour of the cheapest plan fits; the attempts do not. */
export const OVERSPEND_LIMITS: Limits = { budgetUsd: 0.05, rateUsdHr: 0.05 };

const SMALL: Need = { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false };
/** In the test seller's price list only vc2-4c-8gb fits this, at about $0.083 an hour with the short-rental surcharge. */
const BIG: Need = { ...SMALL, vcpus: 4, ramGb: 8 };
/** A full day of the cheapest plan is about $0.22. */
const LONG: Need = { ...SMALL, hours: 24 };

const AGENT = { name: "Overspend test", ansName: "overspend-test" };
const NO_LEDGER = "the test seller keeps no settlements ledger (it predates this code); restart the dev server";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cleanFaults = (): Faults => ({ ...NO_FAULTS, outOfStockRegions: [] });
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const sentenceEnd = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);

type Ctx = { deps: OverspendDeps; payer: Payer; signatures: () => number; dir: string; tag: string; n: number };
type Outcome = { blocked: boolean; result: string };
/** What the seller settled during one attempt, and how many payments the agent signed. Null without a ledger. */
type Settled = { count: number; usd: number; signatures: number } | null;
type Judge = (run: MarketRun, settled: () => Settled) => Outcome | Promise<Outcome>;

const ledgerLength = (seller: TestSeller): number | null => (Array.isArray(seller.settlements) ? seller.settlements.length : null);

/** The payer the runs use: the same wallet, counting every signature it is asked for. */
function countingPayer(payer: Payer): { payer: Payer; signatures: () => number } {
  let calls = 0;
  return {
    payer: {
      address: payer.address,
      signer: payer.signer,
      payHeaders: (required) => {
        calls++;
        return payer.payHeaders(required);
      },
    },
    signatures: () => calls,
  };
}

/** How the run ended, in its own plain words (codes stay in the view's code fields). */
function refusalText(v: MarketRunView): string {
  if (v.refusal) return sentenceEnd(v.refusal.detail);
  if (v.error) return sentenceEnd(v.error);
  return `The run ended while ${v.phase}.`;
}

const couldNotFinish = (why: string): Outcome => ({ blocked: false, result: `The attempt could not finish: ${why}` });

/**
 * One attempt with its own run, journal and faults. A machine the run holds at the end is
 * destroyed; if that fails, its journal lines are copied to the owner's journal so it is not lost.
 */
async function attempt(ctx: Ctx, spec: { what: string; proves: string; need: Need; faults?: Partial<Faults> }, judge: Judge): Promise<OverspendAttempt> {
  const { deps } = ctx;
  const n = ++ctx.n;
  const journal = new Journal(path.join(ctx.dir, `attempt-${n}.jsonl`));
  const ledgerStart = ledgerLength(deps.testSeller);
  const signaturesStart = ctx.signatures();
  const settled = (): Settled => {
    if (ledgerStart === null || ledgerLength(deps.testSeller) === null) return null;
    const mine = deps.testSeller.settlements.slice(ledgerStart);
    return { count: mine.length, usd: round6(mine.reduce((s, x) => s + x.usd, 0)), signatures: ctx.signatures() - signaturesStart };
  };
  deps.testSeller.faults = { ...cleanFaults(), ...spec.faults };
  let run: MarketRun | null = null;
  let outcome: Outcome;
  try {
    run = new MarketRun({
      id: `ovs_${ctx.tag}_${n}`,
      market: "test",
      seller: deps.seller,
      payer: ctx.payer,
      journal,
      need: spec.need,
      limits: deps.limits,
      askBeforePaying: false,
      agent: AGENT,
      keyDir: path.join(ctx.dir, "keys"),
      findPayment: deps.findPayment,
      overspendTest: true,
    });
    await run.start();
    outcome = settled() === null ? couldNotFinish(NO_LEDGER) : await judge(run, settled);
  } catch (e) {
    outcome = couldNotFinish(msg(e));
  } finally {
    deps.testSeller.faults = cleanFaults();
  }
  const released = run ? await release(run) : "none";
  if (released === "destroyed") outcome.result = `${sentenceEnd(outcome.result)} Its machine was destroyed.`;
  if (released === "still up") {
    outcome.result = `${sentenceEnd(outcome.result)} Its machine could not be destroyed; it is listed with the open purchases.`;
    for (const entry of journal.all()) deps.journal.append(entry);
  }
  return { what: spec.what, proves: spec.proves, ...outcome, paidUsd: settled()?.usd ?? null };
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

const paidText = (s: NonNullable<Settled>) => `${usdPlain(s.usd)} in ${s.count} payment${s.count === 1 ? "" : "s"}`;

/** Blocked before any quote: the chooser left every fitting plan out for this reason. */
function leftOutFor(reason: "OVER_RATE" | "OVER_BUDGET"): Judge {
  return (run, settled) => {
    const v = run.view();
    const paid = settled()!;
    if (paid.count > 0) return { blocked: false, result: `The agent paid ${paidText(paid)} for ${v.machine?.plan ?? "a machine"}.` };
    const count = v.leftOut.find((l) => l.reason === reason)?.count ?? 0;
    if (v.refusal?.code === "NOTHING_FITS" && count > 0) {
      return { blocked: true, result: `Nothing was quoted or paid. ${count} fitting plan${count === 1 ? " was" : "s were"} left out: ${leftOutWords(reason, v.need)}.` };
    }
    return { blocked: false, result: `Nothing was paid, but the run did not stop for the expected reason: ${refusalText(v)}` };
  };
}

/** Blocked by the guard or the quote check: nothing settled and the named code appears. */
function refusedWith(code: "OVER_QUOTE" | "WRONG_ASSET"): Judge {
  return (run, settled) => {
    const v = run.view();
    const paid = settled()!;
    if (paid.count > 0) return { blocked: false, result: `The agent paid ${paidText(paid)}.` };
    const why = refusalText(v);
    const seen = v.refusal?.code === code || v.attempts.some((a) => a.code === code) || v.rows.some((r) => r.code === code);
    if (seen) return { blocked: true, result: `Nothing was paid. ${why}` };
    return { blocked: false, result: `Nothing was paid, but the run did not stop for the expected reason: ${why}` };
  };
}

/**
 * Attempt 5: the seller settles the payment, builds nothing and answers 402 with a fresh
 * requirement. Blocked only when the seller settled exactly once and the agent signed exactly once.
 */
const settledOnce: Judge = (run, settled) => {
  const v = run.view();
  const s = settled()!;
  if (s.count === 0) return couldNotFinish(`the seller never took the first payment (${refusalText(v)})`);
  if (s.count >= 2) return { blocked: false, result: `The seller was paid ${s.count} times for one rental, ${usdPlain(s.usd)} in all.` };
  if (s.signatures !== 1) return { blocked: false, result: `The agent signed ${s.signatures} payments for one rental; the seller settled one of them.` };
  return {
    blocked: true,
    result: `The seller kept one payment of ${usdPlain(s.usd)} and asked again. The agent refused to pay a second time and bought nothing else. The run ended with: ${refusalText(v)}`,
  };
};

export async function runOverspendTest(deps: OverspendDeps): Promise<OverspendResult> {
  if (deps.seller.config.market !== "test") throw new Error("the overspend test only runs on the test market");
  // without the ledger nothing paid could be measured, so nothing is tried
  if (ledgerLength(deps.testSeller) === null) throw new Error(`the overspend test cannot run: ${NO_LEDGER}`);
  fs.mkdirSync(deps.keyDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(deps.keyDir, "overspend-"));
  const counted = countingPayer(deps.payer);
  const ctx: Ctx = { deps, payer: counted.payer, signatures: counted.signatures, dir, tag: randomBytes(4).toString("hex"), n: 0 };
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
      await attempt(
        ctx,
        {
          what: "The seller takes the payment, then claims it was rejected, to get paid again",
          proves: "A seller cannot make the agent pay twice for one rental.",
          need: SMALL,
          faults: { settleThenReject: true },
        },
        settledOnce,
      ),
    );
  } finally {
    deps.testSeller.faults = cleanFaults();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const spentUsd = attempts.some((a) => a.paidUsd === null) ? null : round6(attempts.reduce((s, a) => s + (a.paidUsd ?? 0), 0));
  return { attempts, verdict: verdictOf(attempts, spentUsd), spentUsd };
}

/** "5 of 5 overspend attempts were blocked." plus one sentence on what the test itself spent. */
export function verdictOf(attempts: OverspendAttempt[], spentUsd: number | null): string {
  const blocked = attempts.filter((a) => a.blocked).length;
  const parts = [`${blocked} of ${attempts.length} overspend attempts were blocked.`];
  if (blocked < attempts.length) {
    const through = attempts.map((a, i) => (a.blocked ? null : `${i + 1} (${a.what.charAt(0).toLowerCase()}${a.what.slice(1)})`)).filter((x) => x !== null);
    parts.push(`Got through: ${through.join(", ")}.`);
  }
  const last = attempts[attempts.length - 1];
  if (spentUsd === null) parts.push("What the test spent could not be read from the test seller.");
  else if (spentUsd === 0) parts.push("The test spent nothing.");
  else if (blocked === attempts.length && last?.paidUsd === spentUsd) {
    parts.push(`The test spent ${usdPlain(spentUsd)} in devnet test USDC: the one payment the dishonest seller in attempt ${attempts.length} kept, which is the seller's doing, not an overspend by the agent.`);
  } else parts.push(`The test spent ${usdPlain(spentUsd)} in devnet test USDC.`);
  return parts.join(" ");
}
