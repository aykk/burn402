"use client";

import { HELP } from "./copy";
import { Help } from "./Help";
import { meterView, type MeterJob, type MeterView } from "./meter-model";

const SEGMENTS = 40;

const usd4 = (n: number) => `$${n.toFixed(4)}`;
const usd2 = (n: number) => `$${n.toFixed(2)}`;

/** Split the gauge into ink and amber segment counts; the rest are empty. Proportions only. */
function gauge(v: MeterView): { ink: number; amber: number } {
  const budget = v.budgetUsd;
  if (!(budget > 0)) return { ink: 0, amber: 0 };
  const share = (usd: number) => Math.min(1, Math.max(0, usd / budget));
  const remainingN = Math.round(share(v.remainingUsd) * SEGMENTS);

  // Amber = what was paid, or what the quote says this job will use before payment.
  // A failed run with nothing paid shows no amber.
  const amberUsd = v.paidUsd ?? (v.phase === "failed" ? null : v.quotedUsd);
  let amber = 0;
  if (amberUsd !== null && amberUsd > 0) amber = Math.max(1, Math.round(share(amberUsd) * SEGMENTS));

  // Before payment the quote is part of what remains; after payment it sits beside it.
  const ink = Math.min(SEGMENTS, v.paidUsd === null ? Math.max(0, remainingN - amber) : remainingN);
  return { ink, amber: Math.min(amber, SEGMENTS - ink) };
}

function footerRight(v: MeterView): string | null {
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
      return null;
  }
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
  const g = gauge(v);
  const right = footerRight(v);
  const who = props.agentName?.trim() || "Your agent";

  return (
    <section aria-label="Budget meter" className="rounded-[6px] bg-surface px-5 py-4 sm:px-6 sm:py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-[13.5px]">
        <p className="font-medium text-foreground">{who} has left</p>
        <p className="text-muted tabular-nums">limit {usd2(v.rateUsdHr)} an hour</p>
      </div>

      <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
        <span
          className="text-[40px] leading-none font-semibold tabular-nums text-foreground"
          style={{ fontStretch: "68%", fontVariationSettings: '"wdth" 68' }}
        >
          {usd4(v.remainingUsd)}
        </span>
        <span className="text-[16px] text-muted tabular-nums">of {usd2(v.budgetUsd)}</span>
        <Help id="meter-help-budget" label="About the budget" text={HELP.budget} />
      </p>

      <div
        role="img"
        aria-label={`${usd4(v.remainingUsd)} of ${usd2(v.budgetUsd)} left`}
        className="mt-4 flex h-6 gap-[2px]"
      >
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span
            key={i}
            className={`h-full flex-1 rounded-[1px] motion-safe:transition-colors motion-safe:duration-300 ${
              i < g.ink ? "bg-foreground" : i < g.ink + g.amber ? "bg-amber" : "bg-segment"
            }`}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-[12px] text-muted">
        <p>Empty: server shuts down</p>
        {right && <p className="tabular-nums text-foreground">{right}</p>}
      </div>

      {v.phase === "failed" && (
        <p role="alert" className="mt-3 text-[13.5px] text-bad">
          {v.error?.trim() || "The run failed."} Check the job details, then start the run again.
        </p>
      )}
    </section>
  );
}
