import type { TrainingRunView } from "@/lib/demo/train";

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
