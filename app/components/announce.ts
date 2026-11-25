import type { MarketRunView } from "@/lib/market/run";
import { usd4 } from "./format";
import { endState, sentence } from "./market-copy";
import { MARKET_STAGES, marketStage } from "./stages";

/** What the live region remembers about a run between polls. */
export type MarketMark = { id: string; phase: MarketRunView["phase"]; stage: number; paid: boolean };

export function marketMark(run: MarketRunView): MarketMark {
  return { id: run.id, phase: run.phase, stage: marketStage(run), paid: run.payment !== null };
}

const ENDED = new Set<MarketRunView["phase"]>(["released", "failed", "refused"]);

/**
 * The sentence a screen reader hears when a poll changes the run, or null when nothing worth saying
 * changed. Only milestones: a run starting, each new stage, the approval stop, the payment, the machine
 * ready and destroyed, and how a run ended. The per-second meter drain never is. The first snapshot
 * after a page load is a baseline, so reloading on a finished run says nothing.
 */
export function marketAnnouncement(prev: MarketMark | null | undefined, run: MarketRunView | null): string | null {
  if (!run || prev === undefined) return null;
  const next = marketMark(run);
  const fresh = prev === null || prev.id !== next.id;
  if (!fresh && prev.phase === next.phase && prev.stage === next.stage && prev.paid === next.paid) return null;
  const changed = fresh || prev.phase !== next.phase;

  const parts: string[] = [];
  if (fresh && !ENDED.has(next.phase)) parts.push("Run started.");
  if (next.paid && (fresh || !prev.paid)) parts.push(`Payment sent: ${usd4(run.payment?.usd ?? 0)} USDC.`);

  if (next.phase === "released") {
    if (changed) parts.push(`Machine destroyed.${run.payment ? ` Spent ${usd4(run.payment.usd)}.` : ""}`);
  } else if (next.phase === "refused") {
    if (changed) parts.push(endState(run)?.sentence ?? "Stopped before paying.");
  } else if (next.phase === "failed") {
    if (changed) parts.push(`Run failed. ${sentence(run.error?.trim() || "The run failed")}`);
  } else {
    if (fresh || next.stage !== prev.stage) parts.push(`Stage ${next.stage + 1} of ${MARKET_STAGES.length}: ${MARKET_STAGES[next.stage]}.`);
    if (next.phase === "approval" && changed && run.approval) {
      parts.push(`Waiting for your approval to pay ${usd4(run.approval.usd)} ${run.approval.token} for ${run.approval.plan}.`);
    }
    if (next.phase === "ready" && changed) parts.push(`Machine ready${run.machine?.ip ? ` at ${run.machine.ip}` : ""}.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
