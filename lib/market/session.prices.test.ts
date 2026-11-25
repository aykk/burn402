import { describe, expect, it } from "vitest";
import type { MarketPrices } from "./prices/fetch";
import { SELLERS, SellerClient } from "./seller";
import { parseNeed, parsePricesInput, parseRunInput, priceComparison } from "./session";
import { FakeProcessor, inProcess } from "./testing";
import { TestSeller } from "./testseller";
import type { Need } from "./types";

const NEED: Need = { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false };

describe("parseNeed", () => {
  it("is the rule parseRunInput uses for need", () => {
    expect(parseNeed(NEED)).toEqual({ ok: true, value: NEED });
    for (const bad of [null, [], { ...NEED, vcpus: 0 }, { ...NEED, hours: 100 }, { ...NEED, regions: ["NOPE!"] }]) {
      const n = parseNeed(bad);
      const r = parseRunInput({ market: "test", need: bad, budgetUsd: 1, rateUsdHr: 0.5, askBeforePaying: true });
      expect(n.ok).toBe(false);
      expect(r).toEqual(n);
    }
  });
});

describe("parsePricesInput", () => {
  it("takes a market and a need; extra fields are dropped", () => {
    expect(parsePricesInput({ market: "real", need: { ...NEED, extra: 1 }, other: 99 })).toEqual({ ok: true, value: { market: "real", need: NEED } });
  });
  it("takes optional limits, checked like a run's", () => {
    expect(parsePricesInput({ market: "test", need: NEED, budgetUsd: 1, rateUsdHr: 0.05 })).toEqual({ ok: true, value: { market: "test", need: NEED, limits: { budgetUsd: 1, rateUsdHr: 0.05 } } });
    const run = (b: number, r: number) => parseRunInput({ market: "test", need: NEED, budgetUsd: b, rateUsdHr: r, askBeforePaying: true });
    for (const [b, r] of [[21, 1], [1, 2], [0.001, 0.001]]) expect(parsePricesInput({ market: "test", need: NEED, budgetUsd: b, rateUsdHr: r })).toEqual(run(b, r));
    expect(parsePricesInput({ market: "test", need: NEED, budgetUsd: 1 })).toEqual({ ok: false, error: "send both the budget and the hourly limit, or neither" });
  });

  it.each([
    [null, "JSON object"],
    [{ need: NEED }, "market"],
    [{ market: "main", need: NEED }, "market"],
    [{ market: "test" }, "what machine"],
    [{ market: "test", need: { ...NEED, kind: "tpu" } }, "CPU or GPU"],
  ])("refuses %j", (body, words) => {
    const r = parsePricesInput(body);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(words);
  });
});

const MARKET: MarketPrices = {
  prices: [
    {
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
    },
  ],
  sources: [{ source: "vultr", label: "Vultr (direct)", ok: true, count: 1, note: null }],
  asOf: 1,
};

function testSellerClient(calls: string[] = []) {
  const seller = new TestSeller({ processor: new FakeProcessor(), resourceUrl: `${SELLERS.test.baseUrl}/compute/provision`, now: () => 1_700_000_000_000 });
  const base = inProcess(seller);
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return base(input, init);
  }) as typeof fetch;
  return new SellerClient(SELLERS.test, { fetch: f, signer: null });
}

describe("priceComparison", () => {
  it("reads the catalog only, picks the cheapest fitting plan as the buyable estimate, and never quotes", async () => {
    const calls: string[] = [];
    const c = await priceComparison({ market: "test", need: NEED }, { prices: async () => MARKET, seller: testSellerClient(calls) });
    expect(calls).toEqual(["GET /api/testseller/compute/plans"]);
    expect(c.buyable).toEqual({
      seller: SELLERS.test.label,
      plan: "vc2-1c-1gb",
      hourlyUsd: 0.009027 * 1.15,
      totalUsd: 0.009027 * 1.15,
      hours: 1,
      firm: false,
      surchargePct: 15,
      surchargeUnderHours: 24,
      minHours: 1,
      askedHours: 1,
      billedHours: 1,
    });
    expect(c.sentence).toContain("an estimated $0.0104 an hour");
    expect(c.basis).toBe("The agent's price includes the seller's 15% surcharge for rentals under 24 hours and is spread over 1 billed hour; other providers' figures are list prices per hour.");
    expect(c.cheapestAnywhere?.name).toBe("vc2-1c-1gb");
    expect(c.premiumPct).toBe(48);
  });

  it("uses generous limits: a 72-hour need still has a buyable plan, priced without the short-rental surcharge", async () => {
    const c = await priceComparison({ market: "test", need: { ...NEED, hours: 72 } }, { prices: async () => MARKET, seller: testSellerClient() });
    expect(c.buyable?.plan).toBe("vc2-1c-1gb");
    expect(c.buyable?.hours).toBe(72);
    expect(c.buyable?.totalUsd).toBeCloseTo(0.009027 * 72, 9);
    expect(c.buyable?.hourlyUsd).toBeCloseTo(0.009027, 9);
  });

  it("with limits, the buyable is what a run with those limits would rank first, or none inside them", async () => {
    const inside = await priceComparison({ market: "test", need: NEED, limits: { budgetUsd: 1, rateUsdHr: 0.05 } }, { prices: async () => MARKET, seller: testSellerClient() });
    expect(inside.buyable?.plan).toBe("vc2-1c-1gb");
    const none = await priceComparison({ market: "test", need: NEED, limits: { budgetUsd: 1, rateUsdHr: 0.001 } }, { prices: async () => MARKET, seller: testSellerClient() });
    expect(none.buyable).toBeNull();
    expect(none.sentence).toBe("The cheapest fit anywhere is $0.0070 an hour at Vultr (direct). Your agent has no seller it can buy this from inside your limits.");
  });

  it("a GPU need shows the minimum and surcharge in the basis", async () => {
    const c = await priceComparison({ market: "test", need: { ...NEED, kind: "gpu", vramGb: 16, hours: 1 } }, { prices: async () => MARKET, seller: testSellerClient() });
    expect(c.buyable?.billedHours).toBe(2);
    expect(c.basis).toBe(
      "The agent's price includes the seller's 20% surcharge for rentals under 24 hours and a 2-hour minimum, so 2 hours are billed for the 1 you asked for; other providers' figures are list prices per hour.",
    );
  });

  it("a seller that cannot be read leaves buyable null; a price read that throws leaves no prices", async () => {
    const broken = new SellerClient(SELLERS.test, { fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch, signer: null });
    const c = await priceComparison({ market: "test", need: NEED }, { prices: async () => MARKET, seller: broken });
    expect(c.buyable).toBeNull();
    expect(c.sentence).toBe("The cheapest fit anywhere is $0.0070 an hour at Vultr (direct). Your agent has no seller it can buy this from.");

    const d = await priceComparison({ market: "test", need: NEED }, { prices: async () => Promise.reject(new Error("x")), seller: testSellerClient() });
    expect(d.best).toEqual([]);
    expect(d.buyable?.plan).toBe("vc2-1c-1gb");
  });
});
