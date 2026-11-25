import type { TrainingRunView } from "@/lib/demo/train";
import type { MarketRunView } from "@/lib/market/run";

export const STAGES = ["Deal", "Payment", "Training", "Receipt"] as const;
export const DEAL = 0;
export const PAYMENT = 1;
export const TRAINING = 2;
export const RECEIPT = 3;

/**
 * Which of the four stages the run is in. The backend never reports "paying" (the agent pays inside
 * the negotiation), so Payment is derived: a plan is picked or money has moved, but the server is not
 * yet both rented and paid for. A failed run is pinned to the stage it stopped in, from what happened.
 */
export function stageIndex(job: TrainingRunView): number {
  const planned = job.plan !== null;
  const paid = job.paidUsd !== null;
  switch (job.phase) {
    case "negotiating":
      return planned || paid ? PAYMENT : DEAL;
    case "paying":
      return PAYMENT;
    case "booting":
      return planned && !paid ? PAYMENT : TRAINING;
    case "training":
      return TRAINING;
    case "publishing":
      return RECEIPT;
    case "done":
      return STAGES.length;
    case "failed":
      if (!planned && !paid) return DEAL;
      return planned && paid ? TRAINING : PAYMENT;
  }
}

/**
 * Where a failed run stopped, as the end of "Stopped …" / "Run failed …". The Training stage also
 * covers the server booting, so a failure before the box reported any training says so instead of
 * claiming training: "while the server was booting" (it never answered) or "before training started".
 */
export function failedWhere(job: TrainingRunView): string {
  const at = Math.min(stageIndex(job), STAGES.length - 1);
  if (at !== TRAINING) return `during ${STAGES[at].toLowerCase()}`;
  const s = job.status;
  const trained = s !== null && s !== undefined && (s.phase === "training" || s.phase === "done" || s.phase === "failed" || s.progress > 0 || s.configs_done > 0);
  if (trained && !/before training/i.test(job.error ?? "")) return "during training";
  return job.liveAt ? "before training started" : "while the server was booting";
}

// ---- the rent page ---------------------------------------------------------

export const MARKET_STAGES = ["Scan", "Choose", "Pay", "Machine"] as const;

/**
 * Which of the four rent stages the run is in: scanning is Scan; choosing and quoting are Choose;
 * approval and paying are Pay; provisioning, ready and releasing are Machine; released is past the
 * last stage (all done). A failed or refused run stays on the stage it reached, read from what happened.
 */
export function marketStage(run: Pick<MarketRunView, "phase" | "rows" | "approval" | "payment" | "machine">): number {
  switch (run.phase) {
    case "scanning":
      return 0;
    case "choosing":
    case "quoting":
      return 1;
    case "approval":
    case "paying":
      return run.payment ? 3 : 2;
    case "provisioning":
    case "ready":
    case "releasing":
      return 3;
    case "released":
      return MARKET_STAGES.length;
    case "failed":
    case "refused":
      if (run.payment || run.machine) return 3;
      if (run.approval) return 2;
      return run.rows.length > 0 ? 1 : 0;
  }
}
