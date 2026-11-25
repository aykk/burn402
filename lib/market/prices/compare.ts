import { usdPerHour, usdPlain } from "../money";
import type { HourlyRules, Need, Offer } from "../types";
import { bestPerSource } from "./fit";
import { SOURCE_NAMES, type MarketPrice, type PriceSource, type SourceStatus } from "./types";

export type Buyable = {
  seller: string;
  plan: string;
  /**
   * What the job asked for costs per hour: totalUsd / the hours ASKED for, so a minimum or whole-hour
   * billing raises it instead of being spread out of sight. Every comparison uses this figure.
   */
  hourlyUsd: number;
  /** totalUsd / billed hours */
  billedHourlyUsd: number;
  totalUsd: number;
  /** billed hours (kept for compatibility; same as billedHours) */
  hours: number;
  /** false: the chooser's estimate; true: the seller's firm quote */
  firm: boolean;
  /** true once the agent has paid this quote */
  paid: boolean;
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
  /** the provider the seller resells ("vultr"): with `plan`, finds the same machine bought direct */
  provider: string;
  kind: "cpu" | "gpu";
  vcpus: number;
  ramGb: number;
  vramGb: number;
  gpu: string | null;
};

/** The plan the agent can buy, as its provider sells it direct (same provider, same plan id). */
export type SameMachine = { source: PriceSource; sourceLabel: string; name: string; hourlyUsd: number; premiumPct: number };

export type PriceComparison = {
  /** epoch ms */
  asOf: number;
  sources: SourceStatus[];
  /** cheapest fit per source, ascending by hourlyUsd */
  best: MarketPrice[];
  cheapestAnywhere: MarketPrice | null;
  /** what the agent can buy: per hour asked for = total / hours asked */
  buyable: Buyable | null;
  /** how much more buyable.hourlyUsd is than cheapestAnywhere.hourlyUsd, whole percent of the 4-decimal figures shown; negative when buyable is cheaper */
  premiumPct: number | null;
  /** the same plan bought direct from its provider, when one is listed; the like-for-like figure */
  sameMachine: SameMachine | null;
  /** the seller's price list could not be read, so only other providers are shown */
  sellerUnreadable: boolean;
  /** the agent quoted an interruptible machine; `buyable` stays the last on-demand estimate */
  buyingSpot: boolean;
  /** plain words, the lead line */
  sentence: string;
  /** plain words under the lead line: what the two figures include, so they are compared fairly */
  basis: string;
};

const EPS = 1e-9;

/**
 * What the agent can buy, from the seller's hourly rules: per hour asked for = total / hours asked,
 * with the surcharge and minimum that went into the total. Null for spot offers (a spot rate is not
 * compared with on-demand list prices) and for numbers that cannot make a rate.
 */
export function buyableFor(b: { seller: string; offer: Offer; totalUsd: number; billedHours: number; askedHours: number; rules: HourlyRules; firm: boolean; paid?: boolean }): Buyable | null {
  const { offer, rules, totalUsd, billedHours, askedHours } = b;
  if (offer.spot || !offer.rentable) return null;
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  if (!(positive(totalUsd) && positive(billedHours) && positive(askedHours))) return null;
  const pct = offer.kind === "gpu" ? rules.surchargePct.gpu : rules.surchargePct.machine;
  const surcharged = rules.enabled && billedHours < rules.surchargeBelowHours && Number.isFinite(pct) && pct > 0;
  const min = offer.kind === "gpu" ? rules.minHours.gpu : rules.minHours.machine;
  return {
    seller: b.seller,
    plan: offer.id,
    hourlyUsd: totalUsd / askedHours,
    billedHourlyUsd: totalUsd / billedHours,
    totalUsd,
    hours: billedHours,
    firm: b.firm,
    paid: b.paid === true,
    surchargePct: surcharged ? pct : null,
    surchargeUnderHours: surcharged ? rules.surchargeBelowHours : null,
    minHours: rules.enabled && Number.isFinite(min) && min > 0 ? min : null,
    askedHours,
    billedHours,
    provider: offer.provider,
    kind: offer.kind,
    vcpus: offer.vcpus,
    ramGb: offer.ramGb,
    vramGb: offer.vramGb,
    gpu: offer.gpu,
  };
}

const num = (n: number) => String(Math.round(n * 100) / 100);
const hoursWords = (n: number) => (n === 1 ? "1 hour" : `${num(n)} hours`);
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Whole percent from the two 4-decimal figures the page shows, so the percentage agrees with them. */
function pctMore(a: number, b: number): number {
  const ra = round4(a);
  const rb = round4(b);
  return (rb > 0 ? Math.round((ra / rb - 1) * 100) : Math.round((a / b - 1) * 100)) + 0; // + 0 turns -0 into 0
}

function diffWords(a: number, b: number, pct: number): string {
  if (round4(a) === round4(b)) return "the same rate";
  if (pct >= 1) return `${pct}% more`;
  if (pct <= -1) return `${-pct}% less`;
  return a > b ? "less than 1% more" : "slightly less";
}

/** Provider-supplied text in a sentence is capped; the page renders it as text, never as markup. */
const MAX_NAME = 40;
const cap = (s: string) => (s.length > MAX_NAME ? `${s.slice(0, MAX_NAME - 1)}…` : s);

/** "an RTX A4000", "an H100", "an a100", "a Tesla P100": acronyms are said letter by letter. */
function article(words: string): string {
  const first = words.split(/\s/)[0] ?? "";
  const acronym = /^[A-Z][A-Z0-9-]*$/.test(first) || /^[A-Z]\d/.test(first);
  const vowelSound = acronym ? /^[AEFHILMNORSX]/.test(first) : /^[aeiou]/i.test(first);
  return `${vowelSound ? "an" : "a"} ${words}`;
}

/** "Tesla P100 (16 GB)", "NVIDIA A16 (16 GB)", "vc2-1c-1gb (1 vCPU, 1 GB RAM)" */
function machineWords(p: MarketPrice): string {
  if (p.kind === "gpu") {
    const label = p.source === "vultr" && p.gpu ? p.gpu.replace(/_/g, " ") : p.name;
    return `${cap(label)}${p.vramGb > 0 ? ` (${p.vramGb} GB)` : ""}`;
  }
  const size = [p.vcpus > 0 ? `${p.vcpus} vCPU${p.vcpus === 1 ? "" : "s"}` : "", p.ramGb > 0 ? `${p.ramGb} GB RAM` : ""].filter(Boolean).join(", ");
  return `${cap(p.name)}${size ? ` (${size})` : ""}`;
}

/** A Vast.ai price is one host in one place: its region is named, and whether it is outside the regions asked for. */
function placeWords(p: MarketPrice): string {
  if (p.source !== "vast" || !p.region) return "";
  return ` (host in ${cap(p.region)}${p.outsideRegions ? ", outside the regions you asked for" : ""})`;
}

/**
 * `regioned`: regions were asked for and a Vast.ai host inside them is preferred, so "anywhere" would not be exact.
 * `elsewhere`: the agent cannot buy there: "… at $X an hour on <provider>, where your agent cannot buy yet".
 */
function anywhereWords(c: MarketPrice, regioned = false, elsewhere = false): string {
  const lead = `The cheapest machine ${regioned ? "" : "anywhere "}that meets your minimums is ${article(machineWords(c))}`;
  if (elsewhere) return `${lead} at ${usdPerHour(c.hourlyUsd)} an hour on ${c.sourceLabel}${placeWords(c)}, where your agent cannot buy yet`;
  return `${lead} on ${c.sourceLabel} at ${usdPerHour(c.hourlyUsd)} an hour${placeWords(c)}`;
}

/** "an estimated $0.0104 an hour", "a quoted …", or for a paid quote "$0.0104 an hour" */
function rateWords(b: Buyable): string {
  return `${b.paid ? "" : b.firm ? "a quoted " : "an estimated "}${usdPerHour(b.hourlyUsd)} an hour`;
}

/** `it`: the agent was named in the sentence before */
function agentWords(b: Buyable, it = false): string {
  return b.paid ? `${it ? "It" : "Your agent"} paid ${rateWords(b)} through ${b.seller}` : `The cheapest ${it ? "it" : "your agent"} can buy is ${rateWords(b)} through ${b.seller}`;
}

const SELLER_UNREAD = "The seller's price list could not be read, so this shows other providers only.";
const SPOT = "Your agent is buying an interruptible machine; its rate is not compared with list prices.";

function sentenceFor(c: MarketPrice | null, b: Buyable | null, same: MarketPrice | null, o: { limited: boolean; sellerUnreadable: boolean; buyingSpot: boolean; regioned: boolean }): string {
  const parts: string[] = [];
  const anywhere = (p: MarketPrice) => anywhereWords(p, o.regioned);
  const elsewhere = (p: MarketPrice) => anywhereWords(p, o.regioned, true);
  if (b && same) {
    const pct = pctMore(b.hourlyUsd, same.hourlyUsd);
    parts.push(`The same machine costs ${usdPerHour(same.hourlyUsd)} an hour direct from ${SOURCE_NAMES[same.source]}; through ${b.seller} your agent ${b.paid ? "paid" : "pays"} ${rateWords(b)}, ${diffWords(b.hourlyUsd, same.hourlyUsd, pct)}.`);
    if (c && b.hourlyUsd <= c.hourlyUsd + EPS) parts.push("Your agent can buy the cheapest machine that meets your minimums.");
    else if (c && !(c.source === same.source && c.name === same.name) && c.hourlyUsd < same.hourlyUsd - EPS) parts.push(`${elsewhere(c)}.`);
    else parts.push("Nothing cheaper that meets your minimums is listed.");
  } else if (!c && !b) {
    if (o.sellerUnreadable) parts.push(SELLER_UNREAD);
    parts.push("No provider lists a machine that fits.");
  } else if (!c && b) {
    parts.push(`No other provider lists a machine that fits. ${agentWords(b)}.`);
  } else if (c && !b) {
    parts.push(`${anywhere(c)}.`);
    if (o.sellerUnreadable) parts.push(SELLER_UNREAD);
    else if (!o.buyingSpot) parts.push(`Your agent has no seller it can buy this from${o.limited ? " inside your limits" : ""}.`);
  } else if (c && b) {
    if (b.hourlyUsd <= c.hourlyUsd + EPS) {
      parts.push(b.paid ? `Your agent paid ${rateWords(b)} through ${b.seller}, the cheapest machine that meets your minimums.` : `Your agent can buy the cheapest machine that meets your minimums: ${rateWords(b)} through ${b.seller}.`);
    } else {
      parts.push(`${elsewhere(c)}. ${agentWords(b, true)}, ${diffWords(b.hourlyUsd, c.hourlyUsd, pctMore(b.hourlyUsd, c.hourlyUsd))}.`);
    }
  }
  if (o.buyingSpot) parts.push(SPOT);
  return parts.join(" ");
}

function basisFor(b: Buyable | null, need: Need): string {
  const regioned = need.regions.length > 0;
  // With no agent plan there is nothing for "other" to refer to.
  if (!b) return `Providers' figures are list prices per hour.${regioned ? " Their prices are for any region; a Vast.ai row names its host's region." : ""}`;
  const region = regioned ? " Other providers' prices are for any region; a Vast.ai row names its host's region." : "";
  const extra = b.billedHours > b.askedHours + EPS;
  const surcharge =
    b.surchargePct !== null && b.surchargeUnderHours !== null
      ? `the seller's ${b.firm || b.paid ? "" : "published "}${num(b.surchargePct)}% surcharge for rentals under ${hoursWords(b.surchargeUnderHours)}`
      : null;
  if (!extra && !surcharge) return `Both figures are prices per hour.${region}`;
  const tail = "other providers' figures are list prices per hour.";
  if (!extra) return `The agent's price includes ${surcharge}; ${tail}${region}`;
  const bills = b.minHours !== null && Math.abs(b.billedHours - b.minHours) < EPS ? `a ${num(b.minHours)}-hour minimum` : `${hoursWords(b.billedHours)} for the ${num(b.askedHours)} you asked for`;
  const total = `${b.firm || b.paid ? "" : "an estimated "}${usdPlain(b.totalUsd)} in total`;
  // The owner's hourly limit is checked per billed hour (choose.ts, guard.ts), not per hour asked: said here, so a
  // per-hour-asked figure above the limit is not read as the limit being broken.
  const limit = ` Your hourly limit is checked per hour of machine time billed: ${usdPerHour(b.billedHourlyUsd)} an hour over ${hoursWords(b.billedHours)}.`;
  return `The agent's price ${surcharge ? `includes ${surcharge} and ` : ""}is shown per hour you asked for; the seller bills ${bills}, ${total}; ${tail}${limit}${region}`;
}

/** The buyable plan as its own provider sells it direct: same provider, same plan id, a positive price. */
function sameMachineOf(prices: MarketPrice[], b: Buyable | null): MarketPrice | null {
  if (!b) return null;
  const hits = prices.filter((p) => p.source === b.provider && p.name === b.plan && Number.isFinite(p.hourlyUsd) && p.hourlyUsd > 0);
  return hits.sort((x, y) => x.hourlyUsd - y.hourlyUsd)[0] ?? null;
}

/**
 * Market prices beside what the agent can buy. Read-only: nothing here chooses or pays.
 * `limited`: the buyable was looked for inside the owner's limits, so "none" means none inside them.
 * `sellerUnreadable`: the seller's price list could not be read, so "none" is not known.
 * `buyingSpot`: the agent quoted an interruptible machine; `buyable` is the last on-demand estimate.
 */
export function comparePrices(input: {
  prices: MarketPrice[];
  sources: SourceStatus[];
  asOf: number;
  need: Need;
  buyable: Buyable | null;
  limited?: boolean;
  sellerUnreadable?: boolean;
  buyingSpot?: boolean;
}): PriceComparison {
  const best = bestPerSource(input.prices, input.need);
  const cheapest = best[0] ?? null;
  const buyable = input.buyable;
  const same = sameMachineOf(input.prices, buyable);
  const flags = { limited: input.limited === true, sellerUnreadable: input.sellerUnreadable === true, buyingSpot: input.buyingSpot === true, regioned: input.need.regions.length > 0 };
  return {
    asOf: input.asOf,
    sources: input.sources,
    best,
    cheapestAnywhere: cheapest,
    buyable,
    premiumPct: cheapest && buyable ? pctMore(buyable.hourlyUsd, cheapest.hourlyUsd) : null,
    sameMachine: same && buyable ? { source: same.source, sourceLabel: same.sourceLabel, name: same.name, hourlyUsd: same.hourlyUsd, premiumPct: pctMore(buyable.hourlyUsd, same.hourlyUsd) } : null,
    sellerUnreadable: flags.sellerUnreadable,
    buyingSpot: flags.buyingSpot,
    sentence: sentenceFor(cheapest, buyable, same, flags),
    basis: basisFor(buyable, input.need),
  };
}
