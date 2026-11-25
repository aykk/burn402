"use client";

import { useState } from "react";
import type { MarketRunView } from "@/lib/market/run";
import { ActionError, type Post } from "./ActionError";
import { ApprovalBar } from "./ApprovalBar";
import { usd4 } from "./format";
import { MachinePanel } from "./MachinePanel";
import { PHASE_HEADING, endState } from "./market-copy";
import { OffersTable } from "./OffersTable";
import { MARKET_STAGES, marketStage } from "./stages";
import { TEXT_BTN } from "./ui";

type StageState = "done" | "now" | "next" | "failed" | "stopped";

/** A 10px drawn check for finished stages, in the label's ink. */
function Check() {
  return (
    <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" className="shrink-0" fill="none">
      <path d="M1.5 5.2 4 7.6 8.5 2.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Scan, Choose, Pay, Machine. Upcoming stages are dashed, finished ones a thin ink bar with a check, the
 * current one a thick ink bar. A failed run's stage is thick red; a run stopped before paying (cancelled,
 * refused by the payment check, nothing fits) is thick ink with "stopped here", since nothing went wrong.
 */
function StageRow({ run }: { run: MarketRunView | null }) {
  const at = run ? marketStage(run) : -1;
  const end = run?.phase === "failed" ? "failed" : run?.phase === "refused" ? "stopped" : null;
  const state = (i: number): StageState => (i < at ? "done" : i > at ? "next" : (end ?? "now"));
  return (
    <div>
      {!run && (
        <p id="stages-label" className="mb-2 text-[12px] leading-4 font-medium text-foreground">
          What happens when you start
        </p>
      )}
      <ol aria-label={run ? "Run stages" : undefined} aria-labelledby={run ? undefined : "stages-label"} className="grid grid-cols-4 gap-[3px]">
        {MARKET_STAGES.map((label, i) => {
          const s = state(i);
          return (
            <li key={label} aria-current={s === "now" ? "step" : undefined} className="min-w-0">
              <span className="flex h-[5px] items-end" aria-hidden>
                <span
                  className={`block w-full ${
                    s === "now" || s === "stopped"
                      ? "h-[5px] bg-foreground"
                      : s === "failed"
                        ? "h-[5px] bg-bad"
                        : s === "done"
                          ? "h-[2px] bg-foreground"
                          : "h-0 border-t-2 border-dashed border-rule-strong"
                  }`}
                />
              </span>
              <span
                className={`mt-1.5 flex items-center gap-1 truncate text-[12px] leading-4 ${
                  s === "now" || s === "stopped"
                    ? "font-semibold text-foreground"
                    : s === "failed"
                      ? "font-semibold text-bad"
                      : s === "done"
                        ? "font-medium text-foreground"
                        : "font-medium text-muted"
                }`}
              >
                {s === "done" && <Check />}
                <span className="truncate">{label}</span>
                {(s === "failed" || s === "stopped") && <span className="sr-only">, stopped here</span>}
                {s === "done" && <span className="sr-only">, finished</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const BEFORE_PAYING = new Set<MarketRunView["phase"]>(["scanning", "choosing", "quoting"]);

/**
 * The right column: the stage row, what the run is doing, the plans compared, the approval stop, the
 * machine, and how the run ended.
 */
export function MarketPanel({ run, nowMs, walletReady, post }: { run: MarketRunView | null; nowMs: number; walletReady: { test: boolean; real: boolean }; post: Post }) {
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  if (!run) {
    return (
      <div className="space-y-6">
        <StageRow run={null} />
        <p className="max-w-[56ch] text-muted">
          Your agent reads the seller&apos;s price list, keeps the plans that fit your machine and your limits, asks for firm quotes on the cheapest
          few, and stops to show you the exact payment. After you pay, it shows the machine and destroys it when the time is up.
        </p>
      </div>
    );
  }

  const ended = endState(run);
  const stop = async () => {
    setStopError(null);
    setStopping(true);
    setStopError(await post("/api/market/destroy", { run: run.id }));
    setStopping(false);
  };
  const heading = ended ? ended.title : PHASE_HEADING[run.phase];

  return (
    <div className="space-y-6">
      <StageRow run={run} />

      <div>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-[16px] leading-[22px] font-semibold text-foreground">{heading}</h2>
          {BEFORE_PAYING.has(run.phase) && (
            <button type="button" className={`text-[12px] leading-4 ${TEXT_BTN}`} disabled={stopping} onClick={() => void stop()}>
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
        </div>
        <p className="mt-0.5 text-[12px] leading-4 text-muted" title={`Agent ${run.agent.ansName}`}>
          {run.marketLabel}
        </p>
        {ended && (
          <div className="mt-3 space-y-1">
            <p className={`max-w-[64ch] ${ended.tone === "bad" ? "text-bad" : "text-foreground"}`}>{ended.sentence}</p>
            {run.refusal && run.refusal.code !== "CANCELLED" && run.refusal.code !== "NOTHING_FITS" && (
              <p className="max-w-[64ch] text-[12px] leading-4 text-muted [overflow-wrap:anywhere]">{run.refusal.detail}</p>
            )}
          </div>
        )}
        <div className="mt-2">
          <ActionError what="The run didn't stop" message={stopError} onDismiss={() => setStopError(null)} />
        </div>
      </div>

      <OffersTable run={run} />

      {run.phase === "approval" && <ApprovalBar run={run} walletReady={walletReady[run.market]} post={post} />}

      {run.phase === "paying" && !run.payment && run.approval && (
        <p className="border-l-2 border-foreground pl-3 text-foreground tabular-nums">
          Paying {usd4(run.approval.usd)} {run.approval.token} over x402 on {run.approval.network}. Your agent signs once and never pays twice for this run.
        </p>
      )}

      <MachinePanel run={run} nowMs={nowMs} post={post} />
    </div>
  );
}
