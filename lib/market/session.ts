import { join } from "node:path";
import { parseNuzaFeed } from "./catalog";
import { choose, summarize, type RejectReason } from "./choose";
import { findPayment } from "./chain";
import { NETWORKS } from "./guard";
import { defaultJournal, type Journal } from "./journal";
import { accessVerdict, headersOf, visitorOf } from "./access";
import { isWalletAddress, makeDelegatePayer } from "./delegate";
import { makePayer, type Payer } from "./pay";
import { buyableFor, comparePrices, type PriceComparison } from "./prices/compare";
import { fetchMarketPrices, type MarketPrices } from "./prices/fetch";
import type { MarketRunDeps } from "./run";
import { SELLERS, SellerClient } from "./seller";
import type { Limits, MarketId, Need, Offer } from "./types";

/** Wiring for the app: wallets, sellers, journal and feeds from env. Keys are never logged. */

const NUZA_URL = "https://nuza.io/api/v1/pricing";
const NUZA_TIMEOUT_MS = 5_000;
const REGION_RE = /^[a-z0-9:-]{2,20}$/;

type Env = Record<string, string | undefined>;

/** Whose rental it is: the owner's, or a public visitor's. */
export type Audience = "owner" | "public";

/**
 * The agent key for a market: the test market uses the agent wallet; the real one prefers its own.
 * Public visitors' REAL rentals get an agent identity of their own when PUBLIC_MAINNET_SOLANA_SECRET_KEY
 * is set, so their machines are never on the same wallet's list as the owner's.
 */
export function secretFor(market: MarketId, env: Env = process.env, audience: Audience = "owner"): string | null {
  if (market !== "real") return env.AGENT_SOLANA_SECRET_KEY || null;
  // no falling back to the owner's key: a stranger's real rental is signed by the visitors' key or not at all
  if (audience === "public") return env.PUBLIC_MAINNET_SOLANA_SECRET_KEY || null;
  return env.MAINNET_SOLANA_SECRET_KEY || env.AGENT_SOLANA_SECRET_KEY || null;
}

/** "A key is configured", not "it has funds". The test market also needs the test seller's receiver. */
export function walletReady(env: Env = process.env): { test: boolean; real: boolean } {
  return { test: !!secretFor("test", env) && !!env.SOLANA_RECEIVER_ADDRESS, real: !!secretFor("real", env) };
}

type PayerCache = Map<string, Promise<Payer>>;
const payers: PayerCache = ((globalThis as unknown as { __burn402MarketPayers?: PayerCache }).__burn402MarketPayers ??= new Map());

/** Built on first use and cached per key; null when no key is set. A bad key throws a message without the key. */
/**
 * Payments from one wallet are signed one at a time, a little apart. Many visitors share the test
 * wallet; two identical transfers built on the same blockhash would be the same transaction, and the
 * chain would take only one of them.
 */
const PAYMENT_GAP_MS = 1500;
function spaced(payer: Payer): Payer {
  let last: Promise<unknown> = Promise.resolve();
  return {
    ...payer,
    payHeaders(required) {
      const turn = last.then(() => payer.payHeaders(required));
      // the next payment waits for this one to be signed, whether it worked or not, then a little longer
      last = turn.catch(() => {}).then(() => new Promise((r) => setTimeout(r, PAYMENT_GAP_MS)));
      return turn;
    },
  };
}

export async function payerFor(market: MarketId, audience: Audience = "owner"): Promise<Payer | null> {
  const secret = secretFor(market, process.env, audience);
  if (!secret) return null;
  let p = payers.get(secret);
  if (!p) {
    p = makePayer(secret).then(spaced).catch(() => {
      payers.delete(secret);
      throw new Error(`the wallet key for the ${market === "real" ? "real" : "test"} market is not a valid Solana keypair`);
    });
    payers.set(secret, p);
  }
  return p;
}

/**
 * A payer for one run that spends a connected wallet's USDC under that wallet's approval. The agent's
 * key for the market signs; null when none is set. Not cached: it belongs to one visitor's run.
 */
export async function delegatePayerFor(market: MarketId, wallet: string, audience: Audience = "owner"): Promise<Payer | null> {
  const secret = secretFor(market, process.env, audience);
  if (!secret) return null;
  return makeDelegatePayer(secret, { market, owner: wallet });
}

/**
 * The agent wallet that owns a purchase's machine, to manage it later: the one whose address the journal
 * recorded with the purchase, else the owner's. A machine answers only to the wallet that paid for it.
 */
export async function payerOwning(market: MarketId, agent: string | null | undefined): Promise<Payer | null> {
  const owner = await payerFor(market, "owner");
  if (!agent || owner?.address === agent) return owner;
  const visitor = await payerFor(market, "public");
  return visitor?.address === agent ? visitor : owner;
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

/** True when the request was made on this computer, addressed to the app by its local name (never through a tunnel). */
export function isOwner(request: Request): boolean {
  return visitorOf(headersOf(request.headers))?.kind === "owner";
}

/** The largest request body a market route reads: every one of them is a few fields of JSON. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Market routes: the owner's local page or a listed public host, same-origin JSON only (so another
 * website cannot drive a run through the browser), and small.
 */
export function checkRequest(request: Request): Response | null {
  const refused = accessVerdict(request.method, new URL(request.url).pathname, headersOf(request.headers));
  if (refused) return Response.json({ error: refused }, { status: 403 });
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) return Response.json({ error: "send the request as JSON (Content-Type: application/json)" }, { status: 415 });
  // the size must be stated: a body sent in chunks with no length would be read whole into memory
  const stated = request.headers.get("content-length");
  if (stated === null || !/^\d{1,9}$/.test(stated)) return Response.json({ error: "send the request with a Content-Length" }, { status: 411 });
  if (Number(stated) > MAX_BODY_BYTES) return Response.json({ error: "that request is too large" }, { status: 413 });
  return null;
}

export type RunInput = {
  market: MarketId;
  need: Need;
  limits: Limits;
  askBeforePaying: boolean;
  /** the connected wallet to pay from, or null for the agent's own */
  wallet: string | null;
  /** the renter's own SSH public key, or null to have one made on this computer */
  sshPublicKey: string | null;
};

/** One line of an OpenSSH public key: a key type this app knows, the key, and an optional short comment. */
const SSH_PUBLIC_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]{60,1100}={0,2})( [\x20-\x7e]{0,80})?$/;

/**
 * The key as it will be handed to the seller, or null when it is not a public key line. A private key
 * never passes. Only the type and the key itself go on: the comment is the renter's free text, and how the
 * seller writes the line into a machine is not ours to know, so it is dropped.
 */
export function sshPublicKeyOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const line = v.trim();
  if (line.length > 1300) return null;
  const m = SSH_PUBLIC_KEY_RE.exec(line);
  return m ? `${m[1]} ${m[2]}` : null;
}

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

/** The one rule for a budget and an hourly limit, shared by a run and the price comparison. */
export function parseLimits(budgetUsd: unknown, rateUsdHr: unknown): { ok: true; value: Limits } | { ok: false; error: string } {
  if (!inRange(budgetUsd, 0.01, 20)) return { ok: false, error: "the budget must be from $0.01 to $20" };
  if (!inRange(rateUsdHr, 0.001, Math.min(budgetUsd, 20))) return { ok: false, error: "the hourly limit must be from $0.001 up to the budget" };
  return { ok: true, value: { budgetUsd, rateUsdHr } };
}

export function parseRunInput(body: unknown): { ok: true; value: RunInput } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "send the run as a JSON object" };
  const { market, budgetUsd, rateUsdHr, askBeforePaying, wallet, sshPublicKey } = body;
  if (market !== "test" && market !== "real") return { ok: false, error: "pick the test market or the real market" };
  const need = parseNeed(body.need);
  if (!need.ok) return need;
  const limits = parseLimits(budgetUsd, rateUsdHr);
  if (!limits.ok) return limits;
  if (typeof askBeforePaying !== "boolean") return { ok: false, error: "say whether to ask before paying" };
  if (wallet !== undefined && wallet !== null && !isWalletAddress(wallet)) return { ok: false, error: "that is not a Solana wallet address" };
  const hasKey = sshPublicKey !== undefined && sshPublicKey !== null && sshPublicKey !== "";
  const key = hasKey ? sshPublicKeyOf(sshPublicKey) : null;
  if (hasKey && key === null) return { ok: false, error: "that is not an SSH public key; paste the one line from your .pub file (it starts with ssh-ed25519 or ssh-rsa)" };
  return {
    ok: true,
    value: {
      market,
      need: need.value,
      limits: limits.value,
      // a connected wallet approves each payment itself
      askBeforePaying: wallet ? true : askBeforePaying,
      wallet: typeof wallet === "string" ? wallet : null,
      sshPublicKey: key,
    },
  };
}

export type PricesInput = { market: MarketId; need: Need; limits?: Limits };

/** Body of POST /api/market/prices: a market, a need and optional limits, checked with the run's own rules. */
export function parsePricesInput(body: unknown): { ok: true; value: PricesInput } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "send the request as a JSON object" };
  const { market } = body;
  if (market !== "test" && market !== "real") return { ok: false, error: "pick the test market or the real market" };
  const need = parseNeed(body.need);
  if (!need.ok) return need;
  const { budgetUsd, rateUsdHr } = body;
  if (budgetUsd === undefined && rateUsdHr === undefined) return { ok: true, value: { market, need: need.value } };
  if (budgetUsd === undefined || rateUsdHr === undefined) return { ok: false, error: "send both the budget and the hourly limit, or neither" };
  const limits = parseLimits(budgetUsd, rateUsdHr);
  if (!limits.ok) return limits;
  return { ok: true, value: { market, need: need.value, limits: limits.value } };
}

/** The plans that fit a need, as the page lists them while the filters are being set: no run, no quote, nothing paid. */
export type PlanPreview = {
  market: MarketId;
  seller: string;
  /** when the seller's price list was read (ms) */
  asOf: number;
  /** plans on the price list, and how many of them fit the need and the limits */
  total: number;
  fits: number;
  /** the cheapest that fit, cheapest first and at the same price the better machine first: the order the agent would ask them in */
  plans: { id: string; provider: string; kind: "cpu" | "gpu"; vcpus: number; ramGb: number; vramGb: number; gpu: string | null; regions: number; spot: boolean; hourlyUsd: number; listHourlyUsd: number | null; hours: number; estimateUsd: number }[];
  leftOut: { reason: RejectReason; count: number }[];
};

const PREVIEW_ROWS = 8;
/** The price list is read from the seller at most this often, however fast the filters change. */
const CATALOG_TTL_MS = 60_000;

type Catalog = Awaited<ReturnType<SellerClient["catalog"]>>;
type CatalogCache = Map<MarketId, { at: number; value: Promise<Catalog> }>;
const catalogs: CatalogCache = ((globalThis as unknown as { __burn402Catalogs?: CatalogCache }).__burn402Catalogs ??= new Map());

/** The seller's price list, read once a minute at most and shared by every visitor. A failed read is not kept. */
export function cachedCatalog(market: MarketId, deps: { seller?: SellerClient; now?: () => number; cache?: CatalogCache } = {}): Promise<{ catalog: Catalog; asOf: number }> {
  const now = (deps.now ?? Date.now)();
  const cache = deps.cache ?? catalogs;
  let entry = cache.get(market);
  if (!entry || now - entry.at >= CATALOG_TTL_MS) {
    const seller = deps.seller ?? new SellerClient(SELLERS[market], { signer: null, timeouts: { read: COMPARE_SELLER_TIMEOUT_MS, paid: COMPARE_SELLER_TIMEOUT_MS } });
    const made = { at: now, value: Promise.resolve().then(() => seller.catalog()) };
    made.value.catch(() => {
      if (cache.get(market) === made) cache.delete(market);
    });
    cache.set(market, made);
    entry = made;
  }
  const at = entry.at;
  return entry.value.then((catalog) => ({ catalog, asOf: at }));
}

/**
 * What the agent would look at for this need, from the price list alone: the plans that fit inside the
 * limits in the order it would ask them for a firm quote, and what was left out and why. Estimates, never
 * quotes. Reads the (cached) price list only; never quotes, pays or touches a run.
 */
export async function planPreview(input: PricesInput & { limits: Limits }, deps: Parameters<typeof cachedCatalog>[1] = {}): Promise<PlanPreview> {
  const { catalog, asOf } = await cachedCatalog(input.market, deps);
  const { ranked, rejected } = choose(catalog.offers, input.need, input.limits, catalog.rules);
  return {
    market: input.market,
    seller: (deps.seller ?? { config: SELLERS[input.market] }).config.label,
    asOf,
    total: catalog.offers.length,
    fits: ranked.length,
    plans: ranked.slice(0, PREVIEW_ROWS).map((c) => ({
      id: c.offer.id,
      provider: c.offer.provider,
      kind: c.offer.kind,
      vcpus: c.offer.vcpus,
      ramGb: c.offer.ramGb,
      vramGb: c.offer.vramGb,
      gpu: c.offer.gpu,
      regions: c.regions.length,
      spot: c.offer.spot,
      hourlyUsd: c.offer.hourlyUsd,
      listHourlyUsd: c.offer.listHourlyUsd,
      hours: c.hours,
      estimateUsd: c.estimateUsd,
    })),
    leftOut: summarize(rejected),
  };
}

/** Live prices from other providers for a run (cached for 60 s, never throws). */
export function marketPricesFeed(): Promise<MarketPrices> {
  return fetchMarketPrices();
}

/** The seller's price list read for a comparison gets its own limit, well under the 30 s a run allows it. */
const COMPARE_SELLER_TIMEOUT_MS = 10_000;

/** Rejects after `ms`; the timer never keeps the process alive. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("did not answer in time")), ms);
    (t as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Generous limits used, when the owner gave none, only to find the cheapest plan that fits; nothing is quoted or paid with them. */
const COMPARE_LIMITS = { budgetUsd: 20, rateUsdHr: 20 };

/**
 * The comparison without a run: market prices beside the plan a run would rank first (the
 * chooser's estimate, not a quote), inside the owner's limits when given, else generous ones.
 * Spot offers are never the buyable figure. Reads the seller's price list only (within 10 s; a list that
 * cannot be read is said plainly, never as "no seller"); never quotes, never pays, never touches the session's run.
 */
export async function priceComparison(
  input: PricesInput,
  deps: { prices?: () => Promise<MarketPrices>; seller?: SellerClient; /** tests only */ sellerTimeoutMs?: number } = {},
): Promise<PriceComparison> {
  const timeoutMs = deps.sellerTimeoutMs ?? COMPARE_SELLER_TIMEOUT_MS;
  const seller = deps.seller ?? new SellerClient(SELLERS[input.market], { signer: null, timeouts: { read: timeoutMs, paid: timeoutMs } });
  const [market, catalog] = await Promise.all([
    (deps.prices ?? marketPricesFeed)().catch((): MarketPrices => ({ prices: [], sources: [], asOf: Date.now() })),
    // the price list is read at most once a minute for everyone (a seller handed in by a test is asked directly)
    within(deps.seller ? Promise.resolve().then(() => seller.catalog()) : cachedCatalog(input.market).then((c) => c.catalog), timeoutMs).catch(() => null),
  ]);
  const top = catalog ? choose(catalog.offers, input.need, input.limits ?? COMPARE_LIMITS, catalog.rules).ranked.find((c) => !c.offer.spot && c.offer.rentable) : undefined;
  const buyable =
    top && catalog
      ? buyableFor({ seller: seller.config.label, offer: top.offer, totalUsd: top.estimateUsd, billedHours: top.hours, askedHours: input.need.hours, rules: catalog.rules, firm: false })
      : null;
  return comparePrices({ prices: market.prices, sources: market.sources, asOf: market.asOf, need: input.need, buyable, limited: !!input.limits && !!catalog, sellerUnreadable: !catalog });
}
