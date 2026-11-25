import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchMarketPrices, PRICE_URLS, type PriceCache } from "./fetch";

const read = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const BODIES: Record<string, string> = {
  vultr: read("vultr.sample.json"),
  vast: read("vast.sample.json"),
  runpod: read("runpod.sample.json"),
  akash: read("akash.sample.json"),
};

type Call = { url: string; init: RequestInit | undefined };
type Answer = Response | "hang" | Error;

const sourceOf = (url: string) => (url.includes("vultr") ? "vultr" : url.includes("vast") ? "vast" : url.includes("runpod") ? "runpod" : "akash");

/** A fetch that answers each source from the fixtures unless `answers` overrides it. Hanging requests honor the abort signal. */
function fakeFetch(answers: Partial<Record<string, () => Answer>> = {}) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const a = answers[sourceOf(url)]?.() ?? new Response(BODIES[sourceOf(url)], { status: 200, headers: { "content-type": "application/json" } });
    if (a instanceof Error) throw a;
    if (a === "hang") {
      return new Promise<Response>((_, reject) => {
        const s = init?.signal;
        s?.addEventListener("abort", () => reject(s.reason));
      });
    }
    return a;
  }) as typeof fetch;
  return { f, calls };
}

const fresh = (): PriceCache => ({ entry: null });

describe("fetchMarketPrices", () => {
  it("reads all four sources in parallel and reports each", async () => {
    const { f, calls } = fakeFetch();
    const r = await fetchMarketPrices({ fetch: f, cache: fresh(), now: () => 5 });
    expect(r.asOf).toBe(5);
    expect(r.sources.map((s) => [s.source, s.ok, s.note])).toEqual([
      ["vultr", true, null],
      ["vast", true, null],
      ["runpod", true, null],
      ["akash", true, null],
    ]);
    expect(r.sources.every((s) => s.count > 0)).toBe(true);
    expect(r.prices.length).toBe(r.sources.reduce((n, s) => n + s.count, 0));
    expect(new Set(r.prices.map((p) => p.source))).toEqual(new Set(["vultr", "vast", "runpod", "akash"]));
    expect(calls.map((c) => c.url).sort()).toEqual(Object.values(PRICE_URLS).sort());
  });

  it("sends only an accept header (and the JSON body to RunPod): no cookies, nothing identifying", async () => {
    const { f, calls } = fakeFetch();
    await fetchMarketPrices({ fetch: f, cache: fresh() });
    for (const c of calls) {
      const h = new Headers(c.init?.headers);
      const names = [...h.keys()].sort();
      if (c.url.includes("runpod")) {
        expect(c.init?.method).toBe("POST");
        expect(names).toEqual(["accept", "content-type"]);
        expect(JSON.parse(String(c.init?.body))).toEqual({ query: "{ gpuTypes { id displayName memoryInGb communityPrice securePrice communitySpotPrice secureSpotPrice } }" });
      } else {
        expect(c.init?.method).toBe("GET");
        expect(names).toEqual(["accept"]);
        expect(c.init?.body).toBeUndefined();
      }
      expect(h.get("accept")).toBe("application/json");
      expect(c.init?.credentials).toBe("omit");
      expect(c.init?.signal).toBeInstanceOf(AbortSignal);
    }
    const vast = new URL(calls.find((c) => c.url.includes("vast"))!.url);
    expect(JSON.parse(vast.searchParams.get("q")!)).toEqual({ rentable: { eq: true }, verified: { eq: true }, num_gpus: { eq: 1 }, order: [["dph_total", "asc"]], limit: 40 });
  });

  it("a slow, failing, oversized or unreadable source is reported and gives no prices; the rest still count", async () => {
    const { f } = fakeFetch({
      vultr: () => "hang",
      vast: () => new Response("busy", { status: 503 }),
      runpod: () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 }),
      akash: () => new Response("<html>", { status: 200 }),
    });
    const r = await fetchMarketPrices({ fetch: f, cache: fresh(), timeoutMs: 30 });
    expect(r.sources.map((s) => [s.source, s.ok, s.count, s.note])).toEqual([
      ["vultr", false, 0, "did not answer in time"],
      ["vast", false, 0, "answered HTTP 503"],
      ["runpod", false, 0, "sent something this app could not read"],
      ["akash", false, 0, "sent something this app could not read"],
    ]);
    expect(r.prices).toEqual([]);

    const mixed = await fetchMarketPrices({ fetch: fakeFetch({ vast: () => new Error("ECONNREFUSED"), akash: () => new Response('{"models":"nope"}') }).f, cache: fresh() });
    expect(mixed.sources.map((s) => [s.source, s.ok, s.note])).toEqual([
      ["vultr", true, null],
      ["vast", false, "could not be reached"],
      ["runpod", true, null],
      ["akash", false, "sent something this app could not read"],
    ]);
    expect(mixed.prices.some((p) => p.source === "vast" || p.source === "akash")).toBe(false);
  });

  it("never throws, even when fetch throws synchronously", async () => {
    const f = (() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const r = await fetchMarketPrices({ fetch: f, cache: fresh() });
    expect(r.sources.every((s) => !s.ok && s.note === "could not be reached")).toBe(true);
  });

  it("caches one answer for 60 s, shares a request in flight, and asks again after", async () => {
    const cache = fresh();
    let t = 1_000;
    const { f, calls } = fakeFetch();
    const deps = { fetch: f, cache, now: () => t };
    const [a, b] = await Promise.all([fetchMarketPrices(deps), fetchMarketPrices(deps)]);
    expect(calls.length).toBe(4);
    expect(b).toBe(a);
    t += 59_999;
    expect(await fetchMarketPrices(deps)).toBe(a);
    expect(calls.length).toBe(4);
    t += 1;
    await fetchMarketPrices(deps);
    expect(calls.length).toBe(8);
  });

  it("does not keep an answer in which every source failed", async () => {
    const cache = fresh();
    const { f, calls } = fakeFetch({ vultr: () => new Error("x"), vast: () => new Error("x"), runpod: () => new Error("x"), akash: () => new Error("x") });
    await fetchMarketPrices({ fetch: f, cache });
    await fetchMarketPrices({ fetch: f, cache });
    expect(calls.length).toBe(8);
  });
});
