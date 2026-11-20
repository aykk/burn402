import { meterView, type MeterJob, type MeterView } from "./meter-model";

/** 40 segments from 640px up, 24 below so each segment stays a readable width. */
const SEGMENTS_WIDE = 40;
const SEGMENTS_NARROW = 24;

/** Displayed amounts never go below zero or show NaN. */
const safe = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
const usd4 = (n: number) => `$${safe(n).toFixed(4)}`;
const usd2 = (n: number) => `$${safe(n).toFixed(2)}`;

/**
 * Split the gauge into ink (left), amber (the money this job uses) and empty segments. Before payment
 * the quote is carved out of what remains. Once paid, the paid slice keeps at least one segment right of
 * the ink, and `fill` is how much of it the server has not burned yet: it drains while the run is live
 * and is empty once the run ends, so the finished gauge shows the spent money as a hole beside the ink.
 */
function gauge(v: MeterView, segments: number): { ink: number; amber: number; fill: number } {
  const budget = v.budgetUsd;
  if (!(budget > 0)) return { ink: 0, amber: 0, fill: 0 };
  const share = (usd: number) => (Number.isFinite(usd) ? Math.min(1, Math.max(0, usd / budget)) : 0);
  const remainingN = Math.round(share(v.remainingUsd) * segments);
  const slots = (usd: number) => Math.min(segments, Math.max(1, Math.round(share(usd) * segments)));

  if (v.paidUsd !== null && v.paidUsd > 0) {
    const amber = slots(v.paidUsd);
    const ink = Math.min(remainingN, segments - amber);
    const left = v.phase === "running" && v.burnedUsd !== null ? 1 - Math.min(1, Math.max(0, v.burnedUsd / v.paidUsd)) : 0;
    return { ink, amber, fill: Number.isFinite(left) ? left : 0 };
  }
  // A failed run with nothing paid shows no amber.
  const quoted = v.phase === "failed" || v.phase === "done" ? null : v.quotedUsd;
  if (quoted !== null && quoted > 0) {
    const amber = slots(quoted);
    const ink = Math.max(0, Math.min(segments - amber, remainingN - amber));
    return { ink, amber, fill: 1 };
  }
  return { ink: Math.min(segments, remainingN), amber: 0, fill: 0 };
}

/** The two-line readout right of the amount: a muted label over the figure it names. */
function readout(v: MeterView): { label: string; value: string; swatch: boolean; quiet?: boolean } {
  switch (v.phase) {
    case "ready":
      return { label: "Limit", value: `${usd2(v.rateUsdHr)} an hour`, swatch: false, quiet: true };
    case "negotiating":
      return v.quotedUsd !== null
        ? { label: "This job will use", value: usd4(v.quotedUsd), swatch: true }
        : { label: "Your agent is getting quotes", value: `limit ${usd2(v.rateUsdHr)} an hour`, swatch: false, quiet: true };
    case "running":
      if (v.paidUsd !== null) return { label: "Server time used", value: `${usd4(v.burnedUsd ?? 0)} of ${usd4(v.paidUsd)}`, swatch: true };
      return v.quotedUsd !== null
        ? { label: "This job will use", value: usd4(v.quotedUsd), swatch: true }
        : { label: "Limit", value: `${usd2(v.rateUsdHr)} an hour`, swatch: false, quiet: true };
    case "done":
      return v.paidUsd !== null
        ? { label: "Spent, server shut down", value: usd4(v.paidUsd), swatch: true }
        : { label: "Nothing spent", value: "$0.00", swatch: false };
    case "failed":
      // A run that failed after paying still spent the money.
      return v.paidUsd !== null ? { label: "Spent", value: usd4(v.paidUsd), swatch: true } : { label: "Nothing spent", value: "$0.00", swatch: false };
  }
}

/** The 8px amber legend square that ties a figure to the amber slot in the gauge. */
export function Swatch() {
  return <span aria-hidden className="inline-block size-2 shrink-0 rounded-[1px] bg-amber" />;
}

function Gauge({ v, segments, className }: { v: MeterView; segments: number; className: string }) {
  const g = gauge(v, segments);
  return (
    <div role="img" aria-label={`${usd4(v.remainingUsd)} of ${usd2(v.budgetUsd)} left`} className={`h-[14px] gap-[3px] ${className}`}>
      {Array.from({ length: segments }, (_, i) => {
        if (i < g.ink) return <span key={i} className="h-full flex-1 rounded-[1px] bg-foreground" />;
        if (i < g.ink + g.amber) {
          // The unburned share of the paid slice, spread left to right across the amber slots.
          const k = i - g.ink;
          const part = Math.min(1, Math.max(0, g.fill * g.amber - k));
          return (
            <span key={i} className="relative h-full flex-1 overflow-hidden rounded-[1px] bg-segment">
              <span
                className="absolute inset-y-0 left-0 bg-amber motion-safe:transition-[width] motion-safe:duration-1000 motion-safe:ease-linear"
                style={{ width: `${part * 100}%` }}
              />
            </span>
          );
        }
        return <span key={i} className="h-full flex-1 rounded-[1px] bg-segment" />;
      })}
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
  const r = readout(v);
  const who = props.agentName?.trim() || "Your agent";
  // Fuel-pump amount: cents in ink at full size, the last two decimals smaller and muted.
  const amount = usd4(v.remainingUsd);
  const whole = amount.slice(0, -2);
  const fine = amount.slice(-2);

  return (
    <section aria-label="Budget meter" className="rounded-[6px] bg-surface px-5 py-5 sm:px-7 sm:py-6">
      <p className="text-[13.5px] leading-5 font-medium text-foreground">{who} has left</p>

      {/* Amount on the left; the readout's last line sits on the amount's baseline (below it under 640px). */}
      <div className="mt-2 flex flex-col sm:flex-row sm:items-baseline-last sm:justify-between sm:gap-x-6">
        <p className="flex flex-wrap items-baseline gap-x-3">
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
        <div className="mt-3 sm:mt-0 sm:text-right">
          <p className="text-[12px] leading-4 text-muted">{r.label}</p>
          <p className="flex items-center gap-2 sm:justify-end">
            {r.swatch && <Swatch />}
            <span
              className={`text-[20px] leading-[26px] tabular-nums ${r.quiet ? "font-normal text-muted" : "font-semibold text-foreground"}`}
              style={r.quiet ? undefined : { fontStretch: "68%", fontVariationSettings: '"wdth" 68' }}
            >
              {r.value}
            </span>
          </p>
        </div>
      </div>

      <Gauge v={v} segments={SEGMENTS_WIDE} className="mt-4 hidden sm:flex" />
      <Gauge v={v} segments={SEGMENTS_NARROW} className="mt-4 flex sm:hidden" />

      <div className="mt-2 flex items-baseline justify-between gap-x-6 text-[12px] leading-4 text-muted tabular-nums">
        <p>$0, server shuts down</p>
        <p>{usd2(v.budgetUsd)}</p>
      </div>
    </section>
  );
}
