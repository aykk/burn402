import type { TrainingRunView } from "@/lib/demo/train";
import type { PlanQuote } from "@/lib/train";

export type MeterPhase = "ready" | "negotiating" | "running" | "done" | "failed";

export type MeterJob = Pick<
  TrainingRunView,
  "phase" | "budgetUsd" | "rateUsdHr" | "quotes" | "chosen" | "plan" | "paidUsd" | "paidAt" | "doneAt" | "error"
>;

export type MeterView = {
  phase: MeterPhase;
  budgetUsd: number;
  rateUsdHr: number;
  remainingUsd: number;
  quotedUsd: number | null;
  paidUsd: number | null;
  burnedUsd: number | null;
  /** Hourly price of the plan actually rented (falling back to the broker's pick), or null. */
  hourlyUsd: number | null;
  /** Seconds the paid server ran, from payment to the end of the run; null until the run is done. */
  ranSeconds: number | null;
  error: string | null;
};

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

export function meterView(input: {
  formBudgetUsd: number;
  formRateUsdHr: number;
  job: MeterJob | null;
  nowSec: number;
}): MeterView {
  const { job, nowSec } = input;
  if (!job) {
    return {
      phase: "ready",
      budgetUsd: input.formBudgetUsd,
      rateUsdHr: input.formRateUsdHr,
      remainingUsd: input.formBudgetUsd,
      quotedUsd: null,
      paidUsd: null,
      burnedUsd: null,
      hourlyUsd: null,
      ranSeconds: null,
      error: null,
    };
  }

  const phase: MeterPhase =
    job.phase === "negotiating" ? "negotiating"
    : job.phase === "done" ? "done"
    : job.phase === "failed" ? "failed"
    : "running";

  const quote: PlanQuote | null =
    (job.plan ? job.quotes.find((x) => x.plan === job.plan) : undefined) ?? job.chosen ?? null;
  const paid = finite(job.paidUsd) ? job.paidUsd : null;

  let burned: number | null = null;
  if (paid !== null && quote && finite(quote.hourlyUsd)) {
    if (!finite(job.paidAt)) burned = 0;
    else {
      const end = Math.min(nowSec, job.doneAt ?? nowSec);
      const raw = (quote.hourlyUsd * (end - job.paidAt)) / 3600;
      burned = Math.min(paid, Math.max(0, finite(raw) ? raw : 0));
    }
  }

  return {
    phase,
    budgetUsd: job.budgetUsd,
    rateUsdHr: job.rateUsdHr,
    remainingUsd: paid !== null ? job.budgetUsd - paid : job.budgetUsd,
    quotedUsd: quote && finite(quote.jobUsd) ? quote.jobUsd : null,
    paidUsd: paid,
    burnedUsd: burned,
    hourlyUsd: quote && finite(quote.hourlyUsd) && quote.hourlyUsd > 0 ? quote.hourlyUsd : null,
    ranSeconds: phase === "done" && finite(job.paidAt) && finite(job.doneAt) ? Math.max(0, job.doneAt - job.paidAt) : null,
    error: phase === "failed" ? job.error : null,
  };
}

/**
 * The meter zoomed to the job: the quoted amount (before payment) or the paid amount fills the gauge,
 * and the paid amount drains to zero at the rented plan's hourly rate. Once the run is done or failed
 * the server is released, so the gauge is empty and shut. Null while there is no price to show.
 */
export type JobGauge = {
  state: "quoted" | "draining" | "shut";
  /** What a full gauge stands for: the paid amount, or the quote before payment. */
  scaleUsd: number;
  /** Server money not yet burned. */
  leftUsd: number;
  /** leftUsd / scaleUsd, 0 to 1. */
  fill: number;
  /** Server seconds leftUsd buys at the rented rate; null when the rate is unknown. */
  secondsLeft: number | null;
};

export function jobGauge(v: MeterView): JobGauge | null {
  const secondsFor = (usd: number) => (v.hourlyUsd !== null ? (usd / v.hourlyUsd) * 3600 : null);
  if (v.paidUsd !== null && v.paidUsd > 0) {
    if (v.phase === "done" || v.phase === "failed") {
      return { state: "shut", scaleUsd: v.paidUsd, leftUsd: 0, fill: 0, secondsLeft: 0 };
    }
    const left = Math.min(v.paidUsd, Math.max(0, v.paidUsd - (v.burnedUsd ?? 0)));
    return { state: "draining", scaleUsd: v.paidUsd, leftUsd: left, fill: left / v.paidUsd, secondsLeft: secondsFor(left) };
  }
  if ((v.phase === "negotiating" || v.phase === "running") && v.quotedUsd !== null && v.quotedUsd > 0) {
    return { state: "quoted", scaleUsd: v.quotedUsd, leftUsd: v.quotedUsd, fill: 1, secondsLeft: secondsFor(v.quotedUsd) };
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
