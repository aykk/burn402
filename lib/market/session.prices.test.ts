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
  it("takes a market and a need, nothing else", () => {
    expect(parsePricesInput({ market: "real", need: { ...NEED, extra: 1 }, budgetUsd: 99 })).toEqual({ ok: true, value: { market: "real", need: NEED } });
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
    expect(c.buyable).toEqual({ seller: SELLERS.test.label, plan: "vc2-1c-1gb", hourlyUsd: 0.009027 * 1.15, totalUsd: 0.009027 * 1.15, hours: 1, firm: false });
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
