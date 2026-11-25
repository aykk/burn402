import { describe, expect, it } from "vitest";
import type { Need } from "../types";
import { buyableFrom, comparePrices, type PriceComparison } from "./compare";
import type { MarketPrice, SourceStatus } from "./types";

const NEED: Need = { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false };
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

const buyable = (hourlyUsd: number, o: Partial<NonNullable<PriceComparison["buyable"]>> = {}): PriceComparison["buyable"] => ({
  seller: SELLER,
  plan: "vc2-1c-1gb",
  hourlyUsd,
  totalUsd: hourlyUsd,
  hours: 1,
  firm: false,
  ...o,
});

const compare = (prices: MarketPrice[], b: PriceComparison["buyable"]) => comparePrices({ prices, sources: SOURCES, asOf: 123, need: NEED, buyable: b });

describe("comparePrices", () => {
  it("cheapest anywhere is not buyable: names both and how much more", () => {
    const c = compare([price({}), price({ name: "vc2-1c-2gb", hourlyUsd: 0.014, ramGb: 2 }), price({ source: "akash", name: "gpu", kind: "gpu", hourlyUsd: 0.001 })], buyable(0.010382));
    expect(c.sentence).toBe(
      "The cheapest fit anywhere is $0.0070 an hour at Vultr (direct), which your agent cannot buy from yet. The cheapest it can buy is $0.0104 an hour through Test seller (devnet, simulated machines), 48% more.",
    );
    expect(c.premiumPct).toBe(48);
    expect(c.cheapestAnywhere?.name).toBe("vc2-1c-1gb");
    expect(c.best.map((p) => p.name)).toEqual(["vc2-1c-1gb"]);
    expect(c.asOf).toBe(123);
    expect(c.sources).toEqual(SOURCES);
  });

  it("buyable is the cheapest or equal", () => {
    const equal = compare([price({ hourlyUsd: 0.0104 })], buyable(0.0104));
    expect(equal.sentence).toBe(`Your agent can buy the cheapest fit: $0.0104 an hour through ${SELLER}.`);
    expect(equal.premiumPct).toBe(0);
    const cheaper = compare([price({ hourlyUsd: 0.02 })], buyable(0.01));
    expect(cheaper.sentence).toBe(`Your agent can buy the cheapest fit: $0.0100 an hour through ${SELLER}.`);
    expect(cheaper.premiumPct).toBe(-50);
  });

  it("no fit anywhere", () => {
    const c = compare([price({ vcpus: 0, ramGb: 0, kind: "gpu" })], null);
    expect(c.sentence).toBe("No provider lists a machine that fits.");
    expect(c.cheapestAnywhere).toBeNull();
    expect(c.premiumPct).toBeNull();
    expect(c.best).toEqual([]);
  });

  it("no other provider fits but the agent can buy one", () => {
    const c = compare([], buyable(0.0104));
    expect(c.sentence).toBe(`No other provider lists a machine that fits. The cheapest your agent can buy is $0.0104 an hour through ${SELLER}.`);
    expect(c.premiumPct).toBeNull();
  });

  it("no buyable", () => {
    const c = compare([price({})], null);
    expect(c.sentence).toBe("The cheapest fit anywhere is $0.0070 an hour at Vultr (direct). Your agent has no seller it can buy this from.");
    expect(c.buyable).toBeNull();
    expect(c.premiumPct).toBeNull();
  });

  it("a premium that rounds to 0% still says it is more", () => {
    const c = compare([price({ hourlyUsd: 1 })], buyable(1.001));
    expect(c.premiumPct).toBe(0);
    expect(c.sentence).toMatch(/, less than 1% more\.$/);
  });
});

describe("buyableFrom", () => {
  it("per hour is the total over the billed hours", () => {
    expect(buyableFrom({ seller: SELLER, plan: "p", totalUsd: 0.0249, hours: 2, firm: true })).toEqual({ seller: SELLER, plan: "p", hourlyUsd: 0.01245, totalUsd: 0.0249, hours: 2, firm: true });
  });
  it("null for unusable numbers", () => {
    expect(buyableFrom({ seller: SELLER, plan: "p", totalUsd: 1, hours: 0, firm: false })).toBeNull();
    expect(buyableFrom({ seller: SELLER, plan: "p", totalUsd: NaN, hours: 1, firm: false })).toBeNull();
  });
});
