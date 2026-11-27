import { describe, expect, it } from "vitest";
import type { MarketPrices } from "./prices/fetch";
import { SELLERS, SellerClient } from "./seller";
import { parseNeed, parsePricesInput, parseRunInput, planPreview, priceComparison } from "./session";
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
      billedHourlyUsd: 0.009027 * 1.15,
      totalUsd: 0.009027 * 1.15,
      hours: 1,
      firm: false,
      paid: false,
      surchargePct: 15,
      surchargeUnderHours: 24,
      minHours: 1,
      askedHours: 1,
      billedHours: 1,
      provider: "vultr",
      kind: "cpu",
      vcpus: 1,
      ramGb: 1,
      vramGb: 0,
      gpu: null,
    });
    expect(c.sentence).toContain("your agent pays an estimated $0.0104 an hour");
    expect(c.basis).toBe("The agent's price includes the seller's published 15% surcharge for rentals under 24 hours; other providers' figures are list prices per hour.");
    expect(c.cheapestAnywhere?.name).toBe("vc2-1c-1gb");
    expect(c.sameMachine?.name).toBe("vc2-1c-1gb");
    expect(c.premiumPct).toBe(49);
    expect(c.sellerUnreadable).toBe(false);
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
    expect(none.sentence).toMatch(/Your agent has no seller it can buy this from inside your limits\.$/);
  });

  it("a GPU need for 1 hour: the 2-hour minimum raises the per-hour figure, and the basis says so", async () => {
    const c = await priceComparison({ market: "test", need: { ...NEED, kind: "gpu", vramGb: 16, hours: 1 } }, { prices: async () => MARKET, seller: testSellerClient() });
    const b = c.buyable!;
    expect(b.billedHours).toBe(2);
    expect(b.hourlyUsd).toBeCloseTo(b.totalUsd, 12); // total over the 1 hour asked for
    expect(b.billedHourlyUsd).toBeCloseTo(b.totalUsd / 2, 12);
    expect(c.basis).toMatch(
      /^The agent's price includes the seller's published 20% surcharge for rentals under 24 hours and is shown per hour you asked for; the seller bills a 2-hour minimum, an estimated \$[\d.]+ in total; other providers' figures are list prices per hour\. Your hourly limit is checked per hour of machine time billed: \$[\d.]+ an hour over 2 hours\.$/,
    );
  });

  it("a seller that cannot be read leaves buyable null; a price read that throws leaves no prices", async () => {
    const broken = new SellerClient(SELLERS.test, { fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch, signer: null });
    const c = await priceComparison({ market: "test", need: NEED }, { prices: async () => MARKET, seller: broken });
    expect(c.buyable).toBeNull();
    expect(c.sellerUnreadable).toBe(true);
    expect(c.sentence).toMatch(/The seller's price list could not be read, so this shows other providers only\.$/);
    expect(c.sentence).not.toMatch(/no seller/);

    const d = await priceComparison({ market: "test", need: NEED }, { prices: async () => Promise.reject(new Error("x")), seller: testSellerClient() });
    expect(d.best).toEqual([]);
    expect(d.buyable?.plan).toBe("vc2-1c-1gb");
  });

  it("the seller's price list gets its own timeout: a seller that never answers is named as unread, not as none", async () => {
    const hanging = { config: SELLERS.test, catalog: () => new Promise<never>(() => {}) } as unknown as SellerClient;
    const started = Date.now();
    const c = await priceComparison({ market: "test", need: NEED, limits: { budgetUsd: 1, rateUsdHr: 0.05 } }, { prices: async () => MARKET, seller: hanging, sellerTimeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(c.sellerUnreadable).toBe(true);
    expect(c.buyable).toBeNull();
    expect(c.sentence).not.toMatch(/no seller/);
  });
});

describe("planPreview", () => {
  const LIMITS = { budgetUsd: 1, rateUsdHr: 0.05 };
  function fake() {
    const config = SELLERS.test;
    const seller = new TestSeller({ processor: new FakeProcessor(), resourceUrl: `${config.baseUrl}/compute/provision` });
    let reads = 0;
    const base = inProcess(seller);
    const client = new SellerClient(config, {
      signer: null,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/compute/plans")) reads++;
        return base(input, init);
      }) as typeof fetch,
    });
    return { client, reads: () => reads };
  }

  it("lists the plans that fit, cheapest first, with what was left out; nothing is quoted or paid", async () => {
    const { client } = fake();
    const p = await planPreview({ market: "test", need: NEED, limits: LIMITS }, { seller: client, cache: new Map(), now: () => 1000 });
    expect(p.market).toBe("test");
    expect(p.seller).toBe(SELLERS.test.label);
    expect(p.asOf).toBe(1000);
    expect(p.fits).toBe(p.plans.length);
    expect(p.fits + p.leftOut.reduce((n, l) => n + l.count, 0)).toBe(p.total);
    expect(p.plans.length).toBeGreaterThan(1);
    // the order the agent asks them in: never dearer than the one after
    for (let i = 1; i < p.plans.length; i++) expect(p.plans[i].estimateUsd).toBeGreaterThanOrEqual(p.plans[i - 1].estimateUsd - 1e-9);
    for (const r of p.plans) {
      expect(r.kind).toBe("cpu");
      expect(r.estimateUsd / r.hours).toBeLessThanOrEqual(LIMITS.rateUsdHr + 1e-9);
    }
    // the same plan the price comparison says a run would rank first
    const cmp = await priceComparison({ market: "test", need: NEED, limits: LIMITS }, { seller: client, prices: async () => ({ prices: [], sources: [], asOf: 0 }) });
    expect(cmp.buyable?.plan).toBe(p.plans[0].id);
  });

  it("follows the filters: a bigger machine or a tighter limit leaves fewer plans", async () => {
    const { client } = fake();
    const cache = new Map();
    const small = await planPreview({ market: "test", need: NEED, limits: LIMITS }, { seller: client, cache });
    const big = await planPreview({ market: "test", need: { ...NEED, vcpus: 2, ramGb: 4 }, limits: LIMITS }, { seller: client, cache });
    const tight = await planPreview({ market: "test", need: NEED, limits: { budgetUsd: 1, rateUsdHr: 0.001 } }, { seller: client, cache });
    expect(big.fits).toBeLessThan(small.fits);
    expect(big.plans.every((r) => r.vcpus >= 2 && r.ramGb >= 4)).toBe(true);
    expect(tight.fits).toBe(0);
    expect(tight.plans).toEqual([]);
    expect(tight.leftOut.some((l) => l.reason === "OVER_RATE")).toBe(true);
  });

  it("reads the seller's price list once a minute at most, however often the filters change", async () => {
    const { client, reads } = fake();
    const cache = new Map();
    let t = 0;
    const deps = { seller: client, cache, now: () => t };
    for (let i = 0; i < 5; i++) await planPreview({ market: "test", need: { ...NEED, vcpus: 1 + (i % 2) }, limits: LIMITS }, deps);
    expect(reads()).toBe(1);
    t = 59_000;
    await planPreview({ market: "test", need: NEED, limits: LIMITS }, deps);
    expect(reads()).toBe(1);
    t = 61_000;
    const later = await planPreview({ market: "test", need: NEED, limits: LIMITS }, deps);
    expect(reads()).toBe(2);
    expect(later.asOf).toBe(61_000);
  });

  it("a failed read is not kept: the next ask reads again", async () => {
    let fail = true;
    let reads = 0;
    const { client } = fake();
    const flaky = { config: client.config, catalog: async () => { reads++; if (fail) throw new Error("seller down"); return client.catalog(); } } as unknown as SellerClient;
    const cache = new Map();
    await expect(planPreview({ market: "test", need: NEED, limits: LIMITS }, { seller: flaky, cache, now: () => 0 })).rejects.toThrow("seller down");
    fail = false;
    const ok = await planPreview({ market: "test", need: NEED, limits: LIMITS }, { seller: flaky, cache, now: () => 0 });
    expect(reads).toBe(2);
    expect(ok.fits).toBeGreaterThan(0);
  });
});
