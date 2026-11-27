"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MarketRunView } from "@/lib/market/run";
import { ActionError, type Post } from "./ActionError";
import { ApprovalBar } from "./ApprovalBar";
import { RevokeApproval } from "./RevokeApproval";
import { MachinePanel, type Send } from "./MachinePanel";
import { MarketPrices } from "./MarketPrices";
import { PHASE_HEADING, endState, fallbackLine, panelBody, sentence } from "./market-copy";
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
        <h2 id="stages-label" className="mb-4 text-[16px] leading-[22px] font-semibold text-foreground">
          What happens when you start
        </h2>
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
/** Phases in which market prices may still be on their way (the run fills them a moment after it has ranked plans). */
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
  compare,
  preview,
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
  /**
   * The prices compared from the form, when open: shown in place of the intro while there is no run, and
   * in place of an ended run's body when that run needs nothing more (that block carries "Back to the last
   * run"); under the body of an ended run that still does (a machine, a payment). Never over a run in flight.
   */
  compare?: ReactNode;
  /** While there is no run: the plans that fit the form's filters, kept current by the page. */
  preview?: ReactNode;
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
    // At narrow widths the heading can be far from the control that was pressed: bring it to the top, without animating.
    headingRef.current.scrollIntoView({ block: "start", behavior: "auto" });
    headingRef.current.focus({ preventScroll: true });
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

  const body = panelBody(run, !!compare);
  if (body === "compare") return <div className="space-y-6">{compare}</div>;
  if (!run) {
    return (
      <div className="space-y-6">
        <StageRow run={null} />
        {/* The list of plans carries its own line on what happens next; the longer explanation stands in only while there is no list. */}
        {preview ?? (
          <p className="max-w-[56ch] text-muted">
            Your agent reads the seller&apos;s price list, keeps the plans that fit your machine and your limits, asks for firm quotes on the cheapest
            few, and stops to show you the exact payment. After you pay, it shows the machine and destroys it when the time is up.
          </p>
        )}
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
  // Once the money is out, the table is history: the lead line stays and the table opens on request.
  const prices = (
    <MarketPrices
      key={run.id}
      prices={run.prices}
      loading={run.prices === null && PRICES_PENDING.has(run.phase)}
      heading="h3"
      foldable={run.payment !== null}
    />
  );

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

      {/* Why this plan, when the lowest quote was shared. */}
      {run.choice && <p className="max-w-[64ch] text-foreground">{run.choice}</p>}

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

      {/* The wider market: between the plan table and the next block, except at the approval stop, where it sits
          under Pay and Cancel so nothing above the Pay button can grow when the prices land. */}
      {run.phase !== "approval" && prices}

      {run.phase === "approval" && <ApprovalBar run={run} walletReady={walletReady[run.market]} post={post} onFocusNext={setFocusNext} />}

      {run.phase === "approval" && prices}

      {run.phase === "paying" && !run.payment && run.approval && (
        <p className="border-l-2 border-foreground pl-3 text-foreground tabular-nums">
          Paying {run.approval.exact} {run.approval.token} over x402 on {run.approval.network}. Your agent signs once and never pays twice for this run.
        </p>
      )}

      <MachinePanel run={run} nowMs={nowMs} send={send} headingRef={machineHeadingRef} onFocusNext={setFocusNext} />

      {/* A wallet-funded run that ended without a confirmed payment may have left an approval behind. */}
      {run.wallet && run.walletApproved && run.spent !== "paid" && (run.phase === "failed" || run.phase === "refused" || run.phase === "released") && <RevokeApproval key={run.id} run={run} />}

      {/* An ended run that still needs the owner keeps Destroy now and its money message in view; the comparison goes under it. */}
      {body === "run+compare" && compare}
    </div>
  );
}
