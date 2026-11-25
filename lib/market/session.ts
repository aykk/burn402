import { join } from "node:path";
import { parseNuzaFeed } from "./catalog";
import { choose } from "./choose";
import { findPayment } from "./chain";
import { NETWORKS } from "./guard";
import { defaultJournal, type Journal } from "./journal";
import { localHosts, localVerdict } from "./local";
import { makePayer, type Payer } from "./pay";
import { buyableFrom, comparePrices, type PriceComparison } from "./prices/compare";
import { fetchMarketPrices, type MarketPrices } from "./prices/fetch";
import type { MarketRunDeps } from "./run";
import { SELLERS, SellerClient } from "./seller";
import type { Limits, MarketId, Need, Offer } from "./types";

/** Wiring for the app: wallets, sellers, journal and feeds from env. Keys are never logged. */

const NUZA_URL = "https://nuza.io/api/v1/pricing";
const NUZA_TIMEOUT_MS = 5_000;
const REGION_RE = /^[a-z0-9:-]{2,20}$/;

type Env = Record<string, string | undefined>;

/** The secret that pays on a market: the test market uses the agent wallet; the real one prefers its own. */
export function secretFor(market: MarketId, env: Env = process.env): string | null {
  const key = market === "real" ? env.MAINNET_SOLANA_SECRET_KEY || env.AGENT_SOLANA_SECRET_KEY : env.AGENT_SOLANA_SECRET_KEY;
  return key ? key : null;
}

/** "A key is configured", not "it has funds". The test market also needs the test seller's receiver. */
export function walletReady(env: Env = process.env): { test: boolean; real: boolean } {
  return { test: !!secretFor("test", env) && !!env.SOLANA_RECEIVER_ADDRESS, real: !!secretFor("real", env) };
}

type PayerCache = Map<string, Promise<Payer>>;
const payers: PayerCache = ((globalThis as unknown as { __burn402MarketPayers?: PayerCache }).__burn402MarketPayers ??= new Map());

/** Built on first use and cached per key; null when no key is set. A bad key throws a message without the key. */
export async function payerFor(market: MarketId): Promise<Payer | null> {
  const secret = secretFor(market);
  if (!secret) return null;
  let p = payers.get(secret);
  if (!p) {
    p = makePayer(secret).catch(() => {
      payers.delete(secret);
      throw new Error(`the wallet key for the ${market === "real" ? "real" : "test"} market is not a valid Solana keypair`);
    });
    payers.set(secret, p);
  }
  return p;
}

export function sellerFor(market: MarketId, payer: Payer | null): SellerClient {
  return new SellerClient(SELLERS[market], { signer: payer?.signer ?? null });
}

/** The read-only chain check a run uses after a signed payment: this market's RPC and USDC mint. */
export function findPaymentFor(market: MarketId, fetchImpl?: typeof fetch): NonNullable<MarketRunDeps["findPayment"]> {
  const net = NETWORKS[market];
  return (q) => findPayment({ rpcUrl: net.rpcUrl, mint: net.usdc, ...q, fetch: fetchImpl });
}

export function marketJournal(root: string = process.cwd()): Journal {
  return defaultJournal(root);
}

export function sshKeyDir(root: string = process.cwd()): string {
  return join(root, ".burn402", "keys", "rentals");
}

/** nuza's spot GPU prices, for comparison on the real market only. */
export async function nuzaFeed(fetchImpl: typeof fetch = fetch): Promise<Offer[]> {
  const response = await fetchImpl(NUZA_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(NUZA_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`nuza answered ${response.status}`);
  return parseNuzaFeed(await response.json());
}

/** True when the request was addressed to this app by its local name; a DNS-rebinding page arrives with its own host name. */
export function isLocalHost(request: Request): boolean {
  return localHosts().has(request.headers.get("host") ?? "");
}

/** Market routes: local host, same-origin JSON only, so another website cannot drive a run through the browser. */
export function checkRequest(request: Request): Response | null {
  const refused = localVerdict({ host: request.headers.get("host"), origin: request.headers.get("origin") }, { origin: true });
  if (refused) return Response.json({ error: refused }, { status: 403 });
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) return Response.json({ error: "send the request as JSON (Content-Type: application/json)" }, { status: 415 });
  return null;
}

export type RunInput = { market: MarketId; need: Need; limits: Limits; askBeforePaying: boolean };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** Checks one need field; returns an error in plain English, or null when the value is fine. */
function needFieldError(key: keyof Need, v: unknown): string | null {
  switch (key) {
    case "kind":
      return v === "cpu" || v === "gpu" ? null : "pick CPU or GPU";
    case "vcpus":
      return inRange(v, 1, 64) && Number.isInteger(v) ? null : "vCPUs must be a whole number from 1 to 64";
    case "ramGb":
      return inRange(v, 0.5, 512) ? null : "RAM must be from 0.5 to 512 GB";
    case "vramGb":
      return inRange(v, 0, 200) ? null : "GPU memory must be from 0 to 200 GB";
    case "hours":
      return inRange(v, 1 / 60, 72) ? null : "hours must be from 1 minute to 72 hours";
    case "regions":
      if (!Array.isArray(v)) return "regions must be a list";
      if (v.length > 10) return "pick at most 10 regions";
      return v.every((r) => typeof r === "string" && REGION_RE.test(r)) ? null : "a region name must be 2 to 20 lowercase letters, digits, colons or dashes";
    case "allowSpot":
      return typeof v === "boolean" ? null : "say whether interruptible machines are OK";
  }
}

const NEED_KEYS: (keyof Need)[] = ["kind", "vcpus", "ramGb", "vramGb", "hours", "regions", "allowSpot"];

/** The one rule for a need, shared by a run and the price comparison. Extra fields are dropped. */
export function parseNeed(need: unknown): { ok: true; value: Need } | { ok: false; error: string } {
  if (!isObj(need)) return { ok: false, error: "say what machine you need" };
  for (const key of NEED_KEYS) {
    const error = needFieldError(key, need[key]);
    if (error) return { ok: false, error };
  }
  const n = need as Need;
  return { ok: true, value: { kind: n.kind, vcpus: n.vcpus, ramGb: n.ramGb, vramGb: n.vramGb, hours: n.hours, regions: [...n.regions], allowSpot: n.allowSpot } };
}

export function parseRunInput(body: unknown): { ok: true; value: RunInput } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "send the run as a JSON object" };
  const { market, budgetUsd, rateUsdHr, askBeforePaying } = body;
  if (market !== "test" && market !== "real") return { ok: false, error: "pick the test market or the real market" };
  const need = parseNeed(body.need);
  if (!need.ok) return need;
  if (!inRange(budgetUsd, 0.01, 20)) return { ok: false, error: "the budget must be from $0.01 to $20" };
  if (!inRange(rateUsdHr, 0.001, Math.min(budgetUsd, 20))) return { ok: false, error: "the hourly limit must be from $0.001 up to the budget" };
  if (typeof askBeforePaying !== "boolean") return { ok: false, error: "say whether to ask before paying" };
  return {
    ok: true,
    value: {
      market,
      need: need.value,
      limits: { budgetUsd, rateUsdHr },
      askBeforePaying,
    },
  };
}

/**
 * Reads the model's reply to "describe what you need". Only fields that pass the same checks
 * as the form are kept; the model never picks a plan or touches payment.
 */
export function needFromModelReply(text: string): { need: Partial<Need>; note: string } {
  const match = /\{[\s\S]*\}/.exec(text);
  let raw: unknown = null;
  try {
    raw = match ? JSON.parse(match[0]) : null;
  } catch {
    raw = null;
  }
  if (!isObj(raw)) return { need: {}, note: "the model's answer could not be read; fill the form by hand" };
  const need: Partial<Need> = {};
  for (const key of NEED_KEYS) {
    if (raw[key] === undefined || needFieldError(key, raw[key])) continue;
    (need as Record<string, unknown>)[key] = key === "regions" ? [...(raw[key] as string[])] : raw[key];
  }
  const note = typeof raw.note === "string" ? raw.note.slice(0, 300) : "";
  return { need, note: note || (Object.keys(need).length ? "filled from your description; check the fields" : "nothing in the description matched the form") };
}

export type PricesInput = { market: MarketId; need: Need };

/** Body of POST /api/market/prices: a market and a need, checked with the run's own rules. */
export function parsePricesInput(body: unknown): { ok: true; value: PricesInput } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "send the request as a JSON object" };
  const { market } = body;
  if (market !== "test" && market !== "real") return { ok: false, error: "pick the test market or the real market" };
  const need = parseNeed(body.need);
  if (!need.ok) return need;
  return { ok: true, value: { market, need: need.value } };
}

/** Live prices from other providers for a run (cached for 60 s, never throws). */
export function marketPricesFeed(): Promise<MarketPrices> {
  return fetchMarketPrices();
}

/** Generous limits used only to find the cheapest plan that fits; nothing is quoted or paid with them. */
const COMPARE_LIMITS = { budgetUsd: 20, rateUsdHr: 20 };

/**
 * The comparison without a run: market prices beside the cheapest plan the chosen market's seller
 * lists for the need (the chooser's estimate, not a quote). Reads the seller's price list only;
 * never quotes, never pays, never touches the session's run.
 */
export async function priceComparison(
  input: PricesInput,
  deps: { prices?: () => Promise<MarketPrices>; seller?: SellerClient } = {},
): Promise<PriceComparison> {
  const seller = deps.seller ?? sellerFor(input.market, null);
  const [market, catalog] = await Promise.all([
    (deps.prices ?? marketPricesFeed)().catch((): MarketPrices => ({ prices: [], sources: [], asOf: Date.now() })),
    seller.catalog().catch(() => null),
  ]);
  const top = catalog ? choose(catalog.offers, input.need, COMPARE_LIMITS, catalog.rules).ranked[0] : undefined;
  const buyable = top ? buyableFrom({ seller: seller.config.label, plan: top.offer.id, totalUsd: top.estimateUsd, hours: top.hours, firm: false }) : null;
  return comparePrices({ prices: market.prices, sources: market.sources, asOf: market.asOf, need: input.need, buyable });
}
