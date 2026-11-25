"use client";

import { useState } from "react";
import type { MarketRunView, OfferRow } from "@/lib/market/run";
import { Fold } from "./Fold";
import { usd4 } from "./format";
import { leftOutPhrase, leftOutSummary, machineSize, quoteNote, sourceLines } from "./market-copy";

const MAX_ROWS = 8;
const ORDER: Record<OfferRow["state"], number> = { chosen: 0, quoted: 1, "quote failed": 2, candidate: 3, "left out": 4 };

/**
 * The comparison: sources, then the chosen and quoted plans, then other candidates (at most 8 rows), and
 * one line counting what was left out and why. "Show all" opens every plan, left-out ones included, in
 * the same table. Below 640px the table keeps Plan, Seller price, Firm quote and the status.
 */
export function OffersTable({ run }: { run: MarketRunView }) {
  const [all, setAll] = useState(false);
  // The plan the run chose stays first in every state, including after its payment was refused.
  const picked = (r: OfferRow) => r.state === "chosen" || (run.approval !== null && r.id === run.approval.plan && r.region === run.approval.region);
  const rank = (r: OfferRow) => (picked(r) ? -1 : ORDER[r.state]);
  const sorted = run.rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(({ r }) => r);
  const usable = sorted.filter((r) => r.state !== "left out");
  const shown = all ? sorted : usable.slice(0, MAX_ROWS);
  const hidden = sorted.length - shown.length;
  const summary = leftOutSummary(run.leftOut, run.need);
  const sources = sourceLines(run.sources, run.marketLabel);
  const quoting = run.phase === "scanning" || run.phase === "choosing" || run.phase === "quoting";

  const status = (r: OfferRow): { word: string; title?: string; tone: string } => {
    switch (r.state) {
      case "chosen":
        return { word: "chosen", tone: "font-semibold text-foreground" };
      case "quoted":
        return { word: "quoted", tone: "text-foreground" };
      case "candidate":
        return { word: quoting ? "waiting" : "not asked", tone: "text-muted" };
      case "quote failed":
        return { word: quoteNote(r.code), title: [r.note, r.code].filter(Boolean).join(" ") || undefined, tone: "text-bad" };
      case "left out":
        return { word: leftOutPhrase(r.code, run.need), title: r.code ?? undefined, tone: "text-muted" };
    }
  };

  return (
    <section className="space-y-2" aria-label="Plans compared">
      {sources.length > 0 && (
        <p className="text-[12px] leading-4 text-muted tabular-nums">
          {sources.map((s, i) => (
            <span key={i} className={s.ok ? undefined : "text-bad"}>
              {i > 0 && "; "}
              {s.text}
            </span>
          ))}
        </p>
      )}

      {shown.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px] leading-5 sm:min-w-[640px]">
            <thead>
              <tr className="border-b border-rule-strong text-left text-[12px] leading-4 text-muted">
                <th className="py-2 pr-4 pl-2.5 font-medium">Plan</th>
                <th className="hidden py-2 pr-4 font-medium sm:table-cell">Provider</th>
                <th className="hidden py-2 pr-4 font-medium md:table-cell">Size</th>
                <th className="hidden py-2 pr-4 text-right font-medium sm:table-cell">List price/h</th>
                <th className="py-2 pr-4 text-right font-medium">Seller price/h</th>
                <th className="py-2 pr-4 text-right font-medium">Firm quote</th>
                <th className="py-2 font-medium">
                  <span className="sr-only">Status</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => {
                const chosen = r.state === "chosen";
                const s = status(r);
                const out = r.state === "left out";
                return (
                  <tr key={`${r.seller}:${r.id}:${r.state}:${i}`} aria-current={chosen ? "true" : undefined} className={`border-b border-rule ${out ? "text-muted" : ""}`}>
                    {/* Plan ids never break mid-word: the table scrolls sideways instead, and the full id is in the title. */}
                    <td className={`border-l-2 py-2 pr-4 pl-2 ${chosen ? "border-foreground font-semibold" : "border-transparent"}`} title={r.region ? `${r.id} in ${r.region}` : r.id}>
                      <span className="whitespace-nowrap">{r.id}</span>
                      {r.region && <span className="font-normal whitespace-nowrap text-muted"> {r.region}</span>}
                    </td>
                    <td className="hidden py-2 pr-4 sm:table-cell">{r.provider}</td>
                    <td className="hidden py-2 pr-4 md:table-cell">{machineSize(r)}</td>
                    <td className="hidden py-2 pr-4 text-right sm:table-cell">{r.listHourlyUsd !== null ? usd4(r.listHourlyUsd) : "-"}</td>
                    <td className="py-2 pr-4 text-right">{usd4(r.hourlyUsd)}</td>
                    <td className="py-2 pr-4 text-right">
                      {r.quoteUsd === null ? (
                        ""
                      ) : chosen ? (
                        <span className="font-semibold text-foreground underline decoration-amber decoration-2 underline-offset-4" title="The amount this rental pays, shown amber in the meter">
                          {r.quoteExact ?? usd4(r.quoteUsd)}
                        </span>
                      ) : (
                        (r.quoteExact ?? usd4(r.quoteUsd))
                      )}
                    </td>
                    <td className={`py-2 text-[12px] leading-4 ${s.tone}`} title={s.title}>
                      {s.word}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(summary || hidden > 0 || all) && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {summary && <p className="text-muted tabular-nums">{summary}</p>}
          {(hidden > 0 || all) && <Fold label={all ? "the other plans" : `all ${sorted.length} plans`} open={all} onToggle={() => setAll(!all)} />}
        </div>
      )}
    </section>
  );
}
