import { readTextCapped } from "../read";
import { parseAkash, parseRunpod, parseVast, parseVultr, runpodAnswered } from "./parse";
import { SOURCE_LABELS, SOURCES, type MarketPrice, type PriceSource, type SourceStatus } from "./types";

/**
 * Live prices from four providers that publish them without an account. Fixed URLs, plain
 * requests: only an accept header (and RunPod's JSON query), no cookies, nothing about the owner.
 * Read-only: nothing here can pay.
 */

export type MarketPrices = { prices: MarketPrice[]; sources: SourceStatus[]; asOf: number };
export type PriceCache = { entry: { at: number; promise: Promise<MarketPrices> } | null };

const TIMEOUT_MS = 6_000;
const CACHE_MS = 60_000;

const VAST_QUERY = { rentable: { eq: true }, verified: { eq: true }, num_gpus: { eq: 1 }, order: [["dph_total", "asc"]], limit: 40 };
/**
 * Per GPU type: both tiers' prices, whether RunPod offers each tier at all, and whether either has stock
 * for one GPU right now. A price with no stock behind it (RunPod lists $0.50 placeholders) is not shown.
 */
const RUNPOD_QUERY = {
  query:
    "{ gpuTypes { id displayName memoryInGb communityPrice securePrice communitySpotPrice secureSpotPrice communityCloud secureCloud community: lowestPrice(input: { gpuCount: 1, secureCloud: false }) { stockStatus } secure: lowestPrice(input: { gpuCount: 1, secureCloud: true }) { stockStatus } } }",
};

export const PRICE_URLS: Record<PriceSource, string> = {
  vultr: "https://api.vultr.com/v2/plans?per_page=500",
  vast: `https://console.vast.ai/api/v0/bundles/?q=${encodeURIComponent(JSON.stringify(VAST_QUERY))}`,
  runpod: "https://api.runpod.io/graphql",
  akash: "https://console-api.akash.network/v1/gpu-prices",
};

const PARSERS: Record<PriceSource, (raw: unknown) => MarketPrice[]> = { vultr: parseVultr, vast: parseVast, runpod: parseRunpod, akash: parseAkash };

const UNREADABLE = "sent something this app could not read";
/** Sources whose well-formed answer can honestly hold no prices (nothing in stock), and the note said then. */
const EMPTY_ANSWER: Partial<Record<PriceSource, (raw: unknown) => boolean>> = { runpod: runpodAnswered };
const NOTHING_IN_STOCK = "has nothing in stock right now";

class SourceError extends Error {}

function requestFor(source: PriceSource, signal: AbortSignal): RequestInit {
  const common = { credentials: "omit" as const, cache: "no-store" as const, redirect: "error" as const, signal };
  if (source === "runpod") return { ...common, method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(RUNPOD_QUERY) };
  return { ...common, method: "GET", headers: { accept: "application/json" } };
}

type Parsers = Partial<Record<PriceSource, (raw: unknown) => MarketPrice[]>>;

async function readSource(source: PriceSource, fetchImpl: typeof fetch, timeoutMs: number, parsers: Parsers): Promise<{ prices: MarketPrice[]; note: string | null }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(PRICE_URLS[source], requestFor(source, signal));
  } catch {
    throw new SourceError(signal.aborted ? "did not answer in time" : "could not be reached");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new SourceError(`answered HTTP ${response.status}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readTextCapped(response));
  } catch {
    throw new SourceError(signal.aborted ? "did not answer in time" : UNREADABLE);
  }
  let prices: MarketPrice[];
  try {
    prices = (parsers[source] ?? PARSERS[source])(raw);
  } catch {
    throw new SourceError(UNREADABLE);
  }
  if (Array.isArray(prices) && prices.length === 0 && EMPTY_ANSWER[source]?.(raw)) return { prices: [], note: NOTHING_IN_STOCK };
  if (!Array.isArray(prices) || prices.length === 0) throw new SourceError(UNREADABLE);
  return { prices, note: null };
}

async function fetchAll(fetchImpl: typeof fetch, timeoutMs: number, now: () => number, parsers: Parsers): Promise<MarketPrices> {
  const results = await Promise.allSettled(SOURCES.map((s) => Promise.resolve().then(() => readSource(s, fetchImpl, timeoutMs, parsers))));
  const prices: MarketPrice[] = [];
  const sources: SourceStatus[] = results.map((r, i) => {
    const source = SOURCES[i];
    const label = SOURCE_LABELS[source];
    if (r.status === "fulfilled") {
      prices.push(...r.value.prices);
      return { source, label, ok: true, count: r.value.prices.length, note: r.value.note };
    }
    const note = r.reason instanceof SourceError ? r.reason.message : "could not be reached";
    return { source, label, ok: false, count: 0, note };
  });
  return { prices, sources, asOf: now() };
}

const defaultCache: PriceCache = ((globalThis as unknown as { __burn402PriceCache?: PriceCache }).__burn402PriceCache ??= { entry: null });

/**
 * All four sources in parallel, each with its own timeout and the 2 MB cap. A failed source is
 * reported (`ok: false`, a short note) and gives no prices. One answer is kept for 60 s and a
 * request in flight is shared, so a run and the Compare action do not hammer the providers.
 * Never throws.
 */
export function fetchMarketPrices(
  deps: { fetch?: typeof fetch; timeoutMs?: number; now?: () => number; cache?: PriceCache; /** tests only */ parsers?: Parsers } = {},
): Promise<MarketPrices> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? defaultCache;
  const t = now();
  if (cache.entry && t - cache.entry.at < CACHE_MS && t >= cache.entry.at) return cache.entry.promise;
  const promise = fetchAll(fetchImpl, deps.timeoutMs ?? TIMEOUT_MS, now, deps.parsers ?? {});
  const entry = { at: t, promise };
  cache.entry = entry;
  void promise.then((r) => {
    if (!r.sources.some((s) => s.ok) && cache.entry === entry) cache.entry = null;
  });
  return promise;
}
