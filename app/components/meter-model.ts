import { usdExact } from "../../lib/market/money";
import type { MarketRunView } from "@/lib/market/run";
import { usd2, usd4 } from "./format";
import { hoursText, timeLeft } from "./market-copy";

export type MeterPhase = "ready" | "searching" | "approval" | "paying" | "running" | "released" | "failed" | "refused";

export type MeterJob = Pick<MarketRunView, "phase" | "limits" | "approval" | "payment" | "machine" | "paidAt" | "releasedAt" | "error" | "refusal" | "need" | "spent">;

export type MeterView = {
  phase: MeterPhase;
  budgetUsd: number;
  rateUsdHr: number;
  remainingUsd: number;
  /** The firm quote at the approval stop (or being paid); null before there is one. */
  quotedUsd: number | null;
  /** That quote exactly, as the approval line states it ("$0.010382"). */
  quotedExact: string | null;
  /** Hours the quote buys (the seller's billed hours). */
  quotedHours: number | null;
  /** What was signed and sent over x402 (confirmed or not; see `spent`). Never an estimate. */
  paidUsd: number | null;
  /** That amount exactly, from the atomic units ("$0.010382"). */
  paidExact: string | null;
  /** The run's own word on the money: "nothing" only when no payment was ever signed. */
  spent: MarketRunView["spent"];
  /** The run knew of a machine at some point. */
  hadMachine: boolean;
  /** Seconds of prepaid time the payment bought (the hours asked for, or until the destroy time). */
  spanSeconds: number | null;
  /** The share of the paid amount the machine time used so far stands for; prepaid, so nothing moves. */
  usedUsd: number | null;
  /** Seconds of rented time left while the machine runs; null otherwise. */
  secondsLeft: number | null;
  /** Seconds from payment to release, once released. */
  ranSeconds: number | null;
  /** A failed run that paid and still knows of a machine: it may still be running (and can be destroyed). */
  machineMayRun: boolean;
  error: string | null;
};

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/** `paid`: a payment counts as machine time once it is confirmed or a machine is known; until then it is only sent. */
function phaseOf(job: MeterJob, paid: boolean): MeterPhase {
  switch (job.phase) {
    case "scanning":
    case "choosing":
    case "quoting":
      return "searching";
    case "approval":
      return "approval";
    case "paying":
      return paid ? "running" : "paying";
    case "provisioning":
    case "ready":
    case "releasing":
      return "running";
    case "released":
      return "released";
    case "failed":
      return "failed";
    case "refused":
      return "refused";
  }
}

/** All times in ms (MarketRunView and Snapshot.nowMs). */
export function meterView(input: { formBudgetUsd: number; formRateUsdHr: number; job: MeterJob | null; nowMs: number }): MeterView {
  const { job, nowMs } = input;
  if (!job) {
    return {
      phase: "ready",
      budgetUsd: input.formBudgetUsd,
      rateUsdHr: input.formRateUsdHr,
      remainingUsd: input.formBudgetUsd,
      quotedUsd: null,
      quotedExact: null,
      quotedHours: null,
      paidUsd: null,
      paidExact: null,
      spent: "nothing",
      hadMachine: false,
      spanSeconds: null,
      usedUsd: null,
      secondsLeft: null,
      ranSeconds: null,
      machineMayRun: false,
      error: null,
    };
  }

  const paid = job.payment && finite(job.payment.usd) ? job.payment.usd : null;
  const phase = phaseOf(job, paid !== null && (job.payment?.status === "confirmed" || job.machine !== null));
  const { budgetUsd, rateUsdHr } = job.limits;

  let usedUsd: number | null = null;
  let secondsLeft: number | null = null;
  let ranSeconds: number | null = null;
  let spanSeconds: number | null = null;
  const start = finite(job.paidAt) ? job.paidAt : job.payment && finite(job.payment.at) ? job.payment.at : null;
  if (paid !== null && start !== null) {
    // The prepaid time runs over the hours asked for, or until the machine's destroy time if that is sooner.
    let span = job.need.hours * 3_600_000;
    const destroyAt = job.machine?.destroyAt;
    if (finite(destroyAt) && destroyAt > start && destroyAt - start < span) span = destroyAt - start;
    spanSeconds = span / 1000;
    const end = finite(job.releasedAt) ? Math.min(nowMs, job.releasedAt) : nowMs;
    const elapsed = Math.max(0, end - start);
    const share = span > 0 ? Math.min(1, elapsed / span) : 1;
    usedUsd = paid * share;
    if (phase === "running") secondsLeft = Math.max(0, (span - elapsed) / 1000);
    if (phase === "released" && finite(job.releasedAt)) ranSeconds = Math.max(0, (job.releasedAt - start) / 1000);
  } else if (paid !== null) {
    usedUsd = 0;
  }

  const quoteLive = phase === "approval" || phase === "paying" || phase === "running";
  const quote = quoteLive && job.approval && finite(job.approval.usd) ? job.approval : null;

  return {
    phase,
    budgetUsd,
    rateUsdHr,
    remainingUsd: paid !== null ? budgetUsd - paid : budgetUsd,
    quotedUsd: quote ? quote.usd : null,
    quotedExact: quote ? quote.exact || usdExact(quote.atomic) : null,
    quotedHours: quote && finite(quote.hours) ? quote.hours : null,
    paidUsd: paid,
    paidExact: paid !== null && job.payment ? usdExact(job.payment.atomic) : null,
    spent: job.spent,
    hadMachine: job.machine !== null,
    spanSeconds,
    usedUsd,
    secondsLeft,
    ranSeconds,
    // After a successful release the phase is released, so a failed run with a machine never had it destroyed.
    machineMayRun: phase === "failed" && paid !== null && job.machine !== null && job.machine.status !== "destroyed",
    error: phase === "failed" ? job.error : null,
  };
}

/**
 * The meter zoomed to the rental: the firm quote (before payment) or the paid amount fills the gauge,
 * and the paid amount drains to zero over the rented time. Once the run is over the machine is gone,
 * so the gauge is empty. Null while there is no price to show.
 */
export type JobGauge = {
  /**
   * held: a failed run whose paid machine may still be running; frozen, not shown as gone.
   * sent: the payment is out and not confirmed yet, and no machine is known; not machine time.
   */
  state: "quoted" | "sent" | "draining" | "held" | "shut";
  /** What a full gauge stands for: the paid amount, or the quote before payment. */
  scaleUsd: number;
  /** Paid time not yet used, in dollars. */
  leftUsd: number;
  /** leftUsd / scaleUsd, 0 to 1. */
  fill: number;
  /** Seconds of machine time leftUsd stands for. */
  secondsLeft: number | null;
};

export function jobGauge(v: MeterView): JobGauge | null {
  if (v.paidUsd !== null && v.paidUsd > 0) {
    if (v.machineMayRun) {
      const left = Math.min(v.paidUsd, Math.max(0, v.paidUsd - (v.usedUsd ?? 0)));
      return { state: "held", scaleUsd: v.paidUsd, leftUsd: left, fill: left / v.paidUsd, secondsLeft: null };
    }
    // A run that ended with money out and no machine ever known is a wallet story, not machine time.
    if ((v.phase === "failed" || v.phase === "refused") && !v.hadMachine) return null;
    if (v.phase === "released" || v.phase === "failed" || v.phase === "refused") {
      return { state: "shut", scaleUsd: v.paidUsd, leftUsd: 0, fill: 0, secondsLeft: 0 };
    }
    if (v.phase === "paying") return { state: "sent", scaleUsd: v.paidUsd, leftUsd: v.paidUsd, fill: 1, secondsLeft: null };
    const left = Math.min(v.paidUsd, Math.max(0, v.paidUsd - (v.usedUsd ?? 0)));
    return { state: "draining", scaleUsd: v.paidUsd, leftUsd: left, fill: left / v.paidUsd, secondsLeft: v.secondsLeft };
  }
  if ((v.phase === "approval" || v.phase === "paying") && v.quotedUsd !== null && v.quotedUsd > 0) {
    return { state: "quoted", scaleUsd: v.quotedUsd, leftUsd: v.quotedUsd, fill: 1, secondsLeft: v.quotedHours !== null ? v.quotedHours * 3600 : null };
  }
  return null;
}

export type MeterHeadline = {
  label: string;
  /** The amount in the big figure: the exact quote, or the exact amount paid or sent. Null while the figure is time. */
  amount: string | null;
  /** Prepaid time left while the machine runs. */
  time: string | null;
  /** The muted words after the figure. */
  suffix: string;
};

/**
 * The meter's label and big figure while it is zoomed to the rental. Money there is always a specific
 * amount stated exactly: the firm quote before payment, then what was paid (or sent). Once the run is over
 * it stays the amount paid, never what is left of the prepaid time (which is zero after a destroy).
 * `spanHours` is the prepaid time the figure is measured against.
 */
export function meterHeadline(v: MeterView, j: JobGauge, spanHours: number): MeterHeadline {
  const paid = v.paidExact ?? usd4(v.paidUsd ?? j.scaleUsd);
  const spentLabel = v.spent === "paid" ? "Spent on this rental" : "Sent for this rental, not confirmed";
  switch (j.state) {
    case "quoted":
      return { label: "This rental will use", amount: v.quotedExact ?? usd4(j.scaleUsd), time: null, suffix: "quoted, not paid yet" };
    case "sent":
      return { label: "Payment sent", amount: paid, time: null, suffix: "sent, not confirmed yet" };
    case "draining":
      if (j.secondsLeft !== null) return { label: "Prepaid time left", amount: null, time: timeLeft(j.secondsLeft), suffix: `of ${hoursText(spanHours)}` };
      return { label: v.spent === "paid" ? "Paid for machine time" : "Sent for machine time, not confirmed", amount: paid, time: null, suffix: "" };
    case "held":
      return { label: spentLabel, amount: paid, time: null, suffix: "" };
    case "shut":
      return { label: spentLabel, amount: paid, time: null, suffix: v.phase === "released" ? "machine destroyed" : "" };
  }
}

/** The figure in the meter's corner while it shows the allowance: the limit, or once the run is over, what was spent. */
export function walletReadout(v: MeterView): { label: string; value: string; quiet?: boolean } {
  switch (v.phase) {
    case "searching":
      return { label: "Your agent is comparing prices", value: `limit ${usd2(v.rateUsdHr)} an hour`, quiet: true };
    case "failed":
    case "refused":
    case "released":
      if (v.spent === "paid" && v.paidExact) return { label: "Spent", value: v.paidExact };
      if (v.spent === "maybe" && v.paidExact) return { label: "Sent, not confirmed", value: v.paidExact };
      if (v.spent !== "nothing") return { label: "Spent", value: "unknown" };
      return { label: "Nothing spent", value: "$0.00" };
    default:
      return { label: "Limit", value: `${usd2(v.rateUsdHr)} an hour`, quiet: true };
  }
}

/** The allowance line: at the approval stop nothing has left the wallet yet, so it is what would be left after paying. */
export function allowanceWords(state: JobGauge["state"] | null): { verb: string; tail: string } {
  return state === "quoted" ? { verb: "would have", tail: "left after paying" } : { verb: "has", tail: "left" };
}

/** The budget and hourly limit the form would send, or null while either is out of range (the meter keeps the last valid pair). */
export function draftLimits(budgetUsd: number, rateUsdHr: number): { budgetUsd: number; rateUsdHr: number } | null {
  const ok = (n: number, lo: number, hi: number) => finite(n) && n >= lo && n <= hi;
  if (!ok(budgetUsd, 0.01, 20) || !ok(rateUsdHr, 0.001, Math.min(budgetUsd, 20))) return null;
  return { budgetUsd, rateUsdHr };
}

/** part / budget as a fraction clamped to 0..1; 0 for a missing or non-positive budget. */
export function budgetShare(partUsd: number, budgetUsd: number): number {
  if (!finite(partUsd) || !finite(budgetUsd) || budgetUsd <= 0) return 0;
  return Math.min(1, Math.max(0, partUsd / budgetUsd));
}

/** A share of the budget as text, without rounding a tiny share up to something it is not. */
export function shareText(fraction: number): string {
  const pct = fraction * 100;
  if (!(pct > 0)) return "0%";
  if (pct < 0.01) return "under 0.01%";
  if (pct < 1) return `${pct.toFixed(2)}%`;
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** Split "$0.0012" into the leading zeros that carry no value ("$0.00") and the digits that do ("12"). */
export function leadingZeros(amount: string): [string, string] {
  const lead = /^\$(?:0\.0*)?/.exec(amount)?.[0] ?? "";
  return [lead, amount.slice(lead.length)];
}
