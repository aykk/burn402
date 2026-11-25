import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAkash, parseRunpod, parseVast, parseVultr } from "./parse";

const read = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const vultr = read("vultr.sample.json");
const vast = read("vast.sample.json");
const runpod = read("runpod.sample.json");
const akash = read("akash.sample.json");

const GARBAGE: unknown[] = [null, undefined, 0, "", "plans", [], {}, { plans: null }, { offers: "x" }, { data: null }, { data: { gpuTypes: {} } }, { models: 7 }];

describe.each([
  ["parseVultr", parseVultr],
  ["parseVast", parseVast],
  ["parseRunpod", parseRunpod],
  ["parseAkash", parseAkash],
] as const)("%s on garbage", (_name, parse) => {
  it("returns [] and never throws", () => {
    for (const g of GARBAGE) expect(parse(g)).toEqual([]);
  });
  it("skips rows that are not objects", () => {
    expect(parse({ plans: [null, 1, "x"], offers: [null, 1, "x"], models: [null, 1, "x"], data: { gpuTypes: [null, 1, "x"] } })).toEqual([]);
  });
});

describe("parseVultr", () => {
  const prices = parseVultr(vultr);
  const byName = (n: string) => prices.find((p) => p.name === n);

  it("parses the sample: skips the free tier and plans offered in no region", () => {
    const names = prices.map((p) => p.name);
    expect(names).not.toContain("vc2-1c-0.5gb-free");
    expect(names).not.toContain("vcg-l40s-16c-180g-48vram"); // locations: []
    expect(names).toContain("vc2-1c-1gb");
    expect(prices.every((p) => p.source === "vultr" && p.sourceLabel === "Vultr (direct)" && p.hourlyUsd > 0)).toBe(true);
  });

  it("converts RAM from MB and takes the first location as region", () => {
    expect(byName("vc2-1c-1gb")).toEqual({
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
    });
  });

  it("reads GPU plans whose GPU fields are null from the plan id", () => {
    const a16 = byName("vcg-a16-6c-60g-16vram")!;
    expect(a16.kind).toBe("gpu");
    expect(a16.vramGb).toBe(16);
    expect(a16.gpu).toBe("NVIDIA A16");
    expect(a16.ramGb).toBe(60);
  });

  it("uses gpu_type and gpu_vram_gb when set", () => {
    const p = parseVultr({ plans: [{ id: "vcg-l40s-x", vcpu_count: 16, ram: 184320, hourly_cost: 1.671, gpu_type: "NVIDIA_L40S", gpu_vram_gb: 48, locations: ["ewr"] }] });
    expect(p[0]).toMatchObject({ kind: "gpu", gpu: "NVIDIA_L40S", vramGb: 48, ramGb: 180 });
  });

  it("the preemptible price is the spot price only when it is positive and preemptible deploys are offered", () => {
    const base = { id: "p", vcpu_count: 1, ram: 1024, hourly_cost: 0.1, locations: ["ewr"] };
    expect(parseVultr({ plans: [{ ...base, hourly_cost_preemptible: 0.05, deploy_preemptible: true }] })[0].spotHourlyUsd).toBe(0.05);
    expect(parseVultr({ plans: [{ ...base, hourly_cost_preemptible: 0.05 }] })[0].spotHourlyUsd).toBe(0.05);
    expect(parseVultr({ plans: [{ ...base, hourly_cost_preemptible: 0.1, deploy_preemptible: false }] })[0].spotHourlyUsd).toBeNull();
    expect(parseVultr({ plans: [{ ...base, hourly_cost_preemptible: 0, deploy_preemptible: true }] })[0].spotHourlyUsd).toBeNull();
  });

  it("skips rows with missing, NaN, negative or zero prices and keeps a plan with no locations field", () => {
    const base = { id: "p", vcpu_count: 1, ram: 1024, locations: ["ewr"] };
    for (const hourly_cost of [undefined, NaN, -1, 0, "0.01", null]) expect(parseVultr({ plans: [{ ...base, hourly_cost }] })).toEqual([]);
    const noLoc = parseVultr({ plans: [{ id: "p", vcpu_count: 1, ram: 1024, hourly_cost: 0.01 }] });
    expect(noLoc[0].region).toBeNull();
  });
});

describe("parseVast", () => {
  const prices = parseVast(vast);

  it("parses every sample offer", () => {
    expect(prices.length).toBe(vast.offers.length);
    expect(prices.every((p) => p.source === "vast" && p.kind === "gpu" && p.sourceLabel === "Vast.ai marketplace")).toBe(true);
  });

  it("converts MB to GB, reads on-demand and bid prices, and writes reliability as a percentage", () => {
    const p = prices.find((x) => x.name === "Quadro P2000")!;
    expect(p).toEqual({
      source: "vast",
      sourceLabel: "Vast.ai marketplace",
      name: "Quadro P2000",
      kind: "gpu",
      vcpus: 5,
      ramGb: 6.8,
      gpu: "Quadro P2000",
      vramGb: 5,
      hourlyUsd: 0.02962962962962963,
      spotHourlyUsd: 0.013333333333333334,
      region: "Nevada, US",
      note: "community host, 99.3% reliability",
      url: "https://cloud.vast.ai/create/",
    });
  });

  it("a card sold as 16 GB counts as 16 GB of GPU memory", () => {
    expect(prices.find((x) => x.name === "RTX 4060 Ti")!.vramGb).toBe(16); // gpu_ram 16380 MB
  });

  it("skips bad prices; a missing bid is null; no reliability means no note", () => {
    const base = { gpu_name: "X", gpu_ram: 8192, cpu_cores_effective: 4, cpu_ram: 8192 };
    for (const dph_total of [undefined, NaN, -0.1, 0, "0.1"]) expect(parseVast({ offers: [{ ...base, dph_total }] })).toEqual([]);
    const p = parseVast({ offers: [{ ...base, dph_total: 0.1, min_bid: -1 }] })[0];
    expect(p.spotHourlyUsd).toBeNull();
    expect(p.note).toBeNull();
    expect(p.region).toBeNull();
    expect(parseVast({ offers: [{ ...base, gpu_name: "", dph_total: 0.1 }] })).toEqual([]);
  });
});

describe("parseRunpod", () => {
  const prices = parseRunpod(runpod);

  it("splits each GPU type into community and secure tiers with a positive price", () => {
    const a40 = prices.filter((p) => p.name === "A40");
    expect(a40.map((p) => [p.hourlyUsd, p.note])).toEqual([
      [0.35, "RunPod community cloud"],
      [0.59, "RunPod secure cloud"],
    ]);
    // securePrice 0: community only
    expect(prices.filter((p) => p.name === "RTX 3070").map((p) => p.note)).toEqual(["RunPod community cloud"]);
    expect(prices.some((p) => p.name === "unknown")).toBe(false);
  });

  it("memoryInGb is GPU memory; vCPUs and RAM are not stated", () => {
    const p = prices.find((x) => x.name === "RTX A4000")!;
    expect(p).toEqual({
      source: "runpod",
      sourceLabel: "RunPod (direct)",
      name: "RTX A4000",
      kind: "gpu",
      vcpus: 0,
      ramGb: 0,
      gpu: "NVIDIA RTX A4000",
      vramGb: 16,
      hourlyUsd: 0.17,
      spotHourlyUsd: null,
      region: null,
      note: "RunPod community cloud",
      url: "https://www.runpod.io/pricing",
    });
  });

  it("matches each tier to its own spot price", () => {
    const raw = { data: { gpuTypes: [{ id: "G", displayName: "G", memoryInGb: 24, communityPrice: 0.3, securePrice: 0.5, communitySpotPrice: 0.2, secureSpotPrice: 0.4 }] } };
    expect(parseRunpod(raw).map((p) => [p.hourlyUsd, p.spotHourlyUsd])).toEqual([
      [0.3, 0.2],
      [0.5, 0.4],
    ]);
  });

  it("skips tiers with missing, NaN or negative prices", () => {
    const raw = { data: { gpuTypes: [{ id: "G", displayName: "G", memoryInGb: 24, communityPrice: NaN, securePrice: -1 }, { id: "H", memoryInGb: 8, communityPrice: null }] } };
    expect(parseRunpod(raw)).toEqual([]);
  });
});

describe("parseAkash", () => {
  const prices = parseAkash(akash);

  it("skips models with nothing available or no price", () => {
    const names = prices.map((p) => p.name);
    expect(names.some((n) => n.startsWith("b300"))).toBe(false); // price null, 0 available
    expect(names.some((n) => n.startsWith("t4"))).toBe(false); // 0 available
    expect(names.some((n) => n.startsWith("rtx4080"))).toBe(false);
    expect(prices.every((p) => p.source === "akash" && p.kind === "gpu" && p.vcpus === 0 && p.ramGb === 0)).toBe(true);
  });

  it("reads ram as GPU memory, the cheapest listed price, and the average and range in the note", () => {
    const p = prices.find((x) => x.name === "a100 80Gi SXM4")!;
    expect(p).toEqual({
      source: "akash",
      sourceLabel: "Akash Network",
      name: "a100 80Gi SXM4",
      kind: "gpu",
      vcpus: 0,
      ramGb: 0,
      gpu: "nvidia a100",
      vramGb: 80,
      hourlyUsd: 1.07,
      spotHourlyUsd: null,
      region: null,
      note: "average $1.49, up to $1.91 across providers; 27 of 120 available",
      url: "https://console.akash.network/",
    });
  });

  it("no range when min and max agree", () => {
    expect(prices.find((x) => x.name === "a100 40Gi SXM4")!.note).toBe("1 of 1 available");
  });

  it("falls back to the average when the minimum is not positive; skips bad prices", () => {
    const row = (price: unknown) => ({ models: [{ vendor: "nvidia", model: "x", ram: "16Gi", interface: "PCIe", availability: { total: 2, available: 1 }, price }] });
    expect(parseAkash(row({ min: 0, max: 0.3, avg: 0.25 }))[0].hourlyUsd).toBe(0.25);
    expect(parseAkash(row({ min: 0.2, max: 0.3 }))[0].note).toBe("up to $0.30 across providers; 1 of 2 available");
    for (const price of [null, {}, { min: -1, avg: NaN }, { min: 0, avg: 0 }]) expect(parseAkash(row(price))).toEqual([]);
    expect(parseAkash({ models: [{ vendor: "nvidia", model: "x", ram: "16Gi", availability: { total: 2, available: 1 }, price: { min: 0.2, max: 0.2, avg: 0.2 } }] })[0]).toMatchObject({ name: "x 16Gi", vramGb: 16 });
    expect(parseAkash({ models: [{ vendor: "nvidia", model: "x", ram: "lots", availability: { total: 2, available: 1 }, price: { min: 0.2, avg: 0.2 } }] })[0].vramGb).toBe(0);
  });
});

describe("provider text is capped at 80 characters", () => {
  const long = "x".repeat(200);
  it.each([
    ["vultr", () => parseVultr({ plans: [{ id: long, vcpu_count: 1, ram: 1024, hourly_cost: 0.01, gpu_type: long, locations: [long] }] })[0]],
    ["vast", () => parseVast({ offers: [{ gpu_name: long, gpu_ram: 8192, dph_total: 0.1, geolocation: long }] })[0]],
    ["runpod", () => parseRunpod({ data: { gpuTypes: [{ id: long, displayName: long, memoryInGb: 8, communityPrice: 0.1 }] } })[0]],
    ["akash", () => parseAkash({ models: [{ vendor: long, model: long, ram: "8Gi", availability: { total: 1, available: 1 }, price: { min: 0.1, max: 0.1, avg: 0.1 } }] })[0]],
  ])("%s", (_name, get) => {
    const p = get();
    for (const v of [p.name, p.gpu, p.region, p.note]) if (v !== null) expect(v.length).toBeLessThanOrEqual(80);
    expect(p.name.length).toBe(80);
  });
});
