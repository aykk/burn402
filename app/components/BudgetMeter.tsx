import { meterView, type MeterJob, type MeterView } from "./meter-model";

/** 40 segments from 640px up, 24 below so each segment stays a readable width. */
const SEGMENTS_WIDE = 40;
const SEGMENTS_NARROW = 24;

/** Displayed amounts never go below zero or show NaN. */
const safe = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
const usd4 = (n: number) => `$${safe(n).toFixed(4)}`;
const usd2 = (n: number) => `$${safe(n).toFixed(2)}`;

/** Split the gauge into ink and amber segment counts; the rest are empty. Proportions only. */
function gauge(v: MeterView, segments: number): { ink: number; amber: number } {
  const budget = v.budgetUsd;
  if (!(budget > 0)) return { ink: 0, amber: 0 };
  const share = (usd: number) => (Number.isFinite(usd) ? Math.min(1, Math.max(0, usd / budget)) : 0);
  const remainingN = Math.round(share(v.remainingUsd) * segments);

  // Amber = what was paid, or what the quote says this job will use before payment.
  // A failed run with nothing paid shows no amber.
  const amberUsd = v.paidUsd ?? (v.phase === "failed" ? null : v.quotedUsd);
  let amber = 0;
  if (amberUsd !== null && amberUsd > 0) amber = Math.max(1, Math.round(share(amberUsd) * segments));

  // Before payment the quote is part of what remains; after payment it sits beside it.
  const ink = Math.min(segments, v.paidUsd === null ? Math.max(0, remainingN - amber) : remainingN);
  return { ink, amber: Math.min(amber, segments - ink) };
}

function status(v: MeterView): string | null {
  switch (v.phase) {
    case "ready":
      return null;
    case "negotiating":
      return v.quotedUsd !== null ? `This job will use ${usd4(v.quotedUsd)}` : "Your agent is getting quotes";
    case "running":
      if (v.paidUsd !== null && v.burnedUsd !== null) return `Server time used ${usd4(v.burnedUsd)} of ${usd4(v.paidUsd)}`;
      return v.quotedUsd !== null ? `This job will use ${usd4(v.quotedUsd)}` : null;
    case "done":
      return v.paidUsd !== null ? `Spent ${usd4(v.paidUsd)}` : null;
    case "failed":
      // A run that failed after paying still spent the money.
      return v.paidUsd !== null ? `Spent ${usd4(v.paidUsd)}` : null;
  }
}

function Gauge({ v, segments, className }: { v: MeterView; segments: number; className: string }) {
  const g = gauge(v, segments);
  return (
    <div role="img" aria-label={`${usd4(v.remainingUsd)} of ${usd2(v.budgetUsd)} left`} className={`h-[14px] gap-[3px] ${className}`}>
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={`h-full flex-1 rounded-[1px] motion-safe:transition-colors motion-safe:duration-300 ${
            i < g.ink ? "bg-foreground" : i < g.ink + g.amber ? "bg-amber" : "bg-segment"
          }`}
        />
      ))}
    </div>
  );
}

export function BudgetMeter(props: {
  agentName: string | null;
  formBudgetUsd: number;
  formRateUsdHr: number;
  job: MeterJob | null;
  nowSec: number;
}) {
  const v = meterView({
    formBudgetUsd: props.formBudgetUsd,
    formRateUsdHr: props.formRateUsdHr,
    job: props.job,
    nowSec: props.nowSec,
  });
  const right = status(v);
  const who = props.agentName?.trim() || "Your agent";
  // Fuel-pump amount: cents in ink at full size, the last two decimals smaller and muted.
  const amount = usd4(v.remainingUsd);
  const whole = amount.slice(0, -2);
  const fine = amount.slice(-2);

  return (
    <section aria-label="Budget meter" className="rounded-[6px] bg-surface px-5 py-5 sm:px-7 sm:py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-[13.5px] leading-5">
        <p className="font-medium text-foreground">{who} has left</p>
        {right ? (
          <p className="tabular-nums text-foreground">{right}</p>
        ) : (
          <p className="tabular-nums text-muted">limit {usd2(v.rateUsdHr)} an hour</p>
        )}
      </div>

      <p className="mt-2 flex flex-wrap items-baseline gap-x-3">
        <span
          className="text-[56px] leading-none font-semibold tracking-[-0.01em] tabular-nums text-foreground"
          style={{ fontStretch: "68%", fontVariationSettings: '"wdth" 68' }}
        >
          <span className="sr-only">{amount}</span>
          <span aria-hidden>
            {whole}
            <span className="text-[0.6em] text-muted">{fine}</span>
          </span>
        </span>
        <span className="text-[20px] leading-[26px] text-muted tabular-nums">of {usd2(v.budgetUsd)}</span>
      </p>

      <Gauge v={v} segments={SEGMENTS_WIDE} className="mt-4 hidden sm:flex" />
      <Gauge v={v} segments={SEGMENTS_NARROW} className="mt-4 flex sm:hidden" />

      <div className="mt-2 flex items-baseline justify-between gap-x-6 text-[12px] leading-4 text-muted tabular-nums">
        <p>$0, server shuts down</p>
        <p>{usd2(v.budgetUsd)}</p>
      </div>

      {v.phase === "failed" && (
        <div role="alert" className="mt-4 space-y-0.5 text-[13.5px]">
          <p className="text-bad">{v.error?.trim() || "The run failed."}</p>
          <p className="text-foreground">Check the job details, then start the run again.</p>
        </div>
      )}
    </section>
  );
}
