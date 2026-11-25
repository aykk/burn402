import { describe, expect, it } from "vitest";
import { billedHours, choose, estimateUsd, summarize } from "./choose";
import { DEFAULT_RULES, type Limits, type Need, type Offer } from "./types";

let n = 0;
const offer = (p: Partial<Offer> = {}): Offer => ({
  seller: "s",
  id: `o${n++}`,
  provider: "vultr",
  kind: "cpu",
  vcpus: 1,
  ramGb: 1,
  vramGb: 0,
  gpu: null,
  regions: ["ewr"],
  hourlyUsd: 0.01,
  listHourlyUsd: null,
  inStock: true,
  spot: false,
  rentable: true,
  ...p,
});
const need = (p: Partial<Need> = {}): Need => ({
  kind: "cpu",
  vcpus: 1,
  ramGb: 1,
  vramGb: 0,
  hours: 1,
  regions: [],
  allowSpot: false,
  ...p,
});
const BIG: Limits = { budgetUsd: 1000, rateUsdHr: 1000 };
const R = DEFAULT_RULES;
const reasonOf = (r: { offer: Offer; reason: string }[], o: Offer) => r.find((x) => x.offer === o)?.reason;

describe("billedHours", () => {
  it("rounds up to whole hours with the machine minimum", () => {
    expect(billedHours(need({ hours: 0.2 }), offer(), R)).toBe(1);
    expect(billedHours(need({ hours: 2.4 }), offer(), R)).toBe(3);
  });
  it("applies the gpu minimum", () => {
    expect(billedHours(need({ kind: "gpu", hours: 1 }), offer({ kind: "gpu" }), R)).toBe(2);
  });
  it("bills spot offers by the hour without rounding", () => {
    expect(billedHours(need({ hours: 0.5 }), offer({ spot: true }), R)).toBe(0.5);
    expect(billedHours(need({ hours: 0 }), offer({ spot: true }), R)).toBe(1 / 60);
  });
});

describe("estimateUsd", () => {
  it("adds the machine surcharge below 24 hours", () => {
    expect(estimateUsd(offer({ hourlyUsd: 0.009027 }), 1, R)).toBeCloseTo(0.009027 * 1.15, 6);
  });
  it("adds no surcharge at 24 hours", () => {
    expect(estimateUsd(offer({ hourlyUsd: 0.009027 }), 24, R)).toBeCloseTo(0.009027 * 24, 6);
  });
  it("adds the gpu surcharge", () => {
    expect(estimateUsd(offer({ kind: "gpu", hourlyUsd: 0.351 }), 2, R)).toBeCloseTo(0.351 * 2 * 1.2, 6);
  });
  it("does not surcharge spot offers", () => {
    expect(estimateUsd(offer({ spot: true, hourlyUsd: 0.4 }), 1.5, R)).toBeCloseTo(0.6, 6);
  });
  it("rounds up to whole days with no surcharge when hourly rules are off", () => {
    const off = { ...R, enabled: false };
    expect(estimateUsd(offer({ hourlyUsd: 0.01 }), 1, off)).toBeCloseTo(0.24, 6);
    expect(estimateUsd(offer({ hourlyUsd: 0.01 }), 25, off)).toBeCloseTo(0.48, 6);
  });
});

describe("choose", () => {
  it("picks the smallest plan that fits", () => {
    const a = offer({ vcpus: 1, ramGb: 1, hourlyUsd: 0.009 });
    const b = offer({ vcpus: 2, ramGb: 4, hourlyUsd: 0.027 });
    const c = offer({ vcpus: 4, ramGb: 8, hourlyUsd: 0.054 });
    const { ranked, rejected } = choose([c, a, b], need({ vcpus: 2, ramGb: 3 }), BIG, R);
    expect(ranked[0].offer).toBe(b);
    expect(reasonOf(rejected, a)).toBe("TOO_SMALL");
  });

  it("cheaper wins over smaller", () => {
    const small = offer({ vcpus: 2, ramGb: 2, hourlyUsd: 0.05 });
    const big = offer({ vcpus: 4, ramGb: 8, hourlyUsd: 0.02 });
    expect(choose([small, big], need(), BIG, R).ranked[0].offer).toBe(big);
  });

  it("breaks price ties by fewer vcpus, then less ram, then id", () => {
    const a = offer({ id: "z", vcpus: 2, ramGb: 2 });
    const b = offer({ id: "y", vcpus: 1, ramGb: 4 });
    const c = offer({ id: "x", vcpus: 1, ramGb: 2 });
    const d = offer({ id: "w", vcpus: 1, ramGb: 2 });
    const ids = choose([a, b, c, d], need(), BIG, R).ranked.map((x) => x.offer.id);
    expect(ids).toEqual(["w", "x", "y", "z"]);
  });

  it("rejects the wrong kind and too little vram", () => {
    const cpu = offer();
    const small = offer({ kind: "gpu", vramGb: 6 });
    const ok = offer({ kind: "gpu", vramGb: 24 });
    const { ranked, rejected } = choose([cpu, small, ok], need({ kind: "gpu", vramGb: 16 }), BIG, R);
    expect(ranked.map((c) => c.offer)).toEqual([ok]);
    expect(reasonOf(rejected, cpu)).toBe("WRONG_KIND");
    expect(reasonOf(rejected, small)).toBe("TOO_SMALL");
  });

  it("rejects over rate before over budget", () => {
    const o = offer({ hourlyUsd: 1 });
    // 2 h * 1 * 1.15 = 2.3 total, 1.15/h
    expect(reasonOf(choose([o], need({ hours: 2 }), { budgetUsd: 100, rateUsdHr: 1 }, R).rejected, o)).toBe("OVER_RATE");
    expect(reasonOf(choose([o], need({ hours: 2 }), { budgetUsd: 2, rateUsdHr: 5 }, R).rejected, o)).toBe("OVER_BUDGET");
    expect(reasonOf(choose([o], need({ hours: 2 }), { budgetUsd: 1, rateUsdHr: 1 }, R).rejected, o)).toBe("OVER_RATE");
  });

  it("rejects out of stock and wrong region, and returns regions", () => {
    const out = offer({ inStock: false });
    const lax = offer({ regions: ["lax"] });
    const multi = offer({ regions: ["ewr", "lax", "ams"] });
    const none = offer({ regions: [] });
    expect(reasonOf(choose([out], need(), BIG, R).rejected, out)).toBe("OUT_OF_STOCK");
    expect(reasonOf(choose([lax], need({ regions: ["ewr"] }), BIG, R).rejected, lax)).toBe("NO_REGION");
    expect(choose([multi], need(), BIG, R).ranked[0].regions).toEqual(["ewr", "lax", "ams"]);
    expect(choose([multi], need({ regions: ["lax", "ewr"] }), BIG, R).ranked[0].regions).toEqual(["lax", "ewr"]);
    expect(reasonOf(choose([none], need(), BIG, R).rejected, none)).toBe("NO_REGION");
  });

  it("treats 0 vcpus or ram as unknown, but always compares vram", () => {
    const spot = offer({ kind: "gpu", spot: true, rentable: true, vcpus: 0, ramGb: 0, vramGb: 24 });
    const low = offer({ kind: "gpu", spot: true, rentable: true, vcpus: 0, ramGb: 0, vramGb: 8 });
    const { ranked, rejected } = choose(
      [spot, low],
      need({ kind: "gpu", vcpus: 8, ramGb: 32, vramGb: 16, allowSpot: true }),
      BIG,
      R,
    );
    expect(ranked.map((c) => c.offer)).toEqual([spot]);
    expect(reasonOf(rejected, low)).toBe("TOO_SMALL");
  });

  it("handles spot offers", () => {
    const s = offer({ spot: true, rentable: false });
    const r = offer({ spot: true, rentable: true });
    expect(reasonOf(choose([s], need({ allowSpot: false }), BIG, R).rejected, s)).toBe("SPOT_NOT_ALLOWED");
    expect(reasonOf(choose([s], need({ allowSpot: true }), BIG, R).rejected, s)).toBe("NOT_RENTABLE");
    expect(choose([r], need({ allowSpot: true }), BIG, R).ranked).toHaveLength(1);
  });

  it("returns every offer rejected when nothing fits, and summarize counts descending", () => {
    const offers = [offer({ vcpus: 1 }), offer({ vcpus: 1 }), offer({ inStock: false }), offer({ kind: "gpu" })];
    const { ranked, rejected } = choose(offers, need({ vcpus: 8 }), BIG, R);
    expect(ranked).toEqual([]);
    expect(rejected).toHaveLength(4);
    const s = summarize(rejected);
    expect(s[0]).toEqual({ reason: "TOO_SMALL", count: 3 });
    expect(s).toContainEqual({ reason: "WRONG_KIND", count: 1 });
    expect(s.map((x) => x.count)).toEqual([...s.map((x) => x.count)].sort((a, b) => b - a));
  });

  it("never ranks a candidate outside the limits (random offers)", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 200; i++) {
      const offers = Array.from({ length: 12 }, () =>
        offer({
          kind: rnd() < 0.3 ? "gpu" : "cpu",
          vcpus: Math.floor(rnd() * 8),
          ramGb: Math.floor(rnd() * 16),
          vramGb: Math.floor(rnd() * 48),
          hourlyUsd: rnd() * 2 + 0.001,
          inStock: rnd() < 0.8,
          spot: rnd() < 0.2,
          rentable: rnd() < 0.8,
          regions: rnd() < 0.1 ? [] : ["ewr", "lax"].filter(() => rnd() < 0.6),
        }),
      );
      const nd = need({
        kind: rnd() < 0.3 ? "gpu" : "cpu",
        vcpus: Math.floor(rnd() * 4),
        ramGb: Math.floor(rnd() * 8),
        vramGb: Math.floor(rnd() * 24),
        hours: rnd() * 30,
        allowSpot: rnd() < 0.5,
        regions: rnd() < 0.5 ? [] : ["lax"],
      });
      const lim = { budgetUsd: rnd() * 40, rateUsdHr: rnd() * 2 };
      const { ranked, rejected } = choose(offers, nd, lim, R);
      expect(ranked.length + rejected.length).toBe(offers.length);
      for (const c of ranked) {
        expect(c.estimateUsd).toBeLessThanOrEqual(lim.budgetUsd + 1e-9);
        expect(c.estimateUsd / c.hours).toBeLessThanOrEqual(lim.rateUsdHr + 1e-9);
      }
      for (let k = 1; k < ranked.length; k++) {
        expect(ranked[k].estimateUsd).toBeGreaterThanOrEqual(ranked[k - 1].estimateUsd - 1e-9);
      }
    }
  });
});
