import { usdPerHour } from "../money";
import type { HourlyRules, Need, Offer } from "../types";
import { bestPerSource } from "./fit";
import type { MarketPrice, SourceStatus } from "./types";

export type Buyable = {
  seller: string;
  plan: string;
  /** totalUsd / billed hours: includes any surcharge and minimum hours */
  hourlyUsd: number;
  totalUsd: number;
  /** billed hours (kept for compatibility; same as billedHours) */
  hours: number;
  /** false: the chooser's estimate; true: the seller's firm quote */
  firm: boolean;
  /** the seller's short-rental surcharge included in totalUsd, in percent, or null */
  surchargePct: number | null;
  /** the surcharge applies to rentals under this many hours (null when there is no surcharge) */
  surchargeUnderHours: number | null;
  /** the seller's minimum billed hours for this plan, or null when it has none */
  minHours: number | null;
  /** the hours the owner asked for */
  askedHours: number;
  /** the hours the seller bills */
  billedHours: number;
};

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
  /** plain words, the lead line */
  sentence: string;
  /** plain words under the lead line: what the two figures include, so they are compared fairly */
  basis: string;
};

const EPS = 1e-9;

/**
 * What the agent can buy, from the seller's hourly rules: per hour = total / billed hours, with the
 * surcharge and minimum that went into the total. Null for spot offers (a spot rate is not
 * compared with on-demand list prices) and for numbers that cannot make a rate.
 */
export function buyableFor(b: { seller: string; offer: Offer; totalUsd: number; billedHours: number; askedHours: number; rules: HourlyRules; firm: boolean }): Buyable | null {
  const { offer, rules, totalUsd, billedHours, askedHours } = b;
  if (offer.spot || !offer.rentable) return null;
  if (!(Number.isFinite(totalUsd) && totalUsd > 0 && Number.isFinite(billedHours) && billedHours > 0)) return null;
  const pct = offer.kind === "gpu" ? rules.surchargePct.gpu : rules.surchargePct.machine;
  const surcharged = rules.enabled && billedHours < rules.surchargeBelowHours && Number.isFinite(pct) && pct > 0;
  const min = offer.kind === "gpu" ? rules.minHours.gpu : rules.minHours.machine;
  return {
    seller: b.seller,
    plan: offer.id,
    hourlyUsd: totalUsd / billedHours,
    totalUsd,
    hours: billedHours,
    firm: b.firm,
    surchargePct: surcharged ? pct : null,
    surchargeUnderHours: surcharged ? rules.surchargeBelowHours : null,
    minHours: rules.enabled && Number.isFinite(min) && min > 0 ? min : null,
    askedHours,
    billedHours,
  };
}

const num = (n: number) => String(Math.round(n * 100) / 100);
const hoursWords = (n: number) => (n === 1 ? "1 hour" : `${num(n)} hours`);

function buyWords(b: Buyable): string {
  return `${b.firm ? "a quoted" : "an estimated"} ${usdPerHour(b.hourlyUsd)} an hour through ${b.seller}`;
}

function sentenceFor(cheapest: MarketPrice | null, buyable: Buyable | null, pct: number | null, limited: boolean): string {
  if (!cheapest && !buyable) return "No provider lists a machine that fits.";
  if (!cheapest && buyable) return `No other provider lists a machine that fits. The cheapest your agent can buy is ${buyWords(buyable)}.`;
  const anywhere = `The cheapest fit anywhere is ${usdPerHour(cheapest!.hourlyUsd)} an hour at ${cheapest!.sourceLabel}`;
  if (!buyable) return `${anywhere}. Your agent has no seller it can buy this from${limited ? " inside your limits" : ""}.`;
  if (buyable.hourlyUsd <= cheapest!.hourlyUsd + EPS) return `Your agent can buy the cheapest fit: ${buyWords(buyable)}.`;
  const more = pct !== null && pct >= 1 ? `${pct}% more` : "less than 1% more";
  return `${anywhere}, which your agent cannot buy from yet. The cheapest it can buy is ${buyWords(buyable)}, ${more}.`;
}

function basisFor(buyable: Buyable | null, need: Need): string {
  const region = need.regions.length > 0 ? " Other providers' prices are for any region." : "";
  if (!buyable) return `Other providers' figures are list prices per hour.${region}`;
  const extra = buyable.billedHours > buyable.askedHours + EPS;
  const surcharge =
    buyable.surchargePct !== null && buyable.surchargeUnderHours !== null
      ? `the seller's ${num(buyable.surchargePct)}% surcharge for rentals under ${hoursWords(buyable.surchargeUnderHours)}`
      : null;
  if (!extra && !surcharge) return `Both figures are prices per hour.${region}`;
  const tail = "other providers' figures are list prices per hour.";
  if (!extra) return `The agent's price includes ${surcharge} and is spread over ${num(buyable.billedHours)} billed ${buyable.billedHours === 1 ? "hour" : "hours"}; ${tail}${region}`;
  const minimum =
    buyable.minHours !== null && Math.abs(buyable.billedHours - buyable.minHours) < EPS ? `a ${num(buyable.minHours)}-hour minimum` : "billing by the whole hour or day";
  const billed = `${hoursWords(buyable.billedHours)} ${buyable.billedHours === 1 ? "is" : "are"} billed for the ${num(buyable.askedHours)} you asked for`;
  return `The agent's price includes ${surcharge ? `${surcharge} and ` : ""}${minimum}, so ${billed}; ${tail}${region}`;
}

/**
 * Market prices beside what the agent can buy. Read-only: nothing here chooses or pays.
 * `limited`: the buyable was looked for inside the owner's limits, so "none" means none inside them.
 */
export function comparePrices(input: { prices: MarketPrice[]; sources: SourceStatus[]; asOf: number; need: Need; buyable: Buyable | null; limited?: boolean }): PriceComparison {
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
    sentence: sentenceFor(cheapest, buyable, pct, input.limited === true),
    basis: basisFor(buyable, input.need),
  };
}
