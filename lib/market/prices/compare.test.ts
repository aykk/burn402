import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, type HourlyRules, type Need, type Offer } from "../types";
import { buyableFor, comparePrices, type Buyable } from "./compare";
import type { MarketPrice, SourceStatus } from "./types";

const NEED: Need = { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false };
const GPU_NEED: Need = { kind: "gpu", vcpus: 1, ramGb: 1, vramGb: 16, hours: 2, regions: [], allowSpot: false };
const SELLER = "Test seller (devnet, simulated machines)";
const SOURCES: SourceStatus[] = [
  { source: "vultr", label: "Vultr (direct)", ok: true, count: 3, note: null },
  { source: "vast", label: "Vast.ai marketplace", ok: false, count: 0, note: "did not answer in time" },
];

function price(o: Partial<MarketPrice>): MarketPrice {
  return {
    source: "vultr",
    sourceLabel: "Vultr (direct)",
    name: "vc2-1c-1gb",
    kind: "cpu",
    vcpus: 1,
    ramGb: 1,
    gpu: null,
    vramGb: 0,
    hourlyUsd: 0.007,
    spotHourlyUsd: null,
    region: "ewr",
    note: null,
    url: "https://www.vultr.com/pricing/",
    ...o,
  };
}

const A16 = price({ name: "vcg-a16-6c-60g-16vram", kind: "gpu", gpu: "NVIDIA A16", vramGb: 16, vcpus: 6, ramGb: 60, hourlyUsd: 0.471 });
const P100 = price({ source: "vast", sourceLabel: "Vast.ai marketplace", name: "Tesla P100", kind: "gpu", gpu: "Tesla P100", vramGb: 16, vcpus: 4, ramGb: 32, hourlyUsd: 0.097, region: "Guangdong, CN", url: "https://vast.ai/pricing" });

/** a plain per-hour buyable: no surcharge, billed hours = asked hours; a Vultr plan resold by the seller */
const buyable = (hourlyUsd: number, o: Partial<Buyable> = {}): Buyable => ({
  seller: SELLER,
  plan: "vc2-1c-1gb",
  hourlyUsd,
  billedHourlyUsd: hourlyUsd,
  totalUsd: hourlyUsd,
  hours: 1,
  firm: false,
  paid: false,
  surchargePct: null,
  surchargeUnderHours: null,
  minHours: 1,
  askedHours: 1,
  billedHours: 1,
  provider: "vultr",
  kind: "cpu",
  vcpus: 1,
  ramGb: 1,
  vramGb: 0,
  gpu: null,
  ...o,
});
const gpuBuyable = (hourlyUsd: number, o: Partial<Buyable> = {}) =>
  buyable(hourlyUsd, { plan: "vcg-a16-6c-60g-16vram", kind: "gpu", gpu: "NVIDIA A16", vramGb: 16, vcpus: 6, ramGb: 60, hours: 2, askedHours: 2, billedHours: 2, totalUsd: hourlyUsd * 2, ...o });
/** a plan the seller resells from a provider with no direct price here */
const other = (hourlyUsd: number, o: Partial<Buyable> = {}) => gpuBuyable(hourlyUsd, { provider: "runpod", plan: "runpod-a4000", gpu: "RTX A4000", ...o });

const compare = (prices: MarketPrice[], b: Buyable | null, o: { need?: Partial<Need>; limited?: boolean; sellerUnreadable?: boolean; buyingSpot?: boolean } = {}) =>
  comparePrices({ prices, sources: SOURCES, asOf: 123, need: { ...NEED, ...o.need }, buyable: b, limited: o.limited, sellerUnreadable: o.sellerUnreadable, buyingSpot: o.buyingSpot });
const compareGpu = (prices: MarketPrice[], b: Buyable | null, o: { need?: Partial<Need>; buyingSpot?: boolean } = {}) =>
  comparePrices({ prices, sources: SOURCES, asOf: 123, need: { ...GPU_NEED, ...o.need }, buyable: b, buyingSpot: o.buyingSpot });

describe("comparePrices: the same machine bought direct leads", () => {
  it("CPU: the seller's plan is a Vultr plan; % more is from the two figures shown", () => {
    const c = compare([price({}), price({ name: "vc2-1c-2gb", hourlyUsd: 0.014, ramGb: 2 })], buyable(0.010382));
    // $0.0104 / $0.0070 = 1.4857 -> 49%
    expect(c.sameMachine).toEqual({ source: "vultr", sourceLabel: "Vultr (direct)", name: "vc2-1c-1gb", hourlyUsd: 0.007, premiumPct: 49 });
    expect(c.premiumPct).toBe(49);
    expect(c.sentence).toBe(`The same machine costs $0.0070 an hour direct from Vultr; through ${SELLER} your agent pays an estimated $0.0104 an hour, 49% more. Nothing cheaper that meets your minimums is listed.`);
    expect(c.asOf).toBe(123);
    expect(c.sources).toEqual(SOURCES);
    expect(c.sellerUnreadable).toBe(false);
    expect(c.buyingSpot).toBe(false);
  });

  it("GPU: the same machine first, then the cheapest other machine, named, with its host's region", () => {
    const c = compareGpu([A16, P100], gpuBuyable(0.7453));
    // $0.7453 / $0.4710 = 1.5824 -> 58%; $0.7453 / $0.0970 = 7.6835 -> 668%
    expect(c.sameMachine).toEqual({ source: "vultr", sourceLabel: "Vultr (direct)", name: "vcg-a16-6c-60g-16vram", hourlyUsd: 0.471, premiumPct: 58 });
    expect(c.premiumPct).toBe(668);
    expect(c.sentence).toBe(
      `The same machine costs $0.4710 an hour direct from Vultr; through ${SELLER} your agent pays an estimated $0.7453 an hour, 58% more. ` +
        "The cheapest machine anywhere that meets your minimums is a Tesla P100 (16 GB) at $0.0970 an hour on Vast.ai marketplace (host in Guangdong, CN), where your agent cannot buy yet.",
    );
  });

  it("the same machine is found even when it is not its source's cheapest fit", () => {
    const cheaperVultr = price({ name: "vcg-x-16vram", kind: "gpu", gpu: "NVIDIA X", vramGb: 16, hourlyUsd: 0.3 });
    const c = compareGpu([A16, cheaperVultr], gpuBuyable(0.7453));
    expect(c.sameMachine?.name).toBe("vcg-a16-6c-60g-16vram");
    expect(c.best.map((p) => p.name)).toEqual(["vcg-x-16vram"]);
    expect(c.sentence).toMatch(/The cheapest machine anywhere that meets your minimums is an NVIDIA X \(16 GB\) at \$0\.3000 an hour on Vultr \(direct\), where your agent cannot buy yet\./);
  });

  it("a quoted, a paid, an equal and a cheaper rate", () => {
    expect(compare([price({})], buyable(0.010382, { firm: true })).sentence).toMatch(/your agent pays a quoted \$0\.0104 an hour, 49% more\./);
    expect(compare([price({})], buyable(0.010382, { firm: true, paid: true })).sentence).toMatch(/your agent paid \$0\.0104 an hour, 49% more\./);
    expect(compare([price({})], buyable(0.00701)).sentence).toBe(`The same machine costs $0.0070 an hour direct from Vultr; through ${SELLER} your agent pays an estimated $0.0070 an hour, the same rate. Nothing cheaper that meets your minimums is listed.`);
    const cheaper = compare([price({ hourlyUsd: 0.02 })], buyable(0.01));
    expect(cheaper.sameMachine?.premiumPct).toBe(-50);
    expect(cheaper.sentence).toBe(`The same machine costs $0.0200 an hour direct from Vultr; through ${SELLER} your agent pays an estimated $0.0100 an hour, 50% less. Your agent can buy the cheapest machine that meets your minimums.`);
  });

  it("another provider's plan is not the same machine", () => {
    expect(compare([price({})], buyable(0.0104, { provider: "linode" })).sameMachine).toBeNull();
  });
});

describe("comparePrices: no same machine", () => {
  it("the cheapest fit is named; the agent's figure and how much more", () => {
    const c = compareGpu([P100], other(0.7453));
    expect(c.sameMachine).toBeNull();
    expect(c.sentence).toBe(
      `The cheapest machine anywhere that meets your minimums is a Tesla P100 (16 GB) at $0.0970 an hour on Vast.ai marketplace (host in Guangdong, CN), where your agent cannot buy yet. The cheapest it can buy is an estimated $0.7453 an hour through ${SELLER}, 668% more.`,
    );
  });

  it("articles follow how the name is said; acronyms take an", () => {
    const at = (p: Partial<MarketPrice>) => compareGpu([price({ source: "runpod", sourceLabel: "RunPod (direct)", kind: "gpu", vramGb: 16, region: null, hourlyUsd: 0.1, ...p })], other(0.7)).sentence;
    expect(at({ name: "RTX A4000" })).toContain("is an RTX A4000 (16 GB) at $0.1000 an hour on RunPod (direct), where");
    expect(at({ name: "H100 PCIe", vramGb: 80 })).toContain("is an H100 PCIe (80 GB)");
    expect(at({ name: "a100 80Gi SXM4", vramGb: 80 })).toContain("is an a100 80Gi SXM4 (80 GB)");
    expect(at({ name: "Quadro P2000" })).toContain("is a Quadro P2000 (16 GB)");
  });

  it("a provider's name in a sentence is capped at 40 characters", () => {
    const c = compareGpu([price({ source: "vast", sourceLabel: "Vast.ai marketplace", kind: "gpu", vramGb: 16, name: "x".repeat(100), region: "y".repeat(100), hourlyUsd: 0.1 })], other(0.7));
    expect(c.sentence).toContain(`is a ${"x".repeat(39)}… (16 GB)`);
    expect(c.sentence).toContain(`(host in ${"y".repeat(39)}…)`);
    expect(c.sentence).not.toContain("x".repeat(40));
  });

  it("a Vast.ai offer outside the regions asked for says so", () => {
    const c = compareGpu([price({ ...P100, region: "China, CN" })], other(0.7453), { need: { regions: ["ewr"] } });
    expect(c.sentence).toContain("at $0.0970 an hour on Vast.ai marketplace (host in China, CN, outside the regions you asked for), where");
    // regions asked for: a Vast.ai host inside them is preferred, so the sentence does not say "anywhere"
    expect(c.sentence).toMatch(/^The cheapest machine that meets your minimums is a Tesla P100/);
  });

  it("buyable is the cheapest or equal", () => {
    const equal = compare([price({ name: "vc2-1c-1gb-x", hourlyUsd: 0.0104 })], buyable(0.0104));
    expect(equal.sentence).toBe(`Your agent can buy the cheapest machine that meets your minimums: an estimated $0.0104 an hour through ${SELLER}.`);
    expect(equal.premiumPct).toBe(0);
    const cheaper = compare([price({ name: "vc2-1c-1gb-x", hourlyUsd: 0.02 })], buyable(0.01, { firm: true }));
    expect(cheaper.sentence).toBe(`Your agent can buy the cheapest machine that meets your minimums: a quoted $0.0100 an hour through ${SELLER}.`);
    expect(cheaper.premiumPct).toBe(-50);
  });

  it("no fit anywhere", () => {
    const c = compare([price({ vcpus: 0, ramGb: 0, kind: "gpu" })], null);
    expect(c.sentence).toBe("No provider lists a machine that fits.");
    expect(c.cheapestAnywhere).toBeNull();
    expect(c.premiumPct).toBeNull();
    expect(c.sameMachine).toBeNull();
    expect(c.best).toEqual([]);
  });

  it("no other provider fits but the agent can buy one", () => {
    const c = compare([], buyable(0.0104));
    expect(c.sentence).toBe(`No other provider lists a machine that fits. The cheapest your agent can buy is an estimated $0.0104 an hour through ${SELLER}.`);
    expect(c.premiumPct).toBeNull();
  });

  it("no buyable, and none inside the owner's limits", () => {
    const c = compare([price({})], null);
    expect(c.sentence).toBe("The cheapest machine anywhere that meets your minimums is a vc2-1c-1gb (1 vCPU, 1 GB RAM) on Vultr (direct) at $0.0070 an hour. Your agent has no seller it can buy this from.");
    expect(c.buyable).toBeNull();
    expect(compare([price({})], null, { limited: true }).sentence).toMatch(/Your agent has no seller it can buy this from inside your limits\.$/);
  });

  it("the seller's price list could not be read: never says there is no seller", () => {
    const c = compare([price({})], null, { sellerUnreadable: true, limited: true });
    expect(c.sellerUnreadable).toBe(true);
    expect(c.sentence).toBe(
      "The cheapest machine anywhere that meets your minimums is a vc2-1c-1gb (1 vCPU, 1 GB RAM) on Vultr (direct) at $0.0070 an hour. The seller's price list could not be read, so this shows other providers only.",
    );
    expect(c.sentence).not.toMatch(/no seller/);
    expect(compare([], null, { sellerUnreadable: true }).sentence).toBe("The seller's price list could not be read, so this shows other providers only. No provider lists a machine that fits.");
  });

  it("an interruptible machine bought: the on-demand estimate stays, with a sentence saying its rate is not compared", () => {
    const c = compare([price({})], buyable(0.010382), { buyingSpot: true });
    expect(c.buyingSpot).toBe(true);
    expect(c.sentence).toMatch(/49% more\. Nothing cheaper that meets your minimums is listed\. Your agent is buying an interruptible machine; its rate is not compared with list prices\.$/);
    expect(compare([price({})], null, { buyingSpot: true }).sentence).toBe(
      "The cheapest machine anywhere that meets your minimums is a vc2-1c-1gb (1 vCPU, 1 GB RAM) on Vultr (direct) at $0.0070 an hour. Your agent is buying an interruptible machine; its rate is not compared with list prices.",
    );
  });

  it("a premium under 1% still says it is more; % comes from the 4-decimal figures shown", () => {
    const c = compareGpu([P100], other(1.0001), { need: {} });
    expect(c.premiumPct).toBe(931); // $1.0001 / $0.0970
    const tiny = compareGpu([price({ ...P100, hourlyUsd: 1 })], other(1.0001));
    expect(tiny.premiumPct).toBe(0);
    expect(tiny.sentence).toMatch(/, less than 1% more\.$/);
  });
});

describe("comparePrices basis", () => {
  const tail = "other providers' figures are list prices per hour.";

  it("plain per-hour figures", () => {
    expect(compare([price({})], buyable(0.01)).basis).toBe("Both figures are prices per hour.");
  });

  it("a surcharge, billed hours equal to the hours asked: no billed-hours clause; an estimate says published", () => {
    const b = buyable(0.010382, { surchargePct: 15, surchargeUnderHours: 24 });
    expect(compare([price({})], b).basis).toBe(`The agent's price includes the seller's published 15% surcharge for rentals under 24 hours; ${tail}`);
    expect(compare([price({})], { ...b, firm: true }).basis).toBe(`The agent's price includes the seller's 15% surcharge for rentals under 24 hours; ${tail}`);
  });

  it("a minimum with a surcharge: shown per hour asked, with the minimum and the total", () => {
    const b = gpuBuyable(1.490592, { totalUsd: 1.490592, billedHourlyUsd: 0.745296, surchargePct: 20, surchargeUnderHours: 24, minHours: 2, askedHours: 1, billedHours: 2, hours: 2 });
    // the hourly limit is checked per billed hour: $1.490592 / 2 = $0.745296 -> $0.7453
    const limit = " Your hourly limit is checked per hour of machine time billed: $0.7453 an hour over 2 hours.";
    expect(compareGpu([A16], b).basis).toBe(
      `The agent's price includes the seller's published 20% surcharge for rentals under 24 hours and is shown per hour you asked for; the seller bills a 2-hour minimum, an estimated $1.490592 in total; ${tail}${limit}`,
    );
    expect(compareGpu([A16], { ...b, firm: true }).basis).toBe(
      `The agent's price includes the seller's 20% surcharge for rentals under 24 hours and is shown per hour you asked for; the seller bills a 2-hour minimum, $1.490592 in total; ${tail}${limit}`,
    );
  });

  it("a minimum alone, and whole-hour billing that is not the minimum", () => {
    expect(compare([price({})], buyable(0.02, { totalUsd: 0.02, billedHourlyUsd: 0.01, minHours: 2, askedHours: 1, billedHours: 2, hours: 2 })).basis).toBe(
      `The agent's price is shown per hour you asked for; the seller bills a 2-hour minimum, an estimated $0.02 in total; ${tail} Your hourly limit is checked per hour of machine time billed: $0.0100 an hour over 2 hours.`,
    );
    expect(compare([price({})], buyable(0.02, { totalUsd: 0.03, billedHourlyUsd: 0.015, minHours: 1, askedHours: 1.5, billedHours: 2, hours: 2 })).basis).toBe(
      `The agent's price is shown per hour you asked for; the seller bills 2 hours for the 1.5 you asked for, an estimated $0.03 in total; ${tail} Your hourly limit is checked per hour of machine time billed: $0.0150 an hour over 2 hours.`,
    );
  });

  it("no buyable", () => {
    expect(compare([price({})], null).basis).toBe("Providers' figures are list prices per hour.");
  });

  it("regions asked for", () => {
    const region = " Other providers' prices are for any region; a Vast.ai row names its host's region.";
    expect(compare([price({})], buyable(0.01), { need: { regions: ["ewr"] } }).basis).toBe(`Both figures are prices per hour.${region}`);
    expect(compare([price({})], null, { need: { regions: ["ewr"] } }).basis).toBe("Providers' figures are list prices per hour. Their prices are for any region; a Vast.ai row names its host's region.");
  });
});

describe("buyableFor", () => {
  const offer = (o: Partial<Offer> = {}): Offer => ({
    seller: "testseller",
    id: "p",
    provider: "vultr",
    kind: "cpu",
    vcpus: 1,
    ramGb: 1,
    vramGb: 0,
    gpu: null,
    regions: ["ewr"],
    hourlyUsd: 0.009,
    listHourlyUsd: null,
    inStock: true,
    spot: false,
    rentable: true,
    ...o,
  });
  const rules: HourlyRules = DEFAULT_RULES;

  it("per hour is the total over the hours asked for (a minimum is not hidden); per billed hour is kept beside it", () => {
    expect(buyableFor({ seller: SELLER, offer: offer({ kind: "gpu", gpu: "NVIDIA A16", vramGb: 16, vcpus: 6, ramGb: 60 }), totalUsd: 0.0249, billedHours: 2, askedHours: 1, rules, firm: true })).toEqual({
      seller: SELLER,
      plan: "p",
      hourlyUsd: 0.0249,
      billedHourlyUsd: 0.01245,
      totalUsd: 0.0249,
      hours: 2,
      firm: true,
      paid: false,
      surchargePct: 20,
      surchargeUnderHours: 24,
      minHours: 2,
      askedHours: 1,
      billedHours: 2,
      provider: "vultr",
      kind: "gpu",
      vcpus: 6,
      ramGb: 60,
      vramGb: 16,
      gpu: "NVIDIA A16",
    });
  });

  it("no surcharge at or past the threshold or when the rules are off", () => {
    expect(buyableFor({ seller: SELLER, offer: offer(), totalUsd: 0.3, billedHours: 24, askedHours: 24, rules, firm: false })!.surchargePct).toBeNull();
    const off = { ...rules, enabled: false };
    const b = buyableFor({ seller: SELLER, offer: offer(), totalUsd: 0.3, billedHours: 24, askedHours: 1, rules: off, firm: false })!;
    expect([b.surchargePct, b.minHours]).toEqual([null, null]);
  });

  it("null for spot or not-rentable offers and unusable numbers", () => {
    const base = { seller: SELLER, totalUsd: 1, billedHours: 1, askedHours: 1, rules, firm: false };
    expect(buyableFor({ ...base, offer: offer({ spot: true }) })).toBeNull();
    expect(buyableFor({ ...base, offer: offer({ rentable: false }) })).toBeNull();
    expect(buyableFor({ ...base, offer: offer(), billedHours: 0 })).toBeNull();
    expect(buyableFor({ ...base, offer: offer(), askedHours: 0 })).toBeNull();
    expect(buyableFor({ ...base, offer: offer(), totalUsd: NaN })).toBeNull();
  });
});
