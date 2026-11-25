import type { Need } from "../types";
import type { MarketPrice, PriceSource } from "./types";

/**
 * A price fits when it meets the need: same kind; vCPUs and RAM at least what was asked when the
 * price states them (0 = not stated, not compared); for a GPU need, GPU memory at least what was
 * asked even when unstated (unknown memory does not fit a need that asks for some).
 */
export function fits(price: MarketPrice, need: Need): boolean {
  if (!(Number.isFinite(price.hourlyUsd) && price.hourlyUsd > 0)) return false;
  if (price.kind !== need.kind) return false;
  if (price.vcpus > 0 && price.vcpus < need.vcpus) return false;
  if (price.ramGb > 0 && price.ramGb < need.ramGb) return false;
  if (need.kind === "gpu" && !(price.vramGb >= need.vramGb)) return false;
  return true;
}

/** cheaper first; ties → smaller machine (vCPUs, RAM, GPU memory), then name */
function order(a: MarketPrice, b: MarketPrice): number {
  return a.hourlyUsd - b.hourlyUsd || a.vcpus - b.vcpus || a.ramGb - b.ramGb || a.vramGb - b.vramGb || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** The cheapest fitting on-demand price of each source, sorted ascending by price. */
export function bestPerSource(prices: MarketPrice[], need: Need): MarketPrice[] {
  const best = new Map<PriceSource, MarketPrice>();
  for (const p of prices) {
    if (!fits(p, need)) continue;
    const cur = best.get(p.source);
    if (!cur || order(p, cur) < 0) best.set(p.source, p);
  }
  return [...best.values()].sort(order);
}
