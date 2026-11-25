import type { MarketRunView } from "@/lib/market/run";

export type MeterPhase = "ready" | "searching" | "approval" | "paying" | "running" | "released" | "failed" | "refused";

export type MeterJob = Pick<MarketRunView, "phase" | "limits" | "approval" | "payment" | "machine" | "paidAt" | "releasedAt" | "error" | "refusal" | "need">;

export type MeterView = {
  phase: MeterPhase;
  budgetUsd: number;
  rateUsdHr: number;
  remainingUsd: number;
  /** The firm quote at the approval stop (or being paid); null before there is one. */
  quotedUsd: number | null;
  /** Hours the quote buys (the seller's billed hours). */
  quotedHours: number | null;
  /** What was actually paid over x402. Never an estimate. */
  paidUsd: number | null;
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
      quotedHours: null,
      paidUsd: null,
      usedUsd: null,
      secondsLeft: null,
      ranSeconds: null,
      machineMayRun: false,
      error: null,
    };
  }

  const paid = job.payment && finite(job.payment.usd) ? job.payment.usd : null;
  const phase = phaseOf(job, paid !== null);
  const { budgetUsd, rateUsdHr } = job.limits;

  let usedUsd: number | null = null;
  let secondsLeft: number | null = null;
  let ranSeconds: number | null = null;
  const start = finite(job.paidAt) ? job.paidAt : job.payment && finite(job.payment.at) ? job.payment.at : null;
  if (paid !== null && start !== null) {
    // The prepaid time runs over the hours asked for, or until the machine's destroy time if that is sooner.
    let span = job.need.hours * 3_600_000;
    const destroyAt = job.machine?.destroyAt;
    if (finite(destroyAt) && destroyAt > start && destroyAt - start < span) span = destroyAt - start;
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
    quotedHours: quote && finite(quote.hours) ? quote.hours : null,
    paidUsd: paid,
    usedUsd,
    secondsLeft,
    ranSeconds,
    // After a successful release the phase is released, so a failed run with a machine never had it destroyed.
    machineMayRun: phase === "failed" && paid !== null && job.machine !== null,
    error: phase === "failed" ? job.error : null,
  };
}

/**
 * The meter zoomed to the rental: the firm quote (before payment) or the paid amount fills the gauge,
 * and the paid amount drains to zero over the rented time. Once the run is over the machine is gone,
 * so the gauge is empty. Null while there is no price to show.
 */
export type JobGauge = {
  /** held: a failed run whose paid machine may still be running; frozen, not shown as gone. */
  state: "quoted" | "draining" | "held" | "shut";
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
    if (v.phase === "released" || v.phase === "failed" || v.phase === "refused") {
      return { state: "shut", scaleUsd: v.paidUsd, leftUsd: 0, fill: 0, secondsLeft: 0 };
    }
    const left = Math.min(v.paidUsd, Math.max(0, v.paidUsd - (v.usedUsd ?? 0)));
    return { state: "draining", scaleUsd: v.paidUsd, leftUsd: left, fill: left / v.paidUsd, secondsLeft: v.secondsLeft };
  }
  if ((v.phase === "approval" || v.phase === "paying") && v.quotedUsd !== null && v.quotedUsd > 0) {
    return { state: "quoted", scaleUsd: v.quotedUsd, leftUsd: v.quotedUsd, fill: 1, secondsLeft: v.quotedHours !== null ? v.quotedHours * 3600 : null };
  }
  return null;
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
