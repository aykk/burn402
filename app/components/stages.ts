import type { MarketRunView } from "@/lib/market/run";

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
