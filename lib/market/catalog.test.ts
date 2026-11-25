import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNuzaFeed, parsePlansFeed } from "./catalog";
import { DEFAULT_RULES } from "./types";

const read = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const plans = read("plans.sample.json");
const nuza = read("nuza.sample.json");

const good = () => structuredClone(plans.plans[0]);

describe("parsePlansFeed", () => {
  it("parses the sample feed", () => {
    const { offers, rules, skipped } = parsePlansFeed(plans, "x402layer");
    expect(skipped).toBe(0);
    expect(offers.length).toBe(plans.plans.length);
    const o = offers.find((x) => x.id === "vc2-1c-1gb");
    expect(o).toEqual({
      seller: "x402layer",
      id: "vc2-1c-1gb",
      provider: "vultr",
      kind: "cpu",
      vcpus: 1,
      ramGb: 1,
      vramGb: 0,
      gpu: null,
      regions: ["ewr", "ord", "dfw", "sea"],
      hourlyUsd: 0.009027,
      listHourlyUsd: 0.006944,
      inStock: true,
      spot: false,
      rentable: true,
    });
    expect(rules.minHours).toEqual({ machine: 1, gpu: 2 });
    expect(rules.surchargePct.machine).toBe(15);
  });

  it("a gpu plan is kind gpu with vram", () => {
    const { offers } = parsePlansFeed(plans, "x402layer");
    const rp = offers.find((x) => x.id.startsWith("runpod-"));
    expect(rp?.kind).toBe("gpu");
    expect(rp!.vramGb).toBeGreaterThan(0);
    expect(typeof rp?.gpu).toBe("string");
    expect(rp!.gpu!.length).toBeGreaterThan(0);
    expect(rp?.regions).toEqual(["runpod"]);
  });

  it("skips broken rows and counts them", () => {
    const noPrice = { ...good(), id: "a" };
    delete noPrice.our_hourly;
    const badRam = { ...good(), id: "b", ram: "abc" };
    const noLoc = { ...good(), id: "c", locations: null };
    const { offers, skipped } = parsePlansFeed({ ...plans, plans: [noPrice, badRam, noLoc, ...plans.plans] }, "s");
    expect(skipped).toBe(3);
    expect(offers.length).toBe(plans.plans.length);
  });

  it.each([
    ["ram", 0],
    ["ram", -1],
    ["ram", Number.NaN],
    ["vcpu_count", 0],
    ["vcpu_count", -2],
    ["vcpu_count", null],
  ])("skips a plan with %s = %s", (field, value) => {
    const { offers, skipped } = parsePlansFeed({ plans: [{ ...good(), [field]: value }] }, "s");
    expect(offers).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("a runpod row with locations null is a runpod region", () => {
    const rp = structuredClone(plans.plans.find((p: { provider: string }) => p.provider === "runpod"));
    rp.locations = null;
    const { offers, skipped } = parsePlansFeed({ plans: [rp] }, "s");
    expect(skipped).toBe(0);
    expect(offers[0].regions).toEqual(["runpod"]);
  });

  it("never hands out DEFAULT_RULES by reference", () => {
    for (const raw of [{ plans: [] }, { plans: [], hourly: {} }, null]) {
      const { rules } = parsePlansFeed(raw, "s");
      expect(rules).toEqual(DEFAULT_RULES);
      expect(rules).not.toBe(DEFAULT_RULES);
      expect(rules.minHours).not.toBe(DEFAULT_RULES.minHours);
      expect(rules.surchargePct).not.toBe(DEFAULT_RULES.surchargePct);
      rules.minHours.machine = 99;
      rules.surchargePct.gpu = 99;
      expect(DEFAULT_RULES.minHours.machine).toBe(1);
      expect(DEFAULT_RULES.surchargePct.gpu).toBe(20);
    }
  });

  it("missing hourly block falls back to DEFAULT_RULES", () => {
    const { hourly: _h, ...rest } = plans;
    void _h;
    expect(parsePlansFeed(rest, "s").rules).toEqual(DEFAULT_RULES);
  });

  it.each([null, [], {}])("empty raw %j gives nothing", (raw) => {
    expect(parsePlansFeed(raw, "s")).toEqual({ offers: [], rules: DEFAULT_RULES, skipped: 0 });
  });

  it("in_stock false is kept as inStock false", () => {
    const { offers, skipped } = parsePlansFeed({ plans: [{ ...good(), in_stock: false }] }, "s");
    expect(skipped).toBe(0);
    expect(offers[0].inStock).toBe(false);
  });
});

describe("parseNuzaFeed", () => {
  it("empty gpus gives []", () => {
    expect(parseNuzaFeed({ gpus: [] })).toEqual([]);
  });

  it("parses the sample row", () => {
    const offers = parseNuzaFeed(nuza);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      seller: "nuza",
      spot: true,
      rentable: false,
      kind: "gpu",
      vramGb: 24,
      hourlyUsd: 0.21,
      regions: ["us-east"],
    });
  });

  it("builds the offer id as model-region", () => {
    expect(parseNuzaFeed(nuza)[0].id).toBe(`${nuza.gpus[0].model}-${nuza.gpus[0].region}`);
  });

  it("garbage input gives []", () => {
    for (const raw of [null, 5, "x", [], {}, { gpus: "no" }, { gpus: [null, 3, {}] }]) {
      expect(parseNuzaFeed(raw)).toEqual([]);
    }
  });
});
