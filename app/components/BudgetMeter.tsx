"use client";

import { useState } from "react";
import type { MarketRunView } from "@/lib/market/run";
import type { MarketId } from "@/lib/market/types";
import { duration, usd2, usd4 } from "./format";
import { endState, hoursText, solscanUrl, timeLeft, type EndState } from "./market-copy";
import { budgetShare, jobGauge, leadingZeros, meterView, shareText, type JobGauge, type MeterJob, type MeterView } from "./meter-model";

/** 40 segments from 640px up, 24 below so each segment stays a readable width. */
const SEGMENTS_WIDE = 40;
const SEGMENTS_NARROW = 24;

const CONDENSED = { fontStretch: "68%", fontVariationSettings: '"wdth" 68' } as const;

type Readout = { label: string; value: string; quiet?: boolean };

/** Before there is a price the meter is the allowance being typed (or the one an unpaid run kept). */
function walletReadout(v: MeterView): Readout {
  switch (v.phase) {
    case "searching":
      return { label: "Your agent is comparing prices", value: `limit ${usd2(v.rateUsdHr)} an hour`, quiet: true };
    case "failed":
    case "refused":
    case "released":
      return { label: "Nothing spent", value: "$0.00" };
    default:
      return { label: "Limit", value: `${usd2(v.rateUsdHr)} an hour`, quiet: true };
  }
}

/** Zoomed to the rental, the readout is machine time: what the quote buys, what is left, how long it ran. */
function jobReadout(v: MeterView, j: JobGauge): Readout {
  if (j.state === "quoted") return { label: "Buys machine time", value: v.quotedHours !== null ? hoursText(v.quotedHours) : usd4(j.scaleUsd) };
  if (j.state === "draining") {
    if (j.leftUsd <= 0) return { label: "Paid time", value: "used up", quiet: true };
    return j.secondsLeft !== null ? { label: "Destroyed in", value: timeLeft(j.secondsLeft) } : { label: "Paid", value: usd4(j.scaleUsd) };
  }
  if (v.ranSeconds !== null) return { label: "Machine ran for", value: v.ranSeconds >= 3600 ? timeLeft(v.ranSeconds) : duration(v.ranSeconds) };
  return { label: "Spent", value: usd4(j.scaleUsd) };
}

/** How the run ended, frozen under the gauge: what happened, then what to do. */
function EndLine({ e }: { e: EndState }) {
  return (
    <div className="mt-4 space-y-0.5">
      <p className={`max-w-[72ch] ${e.tone === "bad" ? "text-bad" : "font-medium text-foreground"}`}>{e.sentence}</p>
      {e.next && <p className="max-w-[72ch] text-muted">{e.next}</p>}
    </div>
  );
}

/** The 8px amber legend square that ties a figure to the amber slot in the gauge. */
export function Swatch() {
  return <span aria-hidden className="inline-block size-2 shrink-0 rounded-[1px] bg-amber" />;
}

function Segments({ n, className }: { n: number; className: string }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={`h-full flex-1 rounded-[1px] ${className}`} />
      ))}
    </>
  );
}

/** The allowance: ink segments for what is left of the budget being typed. */
function WalletGauge({ v, segments, className }: { v: MeterView; segments: number; className: string }) {
  const ink = Math.round(budgetShare(v.remainingUsd, v.budgetUsd) * segments);
  return (
    <div role="img" aria-label={`${usd4(v.remainingUsd)} of ${usd2(v.budgetUsd)} left`} className={`h-[14px] gap-[3px] ${className}`}>
      <Segments n={ink} className="bg-foreground" />
      <Segments n={segments - ink} className="bg-segment" />
    </div>
  );
}

/**
 * The job: a full amber gauge is the paid amount (or the quote). The amber layer is clipped from the
 * right as the server burns it, one linear second per tick so the drain is continuous between polls;
 * when the run ends the remainder collapses to $0 in one quick ease-out, the shutdown. Clipping keeps
 * the last partial segment honest and animates without layout. Reduced motion steps instead.
 */
function JobGaugeBar({ j, segments, className }: { j: JobGauge; segments: number; className: string }) {
  const timing =
    j.state === "shut"
      ? "motion-safe:duration-700 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]"
      : "motion-safe:duration-1000 motion-safe:ease-linear";
  return (
    <div role="img" aria-label={j.state === "quoted" ? `This rental will use ${usd4(j.scaleUsd)}` : `Machine time left ${usd4(j.leftUsd)} of ${usd4(j.scaleUsd)}`} className={`relative h-[14px] ${className}`}>
      <div className="flex h-full gap-[3px]">
        <Segments n={segments} className="bg-segment" />
      </div>
      <div
        className={`absolute inset-0 flex gap-[3px] motion-safe:transition-[clip-path] ${timing}`}
        style={{ clipPath: `inset(0 ${(1 - Math.min(1, Math.max(0, j.fill))) * 100}% 0 0)` }}
      >
        <Segments n={segments} className="bg-amber" />
      </div>
    </div>
  );
}

/**
 * The payment moment: once x402 settles, the meter says where the money in the gauge came from and links
 * the transaction. When this page watched the job go from unpaid to paid, the line is written on from the
 * left (a clip-path wipe, like a receipt printing); reloading on a paid job shows it still. Reduced motion
 * gets a short fade instead.
 */
function PaymentLine({ usd, solscan, market, fresh }: { usd: number; solscan: string | null; market: MarketId; fresh: boolean }) {
  return (
    <p className={`text-[12px] leading-4 text-muted tabular-nums ${fresh ? "settle-in" : ""}`}>
      Paid <span className="font-medium text-foreground">{usd4(usd)}</span> over x402, settled on Solana {market === "real" ? "mainnet" : "devnet"}.
      {solscan && (
        <>
          {" "}
          <a href={solscan} target="_blank" rel="noreferrer">
            See it on Solscan
          </a>
        </>
      )}
    </p>
  );
}

function ReadoutBlock({ r }: { r: Readout }) {
  return (
    <div className="mt-3 sm:mt-0 sm:text-right">
      <p className="text-[12px] leading-4 text-muted">{r.label}</p>
      <p
        className={`text-[20px] leading-[26px] tabular-nums ${r.quiet ? "font-normal text-muted" : "font-semibold text-foreground"}`}
        style={r.quiet ? undefined : CONDENSED}
      >
        {r.value}
      </p>
    </div>
  );
}

/**
 * The allowance under the job gauge, at its honest proportion: ink for what is left, the job's slice in
 * amber as a hairline (never a whole segment). While quotes are coming in it shows with no slice yet, so
 * the meter is already its job-mode height and does not grow when the first quote lands.
 */
function Allowance({ who, leftUsd, budgetUsd, share, note }: { who: string; leftUsd: number; budgetUsd: number; share: number | null; note: string }) {
  return (
    <div className="mt-5">
      <div
        role="img"
        aria-label={`${who} has ${usd4(leftUsd)} of ${usd2(budgetUsd)} left${share !== null ? `; this rental is ${shareText(share)} of it` : ""}`}
        className="flex h-[3px] w-full overflow-hidden rounded-[1px] bg-segment"
      >
        <span className="h-full bg-foreground" style={{ width: `${budgetShare(leftUsd, budgetUsd) * 100}%` }} />
        {share !== null && <span className="h-full shrink-0 bg-amber" style={{ width: `max(1px, ${share * 100}%)` }} />}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 text-[12px] leading-4 text-muted tabular-nums">
        <p>
          {who} has <span className="text-foreground">{usd4(leftUsd)}</span> of {usd2(budgetUsd)} left
        </p>
        <p>{note}</p>
      </div>
    </div>
  );
}

export function BudgetMeter(props: {
  agentName: string | null;
  formBudgetUsd: number;
  formRateUsdHr: number;
  job: (MeterJob & Pick<MarketRunView, "id" | "market" | "leftOut">) | null;
  /** ms, the server's clock */
  nowMs: number;
}) {
  // Remember a run this meter saw before it was paid, so the payment line animates only when it settles here.
  const [unpaidId, setUnpaidId] = useState<string | null>(null);
  const jobId = props.job?.id ?? null;
  if (jobId !== null && props.job?.payment === null && unpaidId !== jobId) setUnpaidId(jobId);
  const freshPayment = jobId !== null && unpaidId === jobId;

  const v = meterView({
    formBudgetUsd: props.formBudgetUsd,
    formRateUsdHr: props.formRateUsdHr,
    job: props.job,
    nowMs: props.nowMs,
  });
  const j = jobGauge(v);
  const who = props.agentName?.trim() || "Your agent";
  const ended = props.job ? endState(props.job) : null;

  if (!j) {
    const r = walletReadout(v);
    // Fuel-pump amount: cents in ink at full size, the last two decimals smaller and muted.
    const amount = usd4(v.remainingUsd);
    return (
      <section aria-label="Budget meter" className="rounded-[6px] bg-surface px-5 py-5 sm:px-7 sm:py-6">
        <p className="text-[13.5px] leading-5 font-medium text-foreground">Budget left for {props.agentName?.trim() || "your agent"}</p>
        <div className="mt-2 flex flex-col sm:flex-row sm:items-baseline-last sm:justify-between sm:gap-x-6">
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-[56px] leading-none font-semibold tracking-[-0.01em] tabular-nums text-foreground" style={CONDENSED}>
              <span className="sr-only">{amount}</span>
              <span aria-hidden>
                {amount.slice(0, -2)}
                <span className="text-[0.6em] text-muted">{amount.slice(-2)}</span>
              </span>
            </span>
            <span className="text-[20px] leading-[26px] text-muted tabular-nums">of {usd2(v.budgetUsd)}</span>
          </p>
          <ReadoutBlock r={r} />
        </div>
        <WalletGauge v={v} segments={SEGMENTS_WIDE} className="mt-4 hidden sm:flex" />
        <WalletGauge v={v} segments={SEGMENTS_NARROW} className="mt-4 flex sm:hidden" />
        <div className="mt-2 flex items-baseline justify-between gap-x-6 text-[12px] leading-4 text-muted tabular-nums">
          <p>$0</p>
          <p>{usd2(v.budgetUsd)}</p>
        </div>
        {v.phase === "searching" && <Allowance who={who} leftUsd={v.remainingUsd} budgetUsd={v.budgetUsd} share={null} note="Waiting for a firm quote" />}
        {ended && <EndLine e={ended} />}
      </section>
    );
  }

  // Zoomed to the rental. The big figure is paid machine time left; its leading zeros are muted so the
  // digits that move are the ones in ink. The allowance stays underneath at its real proportion.
  const r = jobReadout(v, j);
  const amount = usd4(j.leftUsd);
  const [lead, digits] = leadingZeros(amount);
  const shut = j.state === "shut";
  const jobUsd = j.scaleUsd;
  // Before payment the quote is carved out of the allowance; after it, the payment already left it.
  const allowanceLeft = j.state === "quoted" ? v.budgetUsd - jobUsd : v.remainingUsd;
  const share = budgetShare(jobUsd, v.budgetUsd);
  const solscan = props.job?.payment?.tx ? solscanUrl(props.job.payment.tx, props.job.market) : null;
  const used = v.usedUsd ?? 0;

  return (
    <section aria-label="Budget meter" className="rounded-[6px] bg-surface px-5 py-5 sm:px-7 sm:py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="flex items-center gap-2 text-[13.5px] leading-5 font-medium text-foreground">
          {!shut && <Swatch />}
          {j.state === "quoted" ? "This rental will use" : "Machine time left"}
        </p>
        {v.paidUsd !== null && v.paidUsd > 0 && props.job && <PaymentLine usd={v.paidUsd} solscan={solscan} market={props.job.market} fresh={freshPayment} />}
      </div>
      <div className="mt-2 flex flex-col sm:flex-row sm:items-baseline-last sm:justify-between sm:gap-x-6">
        <p className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-[56px] leading-none font-semibold tracking-[-0.01em] tabular-nums" style={CONDENSED}>
            <span className="sr-only">{amount}</span>
            <span aria-hidden>
              <span className="text-muted">{lead}</span>
              <span className="text-foreground">{digits}</span>
            </span>
          </span>
          <span className="text-[20px] leading-[26px] text-muted tabular-nums">
            {/* The payment line above names the amount paid; here it is only the scale. */}
            {j.state === "quoted" ? "quoted, not paid yet" : `of ${usd4(jobUsd)}`}
          </span>
        </p>
        <ReadoutBlock r={r} />
      </div>

      <JobGaugeBar j={j} segments={SEGMENTS_WIDE} className="mt-4 hidden sm:block" />
      <JobGaugeBar j={j} segments={SEGMENTS_NARROW} className="mt-4 block sm:hidden" />

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 text-[12px] leading-4 tabular-nums">
        {/* The release lands here, where the drain ends: the label turns to ink once the amber is gone. */}
        <p
          className={`motion-safe:transition-colors motion-safe:duration-300 ${shut ? "font-medium text-foreground motion-safe:delay-500" : "text-muted"}`}
        >
          {j.state === "quoted"
            ? "$0"
            : shut
              ? v.phase === "released"
                ? `Spent ${usd4(jobUsd)}, machine destroyed`
                : `Spent ${usd4(jobUsd)}`
              : "$0, machine is destroyed"}
        </p>
        <p className="text-muted">
          {j.state === "quoted" ? `This rental: ${usd4(jobUsd)}` : j.state === "draining" ? `Time used ${usd4(used)} of ${usd4(jobUsd)}` : usd4(jobUsd)}
        </p>
      </div>

      {/* The allowance at its honest proportion: the rental's slice is a hairline, never a whole segment. */}
      <Allowance who={who} leftUsd={allowanceLeft} budgetUsd={v.budgetUsd} share={share} note={`This rental is ${shareText(share)} of the budget`} />
      {ended && <EndLine e={ended} />}
    </section>
  );
}
