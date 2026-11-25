"use client";

import { useState } from "react";
import type { PriceComparison } from "@/lib/market/prices/compare";
import { Fold } from "./Fold";
import { usd4 } from "./format";
import { buyableMachine, buyableWord, cheapestMarks, priceRows, priceSourceLines, pricesAllFailed, pricesLead, safeLink } from "./market-copy";
import { TEXT_BTN } from "./ui";

/** Cell padding, as in the offers table: a little tighter while the table is narrow. */
const PAD = "py-2 pr-3 @min-[30rem]:pr-4";

/** A short mark under a cell's main text ("cheapest", "same machine, direct"): text, never colour alone. */
function Mark({ children }: { children: string }) {
  return <span className="block text-[12px] leading-4 font-medium text-foreground">{children}</span>;
}

/**
 * Live list prices from providers the agent cannot buy from, beside the plan it can buy. Read-only:
 * nothing here is a quote, and only the buyable plan's firm quote may carry the money colour.
 * Provider text (names, regions, notes) is rendered as text only.
 */
export function MarketPrices({
  prices,
  loading,
  heading,
  foldable = false,
  onClose,
  onBack,
  intro,
  outro,
}: {
  prices: PriceComparison | null;
  /** Prices are on their way: shows "Reading live prices…" in the block's place. */
  loading: boolean;
  /** h3 inside a run, h2 when it is the panel's own content. */
  heading: "h2" | "h3";
  /** Once the money is spent the table is history: the lead stays, the table opens on request. */
  foldable?: boolean;
  onClose?: () => void;
  /** Shown over an ended run: goes back to that run. */
  onBack?: () => void;
  /** A line under the heading (what the prices are for). */
  intro?: string;
  /** A line at the end (what was not done). */
  outro?: string;
}) {
  // Said once to screen readers, when the prices arrive after the block was seen waiting for them.
  const [waited, setWaited] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  if (!prices && loading && !waited) setWaited(true);
  if (prices && waited && said === null) setSaid(`Market prices read. ${pricesLead(prices) ?? priceSourceLines(prices)[0].text}`);

  if (!prices && !loading) return null;

  const H = heading;
  const headingId = `market-prices-heading-${heading}`;
  const lead = prices ? pricesLead(prices) : null;
  const b = prices?.buyable ?? null;
  const rows = prices ? priceRows(prices) : [];
  const buyableCheapest = prices ? cheapestMarks(prices).buyable : false;
  const hasRows = prices !== null && (rows.length > 0 || b !== null);
  const showTable = hasRows && (!foldable || open);
  // The interruptible column only when some row has an interruptible price.
  const spotColumn = rows.some((r) => r.spotHourlyUsd !== null);

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <H id={headingId} className={H === "h2" ? "text-[16px] leading-[22px] font-semibold text-foreground" : "text-[13.5px] leading-5 font-semibold text-foreground"}>
            Market prices
          </H>
          {onClose && (
            <button type="button" className={`text-[12px] leading-4 ${TEXT_BTN}`} onClick={onClose}>
              Close
            </button>
          )}
          {onBack && (
            <button type="button" className={`text-[12px] leading-4 ${TEXT_BTN}`} onClick={onBack}>
              Back to the last run
            </button>
          )}
        </div>
        {intro && <p className="mt-0.5 text-[12px] leading-4 text-muted">{intro}</p>}
      </div>

      {!prices ? (
        <p className="text-muted">Reading live prices…</p>
      ) : (
        <>
          <p className="text-[12px] leading-4 text-muted tabular-nums">
            {priceSourceLines(prices).map((s, i) => (
              <span key={i} className={s.ok ? undefined : "text-bad"}>
                {i > 0 && " "}
                {s.text}
              </span>
            ))}
          </p>

          {lead && (
            <div>
              <p className="max-w-[64ch] text-foreground tabular-nums [overflow-wrap:anywhere]">{lead}</p>
              {/* What the two figures include (surcharge, minimum, total, regions), so they are compared fairly. */}
              {hasRows && !pricesAllFailed(prices) && prices.basis && <p className="mt-0.5 max-w-[64ch] text-[12px] leading-4 text-muted tabular-nums">{prices.basis}</p>}
            </div>
          )}

          {hasRows && foldable && <Fold label="the market prices table" open={open} onToggle={() => setOpen(!open)} />}

          {showTable && (
            // relative: the visually hidden caption is positioned against this wrapper, so it cannot widen the page.
            <div className="@container relative overflow-x-auto">
              <table className="w-full border-collapse text-[13.5px] leading-5">
                <caption className="sr-only">The cheapest machine that fits at each provider, beside the plan your agent can buy</caption>
                <thead>
                  <tr className="border-b border-rule-strong text-left text-[12px] leading-4 text-muted">
                    <th scope="col" className={`${PAD} pl-2.5 font-medium`}>
                      Where
                    </th>
                    <th scope="col" className={`hidden ${PAD} font-medium @min-[37rem]:table-cell`}>
                      Machine
                    </th>
                    <th scope="col" className={`${PAD} text-right font-medium`}>
                      Price an hour
                    </th>
                    {spotColumn && (
                      <th scope="col" className={`hidden ${PAD} text-right font-medium @min-[43rem]:table-cell`}>
                        Interruptible price an hour
                      </th>
                    )}
                    <th scope="col" className="py-2 font-medium">
                      Can your agent buy here?
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {b && (
                    <tr className="border-b border-rule">
                      <th scope="row" className={`border-l-2 border-foreground ${PAD} pl-2 text-left font-semibold`}>
                        Through {b.seller}
                        {/* Narrow tables: the plan and its size under the seller instead of a column that would scroll out of view. */}
                        <span className="block text-[12px] leading-4 font-normal text-muted @min-[37rem]:hidden">
                          <span className="whitespace-nowrap">{b.plan}</span>
                          {buyableMachine(b) && <span className="block">{buyableMachine(b)}</span>}
                        </span>
                      </th>
                      <td className={`hidden ${PAD} @min-[37rem]:table-cell`}>
                        {/* Plan ids never break mid-word. */}
                        <span className="whitespace-nowrap">{b.plan}</span>
                        {buyableMachine(b) && <span className="block text-[12px] leading-4 text-muted">{buyableMachine(b)}</span>}
                      </td>
                      <td className={`${PAD} text-right`}>
                        {b.firm ? (
                          <span className="font-semibold text-foreground underline decoration-amber decoration-2 underline-offset-4" title="The firm quote divided by the hours you asked for">
                            {usd4(b.hourlyUsd)}
                          </span>
                        ) : (
                          usd4(b.hourlyUsd)
                        )}
                        {buyableCheapest && <Mark>cheapest</Mark>}
                      </td>
                      {spotColumn && (
                        <td className={`hidden ${PAD} text-right @min-[43rem]:table-cell`}>
                          <span className="sr-only">does not apply</span>
                        </td>
                      )}
                      <td className="py-2 font-medium text-foreground">{buyableWord(b)}</td>
                    </tr>
                  )}
                  {rows.map((r) => {
                    const href = safeLink(r.url);
                    const place = r.region ? `host in ${r.region}${r.outsideRegions ? ", outside the regions you asked for" : ""}` : null;
                    return (
                      <tr key={r.key} className="border-b border-rule">
                        <th scope="row" className={`border-l-2 border-transparent ${PAD} pl-2 text-left font-normal`}>
                          {href ? (
                            <a href={href} target="_blank" rel="noreferrer noopener">
                              {r.sourceLabel}
                              <span className="sr-only"> (opens in a new tab)</span>
                            </a>
                          ) : (
                            r.sourceLabel
                          )}
                          {r.same && <Mark>same machine, direct</Mark>}
                          {/* Narrow tables: the machine, its size, its place and its interruptible price under the provider. */}
                          <span className="block text-[12px] leading-4 text-muted @min-[37rem]:hidden">
                            <span>{r.name}</span>
                            {r.detail && <span className="block">{r.detail}</span>}
                            {place && <span className="block">{place}</span>}
                            {r.spotHourlyUsd !== null && <span className="block tabular-nums">interruptible {usd4(r.spotHourlyUsd)} an hour</span>}
                          </span>
                          {r.note && <span className="block max-w-[32ch] text-[12px] leading-4 text-muted">{r.note}</span>}
                        </th>
                        <td className={`hidden ${PAD} @min-[37rem]:table-cell`}>
                          <span className="whitespace-nowrap">{r.name}</span>
                          {r.detail && <span className="block text-[12px] leading-4 text-muted">{r.detail}</span>}
                          {place && <span className="block text-[12px] leading-4 text-muted">{place}</span>}
                          {spotColumn && r.spotHourlyUsd !== null && <span className="block text-[12px] leading-4 text-muted tabular-nums @min-[43rem]:hidden">interruptible {usd4(r.spotHourlyUsd)} an hour</span>}
                        </td>
                        <td className={`${PAD} text-right`}>
                          {usd4(r.hourlyUsd)}
                          {r.cheapest && <Mark>cheapest</Mark>}
                        </td>
                        {spotColumn && (
                          <td className={`hidden ${PAD} text-right @min-[43rem]:table-cell`}>
                            {r.spotHourlyUsd !== null ? usd4(r.spotHourlyUsd) : <span className="sr-only">not published</span>}
                          </td>
                        )}
                        <td className="py-2 text-muted">Not yet: no x402 payment</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {showTable && (
            <p className="max-w-[64ch] text-[12px] leading-4 text-muted">
              Prices from other providers are list prices read from their public pages. Only a firm quote from a seller your agent can pay is ever approved or paid.
            </p>
          )}
        </>
      )}

      {outro && prices && <p className="text-foreground">{outro}</p>}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {said ?? ""}
      </p>
    </section>
  );
}
