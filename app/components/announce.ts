import type { TrainingRunView } from "@/lib/demo/train";
import { duration, usd4 } from "./format";
import { STAGES, failedWhere, stageIndex } from "./stages";

/** What the live region remembers about a run between polls. */
export type RunMark = { id: string; phase: TrainingRunView["phase"]; stage: number; paid: boolean };

export function runMark(job: TrainingRunView): RunMark {
  return { id: job.id, phase: job.phase, stage: stageIndex(job), paid: job.paidUsd !== null };
}

const sentence = (s: string) => {
  const t = s.trim().charAt(0).toUpperCase() + s.trim().slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/**
 * The sentence a screen reader hears when a poll changes the run, or null when nothing worth saying
 * changed. Only milestones are announced: a run starting, each new stage, the payment settling, done
 * and failed. The per-second meter drain never is. The first snapshot after a page load is a baseline,
 * so reloading on a finished run says nothing.
 */
export function runAnnouncement(prev: RunMark | null | undefined, job: TrainingRunView | null): string | null {
  if (!job || prev === undefined) return null;
  const next = runMark(job);
  const fresh = prev === null || prev.id !== next.id;
  if (!fresh && prev.phase === next.phase && prev.stage === next.stage && prev.paid === next.paid) return null;

  const parts: string[] = [];
  const settled = next.phase === "done" || next.phase === "failed";
  if (fresh && !settled) parts.push("Run started.");
  if (next.paid && (fresh || !prev.paid)) parts.push(`Payment settled: ${usd4(job.paidUsd ?? 0)} USDC.`);

  if (next.phase === "done") {
    if (fresh || prev.phase !== "done") {
      const took = job.actualSeconds !== null ? ` in ${duration(job.actualSeconds)}` : "";
      parts.push(`Run finished. Model trained${took}${job.paidUsd !== null ? ` for ${usd4(job.paidUsd)}` : ""}.`);
    }
  } else if (next.phase === "failed") {
    if (fresh || prev.phase !== "failed") {
      parts.push(`Run failed ${failedWhere(job)}. ${sentence(job.error?.trim() || "The run failed")}`);
    }
  } else if (fresh || next.stage !== prev.stage) {
    parts.push(`Stage ${next.stage + 1} of ${STAGES.length}: ${STAGES[next.stage]}.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
