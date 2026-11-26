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

/** Vultr's region codes by country, so a request for "ewr" matches a host in "New Jersey, US". */
const REGION_COUNTRY: Record<string, string> = {
  ewr: "us", ord: "us", dfw: "us", sea: "us", lax: "us", atl: "us", mia: "us", sjc: "us", hnl: "us",
  yto: "ca", mex: "mx", sao: "br", scl: "cl",
  ams: "nl", fra: "de", lhr: "gb", man: "gb", par: "fr", mad: "es", waw: "pl", sto: "se", tlv: "il", jnb: "za",
  nrt: "jp", itm: "jp", icn: "kr", sgp: "sg", syd: "au", mel: "au", blr: "in", del: "in", bom: "in",
};

/**
 * Loose: a provider's region text ("Texas, US") matches a requested region when one of its words is the
 * requested country code (or a Vultr region's country), or when it contains a requested name of four
 * letters or more ("texas"). A short code never matches inside a word ("us" is not in "Russia").
 */
export function regionMatches(text: string | null, requested: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return requested.some((r) => {
    const code = (r.toLowerCase().split(":").pop() ?? "").trim();
    if (!code) return false;
    const country = REGION_COUNTRY[code] ?? code;
    return words.includes(country) || words.includes(code) || (code.length >= 4 && lower.includes(code));
  });
}

/** Sources whose prices are single hosts with a place; the others list a plan offered in several regions. */
const PLACED = new Set<PriceSource>(["vast"]);

/**
 * The cheapest fitting on-demand price of each source, sorted ascending by price. When the need names
 * regions, a source whose prices are single hosts (Vast.ai) gives its cheapest host inside them; with
 * none inside, its cheapest anywhere, marked `outsideRegions`.
 */
export function bestPerSource(prices: MarketPrice[], need: Need): MarketPrice[] {
  const best = new Map<PriceSource, MarketPrice>();
  const inside = new Map<PriceSource, MarketPrice>();
  const regioned = need.regions.length > 0;
  for (const p of prices) {
    if (!fits(p, need)) continue;
    const cur = best.get(p.source);
    if (!cur || order(p, cur) < 0) best.set(p.source, p);
    if (regioned && PLACED.has(p.source) && regionMatches(p.region, need.regions)) {
      const c = inside.get(p.source);
      if (!c || order(p, c) < 0) inside.set(p.source, p);
    }
  }
  if (regioned) {
    for (const [source, p] of best) {
      if (!PLACED.has(source)) continue;
      best.set(source, inside.get(source) ?? { ...p, outsideRegions: true });
    }
  }
  return [...best.values()].sort(order);
}
