import { describe, expect, it } from "vitest";
import type { Need } from "../types";
import { bestPerSource, fits, regionMatches } from "./fit";
import { SOURCES, type MarketPrice, type PriceSource } from "./types";

const CPU: Need = { kind: "cpu", vcpus: 2, ramGb: 4, vramGb: 0, hours: 1, regions: [], allowSpot: false };
const GPU: Need = { kind: "gpu", vcpus: 1, ramGb: 1, vramGb: 16, hours: 2, regions: [], allowSpot: false };

function price(o: Partial<MarketPrice> = {}): MarketPrice {
  return {
    source: "vultr",
    sourceLabel: "Vultr (direct)",
    name: "p",
    kind: "cpu",
    vcpus: 2,
    ramGb: 4,
    gpu: null,
    vramGb: 0,
    hourlyUsd: 0.03,
    spotHourlyUsd: null,
    region: "ewr",
    note: null,
    url: "https://www.vultr.com/pricing/",
    ...o,
  };
}

describe("fits", () => {
  it("kind must match", () => {
    expect(fits(price(), CPU)).toBe(true);
    expect(fits(price({ kind: "gpu", vramGb: 24 }), CPU)).toBe(false);
    expect(fits(price(), GPU)).toBe(false);
  });

  it("compares vCPUs and RAM only when the price states them", () => {
    expect(fits(price({ vcpus: 1 }), CPU)).toBe(false);
    expect(fits(price({ ramGb: 2 }), CPU)).toBe(false);
    expect(fits(price({ vcpus: 0, ramGb: 0 }), CPU)).toBe(true);
  });

  it("GPU memory must be at least what was asked; unknown memory does not fit a need that asks for some", () => {
    expect(fits(price({ kind: "gpu", vramGb: 16, vcpus: 0, ramGb: 0 }), GPU)).toBe(true);
    expect(fits(price({ kind: "gpu", vramGb: 12 }), GPU)).toBe(false);
    expect(fits(price({ kind: "gpu", vramGb: 0 }), GPU)).toBe(false);
    expect(fits(price({ kind: "gpu", vramGb: 0 }), { ...GPU, vramGb: 0 })).toBe(true);
  });

  it("non-finite or non-positive prices never fit", () => {
    for (const hourlyUsd of [0, -1, NaN, Infinity]) expect(fits(price({ hourlyUsd }), CPU)).toBe(false);
  });
});

describe("bestPerSource", () => {
  it("keeps the cheapest fitting on-demand price per source, sorted ascending", () => {
    const best = bestPerSource(
      [
        price({ name: "a", hourlyUsd: 0.05 }),
        price({ name: "b", hourlyUsd: 0.02, spotHourlyUsd: 0.001, vcpus: 1 }), // too small
        price({ name: "c", hourlyUsd: 0.04, spotHourlyUsd: 0.01 }),
        price({ source: "vast", name: "d", hourlyUsd: 0.03 }),
        price({ source: "akash", name: "e", hourlyUsd: 0.01, kind: "gpu", vramGb: 24 }), // wrong kind
      ],
      CPU,
    );
    expect(best.map((p) => p.name)).toEqual(["d", "c"]);
  });

  it("ties go to the smaller machine, then the name", () => {
    const best = bestPerSource([price({ name: "z", vcpus: 4 }), price({ name: "y", vcpus: 2, ramGb: 8 }), price({ name: "x", vcpus: 2, ramGb: 8 }), price({ name: "w", vcpus: 2, ramGb: 16 })], CPU);
    expect(best.map((p) => p.name)).toEqual(["x"]);
  });

  it("nothing fits → []", () => {
    expect(bestPerSource([price({ vcpus: 1 })], CPU)).toEqual([]);
    expect(bestPerSource([], CPU)).toEqual([]);
  });

  it("property: every result fits and is the cheapest fit of its source (seeded)", () => {
    let seed = 424242;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
    for (let round = 0; round < 300; round++) {
      const need: Need = {
        kind: pick(["cpu", "gpu"] as const),
        vcpus: pick([1, 2, 4, 8]),
        ramGb: pick([0.5, 1, 4, 16]),
        vramGb: pick([0, 8, 16, 24, 80]),
        hours: 1,
        regions: [],
        allowSpot: false,
      };
      const prices: MarketPrice[] = Array.from({ length: Math.floor(rnd() * 30) }, (_, i) =>
        price({
          source: pick(SOURCES),
          name: `p${i}`,
          kind: pick(["cpu", "gpu"] as const),
          vcpus: pick([0, 1, 2, 4, 8, 16]),
          ramGb: pick([0, 0.5, 1, 4, 16, 64]),
          vramGb: pick([0, 8, 16, 24, 48, 80]),
          hourlyUsd: pick([0, -0.1, NaN, 0.01, 0.02, 0.1, 0.5, 1, 2.5]),
        }),
      );
      const best = bestPerSource(prices, need);
      const seen = new Set<PriceSource>();
      for (const [i, b] of best.entries()) {
        expect(fits(b, need)).toBe(true);
        expect(seen.has(b.source)).toBe(false);
        seen.add(b.source);
        for (const p of prices) if (p.source === b.source && fits(p, need)) expect(b.hourlyUsd).toBeLessThanOrEqual(p.hourlyUsd);
        if (i > 0) expect(best[i - 1].hourlyUsd).toBeLessThanOrEqual(b.hourlyUsd);
      }
      for (const s of SOURCES) expect(seen.has(s)).toBe(prices.some((p) => p.source === s && fits(p, need)));
    }
  });
});

describe("regionMatches", () => {
  it("matches a country code, a state or city substring, or a Vultr region by its country", () => {
    expect(regionMatches("Texas, US", ["us"])).toBe(true);
    expect(regionMatches("Texas, US", ["texas"])).toBe(true);
    expect(regionMatches("New Jersey, US", ["ewr"])).toBe(true);
    expect(regionMatches("New Jersey, US", ["vultr:ewr"])).toBe(true);
    expect(regionMatches("China, CN", ["ewr", "fra"])).toBe(false);
    expect(regionMatches("Germany, DE", ["ewr", "fra"])).toBe(true);
  });
  it("a short code is a whole token, never a substring", () => {
    expect(regionMatches("Russia, RU", ["us"])).toBe(false);
    expect(regionMatches(null, ["us"])).toBe(false);
  });
});

describe("bestPerSource with regions asked for", () => {
  const vast = (name: string, hourlyUsd: number, region: string) => price({ source: "vast", name, kind: "gpu", vramGb: 16, hourlyUsd, region });
  const prices = [vast("cn", 0.09, "China, CN"), vast("us", 0.12, "Texas, US"), vast("de", 0.1, "Germany, DE")];

  it("prefers the cheapest Vast.ai offer inside a requested region", () => {
    const best = bestPerSource(prices, { ...GPU, regions: ["ewr"] });
    expect(best.map((p) => [p.name, p.outsideRegions])).toEqual([["us", undefined]]);
  });

  it("with none inside, keeps the cheapest and marks it outside the regions asked for", () => {
    const best = bestPerSource(prices, { ...GPU, regions: ["syd"] });
    expect(best.map((p) => [p.name, p.outsideRegions])).toEqual([["cn", true]]);
  });

  it("no regions asked: the cheapest, unmarked; other sources are not region-filtered", () => {
    expect(bestPerSource(prices, GPU).map((p) => [p.name, p.outsideRegions])).toEqual([["cn", undefined]]);
    const vultr = price({ kind: "gpu", vramGb: 16, region: "ewr", hourlyUsd: 0.4 });
    expect(bestPerSource([vultr], { ...GPU, regions: ["syd"] })[0].outsideRegions).toBeUndefined();
  });
});
