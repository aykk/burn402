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
    error: phase === "failed" ? job.error : null,
  };
}
