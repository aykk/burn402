"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MarketRunView } from "@/lib/market/run";
import { ActionError, type Post } from "./ActionError";
import { ApprovalBar } from "./ApprovalBar";
import { MachinePanel, type Send } from "./MachinePanel";
import { MarketPrices } from "./MarketPrices";
import { PHASE_HEADING, endState, fallbackLine, sentence } from "./market-copy";
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
const ENDED = new Set<MarketRunView["phase"]>(["released", "failed", "refused"]);
/**
 * Phases in which market prices may still be on their way (the run fills them a moment after it has
 * ranked plans) and the approval bar can sit under them: the block keeps its place and height here.
 */
const PRICES_PENDING = new Set<MarketRunView["phase"]>(["scanning", "choosing", "quoting", "approval"]);
/** Refusals whose detail only repeats the end sentence above it. */
const SAID_ALREADY = new Set(["CANCELLED", "STOPPED", "NOTHING_FITS"]);

/** Where focus goes once the control that was pressed has gone: the machine block after Pay, the end heading after Cancel or Destroy. */
export type FocusNext = "machine" | "heading" | null;

/**
 * The right column: the stage row, what the run is doing, the plans compared, the approval stop, the
 * machine, and how the run ended.
 */
export function MarketPanel({
  run,
  nowMs,
  listed = true,
  focusSignal = 0,
  walletReady,
  post,
  send,
  idle,
}: {
  run: MarketRunView | null;
  nowMs: number;
  /** False once this run's payment was dismissed from open purchases. */
  listed?: boolean;
  /** Bumped when the owner starts a run: focus moves to the run's heading once it shows. */
  focusSignal?: number;
  walletReady: { test: boolean; real: boolean };
  post: Post;
  send: Send;
  /** Shown in place of the intro while there is no run (the prices compared from the form). */
  idle?: ReactNode;
}) {
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  // Set before Pay, Cancel or Destroy is sent and cleared if it fails, so focus never drops to the page when that control goes.
  const focusNext = useRef<FocusNext>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const machineHeadingRef = useRef<HTMLHeadingElement>(null);
  const setFocusNext = (next: FocusNext) => {
    focusNext.current = next;
  };
  const focusedSignal = useRef(focusSignal);
  useEffect(() => {
    if (focusSignal === focusedSignal.current || !headingRef.current) return;
    focusedSignal.current = focusSignal;
    headingRef.current.focus();
  });
  useEffect(() => {
    if (!focusNext.current || !run) return;
    if (focusNext.current === "machine" && machineHeadingRef.current) {
      machineHeadingRef.current.focus();
      focusNext.current = null;
    } else if (ENDED.has(run.phase) && headingRef.current) {
      headingRef.current.focus();
      focusNext.current = null;
    }
  });

  if (!run) {
    if (idle) return <div className="space-y-6">{idle}</div>;
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

  const ended = endState(run, { listed });
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
          <h2 ref={headingRef} tabIndex={-1} className="text-[16px] leading-[22px] font-semibold text-foreground focus:outline-none">
            {heading}
          </h2>
          {BEFORE_PAYING.has(run.phase) && (
            <button type="button" className={`text-[12px] leading-4 ${TEXT_BTN}`} disabled={stopping} onClick={() => void stop()}>
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
        </div>
        <p className="mt-0.5 text-[12px] leading-4 text-muted" title={`Agent ${run.agent.ansName}`}>
          {run.marketLabel}
        </p>
        {run.overspendTest && <p className="mt-1 font-medium text-foreground">This run was made by the overspend test, not by you.</p>}
        {ended && (
          <div className="mt-3 space-y-1">
            <p className={`max-w-[64ch] ${ended.tone === "bad" ? "text-bad" : "text-foreground"}`} title={run.refusal?.code}>
              {ended.sentence}
            </p>
            {run.refusal && run.refusal.detail.trim() && !SAID_ALREADY.has(run.refusal.code) && sentence(run.refusal.detail) !== ended.sentence && (
              <p className="max-w-[64ch] text-[12px] leading-4 text-muted [overflow-wrap:anywhere]" title={run.refusal.code}>
                {run.refusal.detail}
              </p>
            )}
          </div>
        )}
        <div className="mt-2">
          <ActionError what="The run didn't stop" message={stopError} onDismiss={() => setStopError(null)} />
        </div>
      </div>

      {(run.fallbacks ?? []).length > 0 && (
        <div className="space-y-0.5">
          {run.fallbacks.map((f, i) => (
            <p key={i} className="max-w-[64ch] text-foreground">
              {fallbackLine(f)}
            </p>
          ))}
        </div>
      )}

      <OffersTable run={run} />

      {/* The wider market before the approval stop. Before paying it holds its place and height while the prices
          are read, so the Pay button below never moves when they land. */}
      <MarketPrices
        key={run.id}
        prices={run.prices}
        loading={run.prices === null && PRICES_PENDING.has(run.phase)}
        heading="h3"
        reserve={PRICES_PENDING.has(run.phase) ? run.need.kind : null}
      />

      {run.phase === "approval" && <ApprovalBar run={run} walletReady={walletReady[run.market]} post={post} onFocusNext={setFocusNext} />}

      {run.phase === "paying" && !run.payment && run.approval && (
        <p className="border-l-2 border-foreground pl-3 text-foreground tabular-nums">
          Paying {run.approval.exact} {run.approval.token} over x402 on {run.approval.network}. Your agent signs once and never pays twice for this run.
        </p>
      )}

      <MachinePanel run={run} nowMs={nowMs} send={send} headingRef={machineHeadingRef} onFocusNext={setFocusNext} />
    </div>
  );
}
