import { usdPerHour } from "../money";
import type { Need } from "../types";
import { bestPerSource } from "./fit";
import type { MarketPrice, SourceStatus } from "./types";

export type Buyable = { seller: string; plan: string; hourlyUsd: number; totalUsd: number; hours: number; firm: boolean };

export type PriceComparison = {
  /** epoch ms */
  asOf: number;
  sources: SourceStatus[];
  /** cheapest fit per source, ascending by hourlyUsd */
  best: MarketPrice[];
  cheapestAnywhere: MarketPrice | null;
  /** what the agent can buy: per-hour = total / billed hours */
  buyable: Buyable | null;
  /** how much more buyable.hourlyUsd is than cheapestAnywhere.hourlyUsd, whole percent; negative when buyable is cheaper */
  premiumPct: number | null;
  /** plain words */
  sentence: string;
};

const EPS = 1e-9;

/** A buyable figure from a total and the billed hours; null when the numbers cannot make a rate. */
export function buyableFrom(b: Omit<Buyable, "hourlyUsd">): Buyable | null {
  if (!(Number.isFinite(b.totalUsd) && b.totalUsd > 0 && Number.isFinite(b.hours) && b.hours > 0)) return null;
  return { seller: b.seller, plan: b.plan, hourlyUsd: b.totalUsd / b.hours, totalUsd: b.totalUsd, hours: b.hours, firm: b.firm };
}

function sentenceFor(cheapest: MarketPrice | null, buyable: Buyable | null, pct: number | null): string {
  if (!cheapest && !buyable) return "No provider lists a machine that fits.";
  if (!cheapest && buyable) return `No other provider lists a machine that fits. The cheapest your agent can buy is ${usdPerHour(buyable.hourlyUsd)} an hour through ${buyable.seller}.`;
  const anywhere = `The cheapest fit anywhere is ${usdPerHour(cheapest!.hourlyUsd)} an hour at ${cheapest!.sourceLabel}`;
  if (!buyable) return `${anywhere}. Your agent has no seller it can buy this from.`;
  if (buyable.hourlyUsd <= cheapest!.hourlyUsd + EPS) return `Your agent can buy the cheapest fit: ${usdPerHour(buyable.hourlyUsd)} an hour through ${buyable.seller}.`;
  const more = pct !== null && pct >= 1 ? `${pct}% more` : "less than 1% more";
  return `${anywhere}, which your agent cannot buy from yet. The cheapest it can buy is ${usdPerHour(buyable.hourlyUsd)} an hour through ${buyable.seller}, ${more}.`;
}

/** Market prices beside what the agent can buy. Read-only: nothing here chooses or pays. */
export function comparePrices(input: { prices: MarketPrice[]; sources: SourceStatus[]; asOf: number; need: Need; buyable: Buyable | null }): PriceComparison {
  const best = bestPerSource(input.prices, input.need);
  const cheapest = best[0] ?? null;
  const buyable = input.buyable;
  const pct = cheapest && buyable ? Math.round((buyable.hourlyUsd / cheapest.hourlyUsd - 1) * 100) + 0 : null; // + 0 turns -0 into 0
  return {
    asOf: input.asOf,
    sources: input.sources,
    best,
    cheapestAnywhere: cheapest,
    buyable,
    premiumPct: pct,
    sentence: sentenceFor(cheapest, buyable, pct),
  };
}
