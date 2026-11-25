import type { HourlyRules, Limits, Need, Offer } from "./types";

export type Candidate = { offer: Offer; regions: string[]; hours: number; estimateUsd: number };
export type RejectReason =
  | "WRONG_KIND"
  | "TOO_SMALL"
  | "OUT_OF_STOCK"
  | "NO_REGION"
  | "SPOT_NOT_ALLOWED"
  | "NOT_RENTABLE"
  | "OVER_RATE"
  | "OVER_BUDGET";
export type Rejection = { offer: Offer; reason: RejectReason };

const EPS = 1e-9;
const DAY = 24;
const wholeHours = (h: number) => Math.ceil(h - EPS);

/** Hours the seller will bill for this need on this offer. */
export function billedHours(need: Need, offer: Offer, rules: HourlyRules): number {
  if (offer.spot) return Math.max(need.hours, 1 / 60);
  if (!rules.enabled) return Math.max(1, wholeHours(need.hours / DAY)) * DAY;
  const min = offer.kind === "gpu" ? rules.minHours.gpu : rules.minHours.machine;
  return Math.max(wholeHours(need.hours), min);
}

/** Estimated cost in USD for renting `offer` for `hours`. */
export function estimateUsd(offer: Offer, hours: number, rules: HourlyRules): number {
  if (offer.spot) return offer.hourlyUsd * hours;
  if (!rules.enabled) return offer.hourlyUsd * Math.max(1, wholeHours(hours / DAY)) * DAY;
  const pct = offer.kind === "gpu" ? rules.surchargePct.gpu : rules.surchargePct.machine;
  const surcharge = hours < rules.surchargeBelowHours ? 1 + pct / 100 : 1;
  return offer.hourlyUsd * hours * surcharge;
}

function fits(offer: Offer, need: Need): boolean {
  // 0 means the seller did not say: do not compare that dimension.
  if (offer.vcpus > 0 && offer.vcpus < need.vcpus) return false;
  if (offer.ramGb > 0 && offer.ramGb < need.ramGb) return false;
  if (need.kind === "gpu" && offer.vramGb < need.vramGb) return false;
  return true;
}

function regionsFor(offer: Offer, need: Need): string[] {
  if (need.regions.length === 0) return offer.regions;
  return need.regions.filter((r) => offer.regions.includes(r));
}

export function choose(
  offers: Offer[],
  need: Need,
  limits: Limits,
  rules: HourlyRules,
): { ranked: Candidate[]; rejected: Rejection[] } {
  const ranked: Candidate[] = [];
  const rejected: Rejection[] = [];
  for (const offer of offers) {
    const reject = (reason: RejectReason) => void rejected.push({ offer, reason });
    if (offer.kind !== need.kind) { reject("WRONG_KIND"); continue; }
    if (!fits(offer, need)) { reject("TOO_SMALL"); continue; }
    if (offer.spot && !need.allowSpot) { reject("SPOT_NOT_ALLOWED"); continue; }
    if (!offer.rentable) { reject("NOT_RENTABLE"); continue; }
    if (!offer.inStock) { reject("OUT_OF_STOCK"); continue; }
    const regions = regionsFor(offer, need);
    if (offer.regions.length === 0 || regions.length === 0) { reject("NO_REGION"); continue; }
    const hours = billedHours(need, offer, rules);
    const est = estimateUsd(offer, hours, rules);
    if (est / hours > limits.rateUsdHr + EPS) { reject("OVER_RATE"); continue; }
    if (est > limits.budgetUsd + EPS) { reject("OVER_BUDGET"); continue; }
    ranked.push({ offer, regions, hours, estimateUsd: est });
  }
  ranked.sort((a, b) => {
    if (Math.abs(a.estimateUsd - b.estimateUsd) > EPS) return a.estimateUsd - b.estimateUsd;
    return (
      a.offer.vcpus - b.offer.vcpus ||
      a.offer.ramGb - b.offer.ramGb ||
      (a.offer.id < b.offer.id ? -1 : a.offer.id > b.offer.id ? 1 : 0)
    );
  });
  return { ranked, rejected };
}

export function summarize(rejected: Rejection[]): { reason: RejectReason; count: number }[] {
  const counts = new Map<RejectReason, number>();
  for (const r of rejected) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}
