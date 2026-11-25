import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, type HourlyRules, type Need, type Offer } from "../types";
import { buyableFor, comparePrices, type Buyable } from "./compare";
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

/** a plain per-hour buyable: no surcharge, billed hours = asked hours */
const buyable = (hourlyUsd: number, o: Partial<Buyable> = {}): Buyable => ({
  seller: SELLER,
  plan: "vc2-1c-1gb",
  hourlyUsd,
  totalUsd: hourlyUsd,
  hours: 1,
  firm: false,
  surchargePct: null,
  surchargeUnderHours: null,
  minHours: 1,
  askedHours: 1,
  billedHours: 1,
  ...o,
});

const compare = (prices: MarketPrice[], b: Buyable | null, o: { need?: Partial<Need>; limited?: boolean } = {}) =>
  comparePrices({ prices, sources: SOURCES, asOf: 123, need: { ...NEED, ...o.need }, buyable: b, limited: o.limited });

describe("comparePrices sentence", () => {
  it("cheapest anywhere is not buyable: names both and how much more; an estimate says estimated", () => {
    const c = compare([price({}), price({ name: "vc2-1c-2gb", hourlyUsd: 0.014, ramGb: 2 }), price({ source: "akash", name: "gpu", kind: "gpu", hourlyUsd: 0.001 })], buyable(0.010382));
    expect(c.sentence).toBe(
      "The cheapest fit anywhere is $0.0070 an hour at Vultr (direct), which your agent cannot buy from yet. The cheapest it can buy is an estimated $0.0104 an hour through Test seller (devnet, simulated machines), 48% more.",
    );
    expect(c.premiumPct).toBe(48);
    expect(c.cheapestAnywhere?.name).toBe("vc2-1c-1gb");
    expect(c.best.map((p) => p.name)).toEqual(["vc2-1c-1gb"]);
    expect(c.asOf).toBe(123);
    expect(c.sources).toEqual(SOURCES);
  });

  it("a firm quote says quoted", () => {
    expect(compare([price({})], buyable(0.010382, { firm: true })).sentence).toBe(
      `The cheapest fit anywhere is $0.0070 an hour at Vultr (direct), which your agent cannot buy from yet. The cheapest it can buy is a quoted $0.0104 an hour through ${SELLER}, 48% more.`,
    );
  });

  it("buyable is the cheapest or equal", () => {
    const equal = compare([price({ hourlyUsd: 0.0104 })], buyable(0.0104));
    expect(equal.sentence).toBe(`Your agent can buy the cheapest fit: an estimated $0.0104 an hour through ${SELLER}.`);
    expect(equal.premiumPct).toBe(0);
    const cheaper = compare([price({ hourlyUsd: 0.02 })], buyable(0.01, { firm: true }));
    expect(cheaper.sentence).toBe(`Your agent can buy the cheapest fit: a quoted $0.0100 an hour through ${SELLER}.`);
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
    expect(c.sentence).toBe(`No other provider lists a machine that fits. The cheapest your agent can buy is an estimated $0.0104 an hour through ${SELLER}.`);
    expect(c.premiumPct).toBeNull();
  });

  it("no buyable, and none inside the owner's limits", () => {
    const c = compare([price({})], null);
    expect(c.sentence).toBe("The cheapest fit anywhere is $0.0070 an hour at Vultr (direct). Your agent has no seller it can buy this from.");
    expect(c.buyable).toBeNull();
    expect(c.premiumPct).toBeNull();
    expect(compare([price({})], null, { limited: true }).sentence).toBe(
      "The cheapest fit anywhere is $0.0070 an hour at Vultr (direct). Your agent has no seller it can buy this from inside your limits.",
    );
  });

  it("a premium that rounds to 0% still says it is more", () => {
    const c = compare([price({ hourlyUsd: 1 })], buyable(1.001));
    expect(c.premiumPct).toBe(0);
    expect(c.sentence).toMatch(/, less than 1% more\.$/);
  });
});

describe("comparePrices basis", () => {
  const tail = "other providers' figures are list prices per hour.";

  it("plain per-hour figures", () => {
    expect(compare([price({})], buyable(0.01)).basis).toBe("Both figures are prices per hour.");
  });

  it("a surcharge over the asked hours", () => {
    const b = buyable(0.010382, { surchargePct: 15, surchargeUnderHours: 24 });
    expect(compare([price({})], b).basis).toBe(`The agent's price includes the seller's 15% surcharge for rentals under 24 hours and is spread over 1 billed hour; ${tail}`);
    expect(compare([price({})], { ...b, hours: 3, askedHours: 3, billedHours: 3 }).basis).toBe(
      `The agent's price includes the seller's 15% surcharge for rentals under 24 hours and is spread over 3 billed hours; ${tail}`,
    );
  });

  it("a minimum with a surcharge", () => {
    const b = buyable(0.7453, { surchargePct: 20, surchargeUnderHours: 24, minHours: 2, askedHours: 1, billedHours: 2, hours: 2 });
    expect(compare([price({})], b).basis).toBe(
      `The agent's price includes the seller's 20% surcharge for rentals under 24 hours and a 2-hour minimum, so 2 hours are billed for the 1 you asked for; ${tail}`,
    );
  });

  it("a minimum alone, and whole-hour billing that is not the minimum", () => {
    expect(compare([price({})], buyable(0.01, { minHours: 2, askedHours: 1, billedHours: 2, hours: 2 })).basis).toBe(
      `The agent's price includes a 2-hour minimum, so 2 hours are billed for the 1 you asked for; ${tail}`,
    );
    expect(compare([price({})], buyable(0.01, { minHours: 1, askedHours: 1.5, billedHours: 2, hours: 2 })).basis).toBe(
      `The agent's price includes billing by the whole hour or day, so 2 hours are billed for the 1.5 you asked for; ${tail}`,
    );
  });

  it("no buyable", () => {
    expect(compare([price({})], null).basis).toBe("Other providers' figures are list prices per hour.");
  });

  it("regions asked for: other providers' prices are for any region", () => {
    expect(compare([price({})], buyable(0.01), { need: { regions: ["ewr"] } }).basis).toBe("Both figures are prices per hour. Other providers' prices are for any region.");
    expect(compare([price({})], null, { need: { regions: ["ewr"] } }).basis).toBe("Other providers' figures are list prices per hour. Other providers' prices are for any region.");
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

  it("per hour is the total over the billed hours, with the surcharge and minimum from the rules", () => {
    expect(buyableFor({ seller: SELLER, offer: offer({ kind: "gpu" }), totalUsd: 0.0249, billedHours: 2, askedHours: 1, rules, firm: true })).toEqual({
      seller: SELLER,
      plan: "p",
      hourlyUsd: 0.01245,
      totalUsd: 0.0249,
      hours: 2,
      firm: true,
      surchargePct: 20,
      surchargeUnderHours: 24,
      minHours: 2,
      askedHours: 1,
      billedHours: 2,
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
    expect(buyableFor({ ...base, offer: offer(), totalUsd: NaN })).toBeNull();
  });
});
