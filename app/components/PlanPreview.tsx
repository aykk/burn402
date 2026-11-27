"use client";

import type { PlanPreview as Preview } from "@/lib/market/session";
import type { Need } from "@/lib/market/types";
import { usd4 } from "./format";
import { hoursText, leftOutSummary, machineSize } from "./market-copy";
import { MONO_ID } from "./ui";

const PAD = "py-2 pr-3 @min-[30rem]:pr-4";

export type PreviewState = { status: "loading" | "ready" | "failed"; preview: Preview | null; need: Need | null };

/**
 * Before a run: the plans that fit the filters on the left, updated as they change. The first row is the
 * one the agent would ask first. These are estimates from the seller's price list, not quotes; the agent
 * asks for firm quotes when Find and rent is pressed.
 */
export function PlanPreview({ state }: { state: PreviewState }) {
  const { preview: p, status, need } = state;

  if (!p) {
    return (
      <section aria-labelledby="preview-heading" className="space-y-2">
        <h2 id="preview-heading" className="text-[16px] leading-[22px] font-semibold text-foreground">
          Plans that fit
        </h2>
        <p role="status" className={status === "failed" ? "max-w-[56ch] text-foreground" : "text-muted"}>
          {status === "failed" ? "The seller\u2019s price list couldn\u2019t be read just now. Find and rent will read it again." : "Reading the seller\u2019s price list\u2026"}
        </p>
      </section>
    );
  }

  const summary = need ? leftOutSummary(p.leftOut, need) : null;
  const hours = p.plans[0]?.hours ?? need?.hours ?? 1;
  return (
    // While newer filters are being read the last list stays, dimmed, so the table never blinks away.
    <section aria-labelledby="preview-heading" aria-busy={status === "loading"} className={`space-y-2 motion-safe:transition-opacity ${status === "loading" ? "opacity-60" : ""}`}>
      <div>
        <h2 id="preview-heading" className="text-[16px] leading-[22px] font-semibold text-foreground">
          Plans that fit
        </h2>
        <p className="mt-0.5 text-[12px] leading-4 text-muted tabular-nums">
          {p.fits} of the seller&apos;s {p.total} plans fit what you need
          {status === "failed" && ". The list couldn\u2019t be read again just now; this is the last one."}
        </p>
      </div>

      {p.plans.length === 0 ? (
        <p className="max-w-[56ch] text-foreground">Nothing fits inside your limits. Ask for a smaller machine, or raise the hourly limit or the budget.</p>
      ) : (
        <div className="@container relative overflow-x-auto">
          <table className="w-full border-collapse text-[14px] leading-5">
            <thead>
              <tr className="border-b border-rule-strong text-left text-[12px] leading-4 text-muted">
                <th className={`${PAD} pl-[13px] font-medium`}>Plan</th>
                <th className={`hidden ${PAD} font-medium @min-[37rem]:table-cell`}>Provider</th>
                <th className={`hidden ${PAD} font-medium @min-[37rem]:table-cell`}>Size</th>
                <th className={`${PAD} text-right font-medium`}>Price per hour</th>
                <th className={`${PAD} text-right font-medium`}>Estimated total</th>
                <th className="hidden py-2 font-medium @min-[30rem]:table-cell">
                  <span className="sr-only">Standing</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {p.plans.map((r, i) => {
                const first = i === 0;
                const word = first ? "cheapest" : r.spot ? "interruptible" : "";
                return (
                  <tr key={r.id} aria-current={first ? "true" : undefined} className="border-b border-rule transition-colors hover:bg-surface/70">
                    <td className={`border-l-2 ${PAD} pl-3 ${first ? "border-foreground font-semibold" : "border-transparent"}`} title={r.id}>
                      <span className={`whitespace-nowrap ${MONO_ID}`}>{r.id}</span>
                      {word && <span className={`block text-[12px] leading-4 font-normal @min-[30rem]:hidden ${first ? "text-foreground" : "text-muted"}`}>{word}</span>}
                    </td>
                    <td className={`hidden ${PAD} @min-[37rem]:table-cell`}>{r.provider}</td>
                    <td className={`hidden ${PAD} whitespace-nowrap @min-[37rem]:table-cell`}>{machineSize(r)}</td>
                    <td className={`${PAD} text-right`}>{usd4(r.hourlyUsd)}</td>
                    <td className={`${PAD} text-right ${first ? "font-semibold" : ""}`}>{usd4(r.estimateUsd)}</td>
                    <td className={`hidden py-2 text-[12px] leading-4 whitespace-nowrap @min-[30rem]:table-cell ${first ? "font-semibold text-foreground" : "text-muted"}`}>{word}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {summary && <p className="text-muted tabular-nums">{summary}</p>}
      {p.plans.length > 0 && (
        <p className="max-w-[64ch] text-[12px] leading-4 text-muted">
          Estimates for {hoursText(hours)}, cheapest first. Press Find and rent and your agent gets exact prices, picks the cheapest, and shows you the payment before
          anything is spent.
        </p>
      )}
    </section>
  );
}
