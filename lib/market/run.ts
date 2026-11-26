import { randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { DEFAULT_RULES } from "./types";
import { choose, summarize, type Candidate, type RejectReason, type Rejection } from "./choose";
import { checkPayment, NETWORKS, type Accepts } from "./guard";
import { usdExact } from "./money";
import type { Journal, JournalEntry } from "./journal";
import { payerSignatureOf, type Payer, type PaymentRequired } from "./pay";
import { QuoteError, type Instance, type ProvisionOutcome, type Quote, type SellerClient } from "./seller";
import { newSshKey } from "./sshkey";
import { buyableFor, comparePrices, type Buyable, type PriceComparison } from "./prices/compare";
import type { MarketPrices } from "./prices/fetch";
import type { HourlyRules, Limits, MarketId, Need, Offer } from "./types";

export type MarketPhase = "scanning" | "choosing" | "quoting" | "approval" | "paying" | "provisioning" | "ready" | "releasing" | "released" | "failed" | "refused";

export type OfferRow = {
  seller: string;
  id: string;
  provider: string;
  kind: "cpu" | "gpu";
  vcpus: number;
  ramGb: number;
  vramGb: number;
  gpu: string | null;
  region: string | null;
  hours: number | null;
  listHourlyUsd: number | null;
  hourlyUsd: number;
  estimateUsd: number | null;
  quoteUsd: number | null;
  /** the firm quote in exact dollars ("$0.010382"), when quoted */
  quoteExact: string | null;
  state: "chosen" | "quoted" | "candidate" | "quote failed" | "left out";
  /** plain words for the owner */
  note: string | null;
  /** machine code behind the note (a RejectReason, guard or quote error code) */
  code: string | null;
};

export type PurchaseRecord = { at: number; outcome: "accepted" | "refused" | "failed"; reason: string | null; plan: string; region: string; usd: number | null; tx: string | null; server: string | null };

export type MarketRunView = {
  id: string;
  market: MarketId;
  marketLabel: string;
  phase: MarketPhase;
  need: Need;
  limits: Limits;
  askBeforePaying: boolean;
  agent: { name: string; ansName: string };
  sources: { name: string; ok: boolean; count: number; note: string | null }[];
  rows: OfferRow[];
  leftOut: { reason: string; count: number }[];
  approval: {
    code: string;
    usd: number;
    atomic: string;
    /** the exact amount in dollars, e.g. "$0.010382" */
    exact: string;
    /** the seller's short-rental surcharge included in the amount, if any */
    surcharge: { pct: number; underHours: number } | null;
    token: "USDC";
    network: string;
    payTo: string;
    plan: string;
    region: string;
    hours: number;
    seller: string;
  } | null;
  /**
   * Set as soon as the signed payment is sent ("unconfirmed"); "confirmed" once the seller reports
   * success or the transfer is found on chain. `usd` is the signed amount.
   */
  payment: { usd: number; atomic: string; tx: string | null; at: number; payer: string; status: "confirmed" | "unconfirmed" } | null;
  /** "nothing" only when no payment was ever signed; "paid" when confirmed; "maybe" otherwise. */
  spent: "nothing" | "paid" | "maybe";
  /** plain notes when the agent used another region or plan than its first choice */
  fallbacks: string[];
  /** true for the runs the overspend test makes; the owner's runs are false */
  overspendTest: boolean;
  machine: {
    id: string;
    ip: string | null;
    status: string;
    expiresAt: number | null;
    destroyAt: number | null;
    ssh: string | null;
    port22: "open" | "closed" | "not checked";
    plan: string;
    region: string;
  } | null;
  attempts: { at: number; plan: string; region: string; what: string; ok: boolean; code: string | null }[];
  startedAt: number;
  paidAt: number | null;
  readyAt: number | null;
  releasedAt: number | null;
  error: string | null;
  refusal: { code: string; detail: string } | null;
  /**
   * Read-only prices from other providers beside what this run can buy. Null until the chooser
   * has ranked plans and the prices have arrived, or when they could not be read. Never a quote.
   */
  prices: PriceComparison | null;
};

export type MarketRunDeps = {
  id: string;
  market: MarketId;
  seller: SellerClient;
  spotFeed?: () => Promise<Offer[]>;
  payer: Payer | null;
  journal: Journal;
  need: Need;
  limits: Limits;
  askBeforePaying: boolean;
  agent: { name: string; ansName: string };
  keyDir: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One connection attempt to port 22; the run retries. */
  probePort?: (ip: string) => Promise<boolean>;
  newCode?: () => string;
  onRecord?: (record: PurchaseRecord) => void;
  log?: (line: string) => void;
  /**
   * Looks on chain for this run's transfer to the seller. Absent means the run cannot check.
   * Never asked to pay; read-only.
   */
  findPayment?: (q: { payer: string; payTo: string; atomic: string; sinceMs: number; signature?: string; exclude?: string[] }) => Promise<{ tx: string } | null | "unavailable">;
  /** marks the overspend test's runs so they can never pass for the owner's */
  overspendTest?: boolean;
  /**
   * Live prices from providers the agent cannot buy from, shown beside the plan it can buy.
   * Absent means no comparison. Started with the scan; never awaited, never chooses or pays.
   */
  marketPrices?: () => Promise<MarketPrices>;
};

const MAX_QUOTES = 3;
const MAX_QUOTE_FAILURES = 8;
const MAX_REGIONS = 3;
const MAX_FALLBACKS = 3;
const UNKNOWN_POLL_MS = 10_000;
const UNKNOWN_POLLS = 30; // 5 minutes
const ACTIVE_POLL_MS = 5_000;
const ACTIVE_POLLS = 120; // 10 minutes
const PROBE_TRIES = 12;
const PROBE_GAP_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;
const EXPIRY_SLACK_MS = 120_000;
const MAX_TIMER_MS = 2_147_483_647;
const NO_WALLET = "Nothing was paid: no wallet is set up for this market.";
const CHAIN_CHECKS = 6;
const CHAIN_GAP_MS = 5_000;
const FALLBACK_CODES = new Set(["OUT_OF_STOCK", "SELLER_ERROR"]);
const TEST_NET_3 = /^203\.0\.113\.\d{1,3}$/;
const DESTROY_RETRY_MS = 60_000;
const DESTROY_RETRIES = 10;
const STOPPED = "You stopped the run before anything was paid.";
const CANCELLED = "You cancelled before paying. Nothing was spent.";
const ALREADY_PAID = "This run already made a payment, so the agent will not pay again.";

/** Why a chooser left a plan out, in words. */
export function leftOutWords(reason: RejectReason | string, need: Pick<Need, "kind">): string {
  switch (reason) {
    case "WRONG_KIND":
      return need.kind === "cpu" ? "GPU plans (you asked for CPU)" : "CPU plans (you asked for a GPU)";
    case "TOO_SMALL":
      return "too small";
    case "OUT_OF_STOCK":
      return "out of stock";
    case "NO_REGION":
      return "not in your regions";
    case "SPOT_NOT_ALLOWED":
      return "interruptible (you did not allow that)";
    case "NOT_RENTABLE":
      return "not for rent by an agent";
    case "OVER_RATE":
      return "over your hourly limit";
    case "OVER_BUDGET":
      return "over your budget";
    default:
      return String(reason).toLowerCase().replace(/_/g, " ");
  }
}

/** How a failed quote or purchase reads in a fallback note ("ewr was out of stock"). */
function failedWords(code: string): string {
  switch (code) {
    case "OUT_OF_STOCK":
      return "was out of stock";
    case "PRICE_CAP":
    case "OVER_BUDGET":
    case "OVER_RATE":
      return "was over your limits";
    case "OVER_QUOTE":
      return "raised its price";
    case "WRONG_ASSET":
    case "WRONG_NETWORK":
    case "MALFORMED":
    case "NO_402":
      return "asked for a payment the agent will not make";
    case "UNREACHABLE":
      return "could not be reached";
    default:
      return "could not be bought";
  }
}

const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A seller-supplied address is used only when it is a plain IP address. */
const validIp = (ip: string | null): string | null => (ip && net.isIP(ip) ? ip : null);

/**
 * IPv4 addresses the port-22 probe must never connect to: unspecified, private, shared (CGNAT),
 * loopback, link-local, protocol assignments, documentation, benchmarking, multicast and reserved.
 */
const NOT_PUBLIC = (() => {
  const list = new net.BlockList();
  const v4: [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  for (const [base, bits] of v4) list.addSubnet(base, bits, "ipv4");
  return list;
})();

/** IPv6 is an allowlist: only global unicast (2000::/3) is probed. */
const GLOBAL_V6 = (() => {
  const list = new net.BlockList();
  list.addSubnet("2000::", 3, "ipv6");
  return list;
})();

/**
 * Special blocks the probe never connects to, even inside 2000::/3: the IETF block (Teredo and
 * others), documentation (both prefixes), 6to4, and the NAT64 prefixes (outside 2000::/3 anyway;
 * listed so the table says so).
 */
const SPECIAL_V6 = (() => {
  const list = new net.BlockList();
  const v6: [string, number][] = [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["3fff::", 20],
    ["2002::", 16],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
  ];
  for (const [base, bits] of v6) list.addSubnet(base, bits, "ipv6");
  return list;
})();

/** True for a public address the probe may connect to. `ip` is already a valid IP. */
export function probeable(ip: string): boolean {
  try {
    if (!net.isIPv6(ip)) return !NOT_PUBLIC.check(ip, "ipv4");
    if (ip.includes("%")) return false; // a zone id only makes sense on a local link
    const mapped = mappedIpv4(ip);
    if (mapped) return !NOT_PUBLIC.check(mapped, "ipv4");
    return GLOBAL_V6.check(ip, "ipv6") && !SPECIAL_V6.check(ip, "ipv6");
  } catch {
    return false; // anything that cannot be checked is not probed
  }
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d in any spelling), else null. */
function mappedIpv4(ip: string): string | null {
  let canon: string;
  try {
    canon = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase(); // canonical: ::ffff:a00:1
  } catch {
    return null;
  }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const keyOf = (seller: string, id: string) => `${seller}\u0000${id}`;

function tcpProbe(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port: 22 });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const shellPath = (p: string) => (/^[\w./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);

/**
 * One purchase: scan, choose, quote, (approval), pay once, wait for the machine, destroy it.
 * Every signed payment goes through `checkPayment`, and at most one is ever produced per run.
 */
export class MarketRun {
  readonly done: Promise<void>;

  private readonly d: MarketRunDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly probe: (ip: string) => Promise<boolean>;
  private readonly newCode: () => string;
  private resolveDone!: () => void;

  private phase: MarketPhase = "scanning";
  private sources: MarketRunView["sources"] = [];
  private rows: OfferRow[] = [];
  private leftOut: MarketRunView["leftOut"] = [];
  private approval: MarketRunView["approval"] = null;
  private payment: MarketRunView["payment"] = null;
  private machine: MarketRunView["machine"] = null;
  private attempts: MarketRunView["attempts"] = [];
  private readonly startedAt: number;
  private paidAt: number | null = null;
  private readyAt: number | null = null;
  private releasedAt: number | null = null;
  private error: string | null = null;
  private destroyError = false;
  private refusal: MarketRunView["refusal"] = null;
  /** market prices once they arrive; the comparison is built only after the chooser ranked plans */
  private marketData: MarketPrices | null = null;
  private ranksDone = false;
  private buyable: Buyable | null = null;
  /** the quote put forward is for an interruptible plan: `buyable` stays the last on-demand estimate */
  private buyingSpot = false;
  private prices: PriceComparison | null = null;

  private starting: Promise<void> | null = null;
  private ended = false;
  private key: { publicKey: string; privatePath: string } | null = null;
  private quotes: Quote[] = [];
  private readonly used = new Set<Quote>();
  private readonly tried = new Set<string>();
  private quoteFailures = 0;
  private lastQuoteError = "";
  private fallbackCount = 0;
  private fallbackNotes: string[] = [];
  /** plan key -> the regions that failed for it, with the code */
  private readonly failures = new Map<string, { region: string; code: string }[]>();
  private ranked: Candidate[] = [];
  private rules: HourlyRules = DEFAULT_RULES;
  /** when the purchase intent was written, just before signing: the chain is searched from here */
  private intentAt: number | null = null;
  /** the quote shown at the approval stop, or being paid */
  private current: Quote | null = null;
  /** true once the payer has been asked to sign: no fallback and no second payment after this */
  private signing = false;
  private alreadyPaid = false;
  /** The payer's own signature on the sent transaction, when it could be read; the chain check matches on it. */
  private paySignature: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroying: Promise<void> | null = null;
  private destroyRequested = false;
  private recorded = false;
  /** destroy() before any payment: no step may run after this */
  private stopped = false;
  private destroyRetries = 0;

  constructor(deps: MarketRunDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.probe = deps.probePort ?? tcpProbe;
    this.newCode = deps.newCode ?? (() => randomBytes(16).toString("hex"));
    this.startedAt = this.now();
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  /** Runs until the approval stop, `ready`, or an end state. Never throws. */
  start(): Promise<void> {
    this.starting ??= this.stopped ? Promise.resolve() : this.guarded(() => this.scan());
    return this.starting;
  }

  approve(code: string): { ok: true } | { ok: false; error: string } {
    if (this.phase !== "approval" || !this.approval || !this.current) return { ok: false, error: "the run is not waiting for approval" };
    if (!sameCode(code, this.approval.code)) return { ok: false, error: "the approval code does not match" };
    const quote = this.current;
    this.setPhase("paying"); // synchronous: a second approve now fails
    void this.guarded(() => this.pay(quote));
    return { ok: true };
  }

  cancel(): { ok: true } | { ok: false; error: string } {
    if (this.phase !== "approval") return { ok: false, error: "only a run waiting for approval can be cancelled" };
    this.refuse("CANCELLED", CANCELLED);
    this.current = null;
    return { ok: true };
  }

  destroy(): Promise<void> {
    if (this.ended && !this.machine) return Promise.resolve();
    if (this.phase === "approval") {
      this.cancel();
      return Promise.resolve();
    }
    if (!this.ended && (this.phase === "scanning" || this.phase === "choosing" || this.phase === "quoting")) {
      // nothing is paid yet: end the run here; the step in flight stops at its next check
      this.refuse("STOPPED", STOPPED);
      this.stopped = true;
      return Promise.resolve();
    }
    if (this.phase === "paying" || this.phase === "provisioning") {
      // a payment or machine is in flight: the run stops, or destroys the machine as soon as it is known
      this.destroyRequested = true;
      return Promise.resolve();
    }
    return this.startRelease();
  }

  view(): MarketRunView {
    const v: MarketRunView = {
      id: this.d.id,
      market: this.d.market,
      marketLabel: this.d.seller.config.label,
      phase: this.phase,
      need: this.d.need,
      limits: this.d.limits,
      askBeforePaying: this.d.askBeforePaying,
      agent: this.d.agent,
      sources: this.sources,
      rows: this.rows,
      leftOut: this.leftOut,
      approval: this.approval,
      payment: this.payment,
      spent: !this.alreadyPaid ? "nothing" : this.payment?.status === "confirmed" ? "paid" : "maybe",
      fallbacks: this.fallbackNotes,
      overspendTest: this.d.overspendTest === true,
      machine: this.machine,
      attempts: this.attempts,
      startedAt: this.startedAt,
      paidAt: this.paidAt,
      readyAt: this.readyAt,
      releasedAt: this.releasedAt,
      error: this.error,
      refusal: this.refusal,
      prices: this.prices,
    };
    return JSON.parse(JSON.stringify(v)) as MarketRunView;
  }

  // ---- steps -------------------------------------------------------------

  private async guarded(step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (e) {
      this.log(`unexpected error: ${msg(e)}`);
      // a signed payment with no machine to show for it: never say nothing was spent
      if (this.alreadyPaid && !this.ended && !this.machine && this.current) {
        try {
          return await this.afterSignature(this.current, "unclear", `the run stopped on an unexpected error: ${msg(e)}`);
        } catch (e2) {
          return this.fail(this.unconfirmedText("unclear", true), "PAYMENT_UNCONFIRMED", `after-payment check failed: ${msg(e2)}`);
        }
      }
      this.fail(`The run stopped on an unexpected error: ${msg(e)}`);
    }
  }

  private async scan(): Promise<void> {
    this.setPhase("scanning");
    const offers: Offer[] = [];
    let rules: HourlyRules = DEFAULT_RULES;
    const label = this.d.seller.config.label;
    this.startMarketPrices();
    try {
      const cat = await this.d.seller.catalog();
      offers.push(...cat.offers);
      rules = cat.rules;
      this.sources.push({ name: label, ok: true, count: cat.offers.length, note: cat.skipped ? `${cat.skipped} rows skipped` : null });
    } catch (e) {
      this.sources.push({ name: label, ok: false, count: 0, note: msg(e) });
    }
    if (this.d.spotFeed) {
      try {
        const spot = await this.d.spotFeed();
        offers.push(...spot);
        this.sources.push({ name: "Spot GPU prices (nuza)", ok: true, count: spot.length, note: null });
      } catch (e) {
        this.sources.push({ name: "Spot GPU prices (nuza)", ok: false, count: 0, note: msg(e) });
      }
    }
    if (!this.sources.some((s) => s.ok)) return this.fail(`No price list could be read: ${this.sources.map((s) => s.note).join("; ")}`);
    this.rules = rules;
    return this.choose(offers, rules);
  }

  /** Starts the market price read beside the scan. Not awaited: it can never delay or fail the run. */
  private startMarketPrices(): void {
    const get = this.d.marketPrices;
    if (!get) return;
    void Promise.resolve()
      .then(get)
      .then(
        (r) => {
          if (!r || !Array.isArray(r.prices) || !Array.isArray(r.sources)) return;
          this.marketData = r;
          this.refreshPrices();
        },
        (e) => this.log(`market prices could not be read: ${msg(e)}`),
      );
  }

  private buyableOf(offer: Offer, totalUsd: number, billedHours: number, firm: boolean): Buyable | null {
    return buyableFor({ seller: this.d.seller.config.label, offer, totalUsd, billedHours, askedHours: this.d.need.hours, rules: this.rules, firm });
  }

  private setBuyable(b: Buyable | null): void {
    this.ranksDone = true;
    this.buyable = b;
    this.refreshPrices();
  }

  private refreshPrices(): void {
    if (!this.marketData || !this.ranksDone) return;
    try {
      const { prices, sources, asOf } = this.marketData;
      this.prices = comparePrices({ prices, sources, asOf, need: this.d.need, buyable: this.buyable, limited: true, buyingSpot: this.buyingSpot });
    } catch (e) {
      this.log(`market prices could not be compared: ${msg(e)}`);
    }
  }

  private async choose(offers: Offer[], rules: HourlyRules): Promise<void> {
    if (this.stopped) return;
    this.setPhase("choosing");
    const { ranked, rejected } = choose(offers, this.d.need, this.d.limits, rules);
    this.ranked = ranked;
    this.leftOut = summarize(rejected);
    // a spot rate is not compared with on-demand list prices: the best rentable on-demand plan is the figure
    const top = ranked.find((c) => !c.offer.spot && c.offer.rentable);
    this.setBuyable(top ? this.buyableOf(top.offer, top.estimateUsd, top.hours, false) : null);
    this.rows = [...ranked.map((c) => this.candidateRow(c)), ...rejected.map((r) => this.leftOutRow(r))];
    if (ranked.length === 0) {
      const counts = this.leftOut.map((l) => `${l.count} ${leftOutWords(l.reason, this.d.need)}`).join(", ");
      return this.refuse("NOTHING_FITS", counts ? `No plan fits what you asked for inside your limits: ${counts}.` : "No plan fits what you asked for inside your limits: the price list was empty.");
    }
    return this.quote(ranked);
  }

  private async quote(ranked: Candidate[]): Promise<void> {
    if (this.stopped) return;
    this.setPhase("quoting");
    try {
      this.key = newSshKey(this.d.keyDir, `run-${this.d.id.replace(/[^A-Za-z0-9_-]/g, "_")}`);
    } catch (e) {
      return this.fail(`Could not create an SSH key: ${msg(e)}`);
    }
    for (const c of ranked) {
      if (this.stopped || this.quotes.length >= MAX_QUOTES || this.quoteFailures >= MAX_QUOTE_FAILURES) break;
      for (const region of c.regions.slice(0, MAX_REGIONS)) {
        if (this.stopped || this.quoteFailures >= MAX_QUOTE_FAILURES) break;
        const q = await this.tryQuote(c, region);
        if (q) {
          this.quotes.push(q);
          break;
        }
      }
    }
    if (this.stopped) return;
    if (this.quotes.length === 0) return this.fail(`No seller gave a usable quote. The last problem: ${this.lastQuoteError || "no seller answered."}`);
    this.quotes.sort((a, b) => a.amountUsd - b.amountUsd); // stable: ties keep the chooser's order
    return this.offer(this.quotes[0]);
  }

  /** One unpaid quote, checked against the limits. Null when it failed (logged). */
  private async tryQuote(c: Candidate, region: string): Promise<Quote | null> {
    const k = `${keyOf(c.offer.seller, c.offer.id)}\u0000${region}`;
    if (this.tried.has(k) || !this.key) return null;
    this.tried.add(k);
    let q: Quote;
    try {
      q = await this.d.seller.quote(c, region, { sshPublicKey: this.key.publicKey, maxTotalUsd: this.d.limits.budgetUsd });
    } catch (e) {
      return e instanceof QuoteError ? this.quoteFailed(c, region, e.message, e.code) : this.quoteFailed(c, region, msg(e), "SELLER_ERROR");
    }
    const g = checkPayment({
      accepts: q.accepts,
      market: this.d.market,
      approvedAtomic: BigInt(q.atomic),
      budgetLeftUsd: this.d.limits.budgetUsd,
      rateUsdHr: this.d.limits.rateUsdHr,
      hours: q.hours,
      alreadyPaid: this.alreadyPaid,
    });
    if (!g.ok) return this.quoteFailed(c, region, g.detail, g.code, q.amountUsd, q.atomic);
    this.attempt(c.offer.id, region, `quoted ${usdExact(q.atomic)}`, true);
    this.updateRow(c.offer, { state: "quoted", region, hours: q.hours, quoteUsd: q.amountUsd, quoteExact: usdExact(q.atomic), note: null, code: null });
    return q;
  }

  private quoteFailed(c: Candidate, region: string, why: string, code: string, quoteUsd: number | null = null, atomic: string | null = null): null {
    this.quoteFailures++;
    this.lastQuoteError = why;
    this.noteFailure(c.offer, region, code);
    this.attempt(c.offer.id, region, `Quote failed: ${why}`, false, code);
    this.updateRow(c.offer, { state: "quote failed", region, quoteUsd, quoteExact: atomic ? usdExact(atomic) : null, note: why, code });
    return null;
  }

  private noteFailure(o: Offer, region: string, code: string): void {
    const k = keyOf(o.seller, o.id);
    const list = this.failures.get(k) ?? [];
    if (!list.some((f) => f.region === region)) list.push({ region, code });
    this.failures.set(k, list);
  }

  /** Plain notes for the regions and plans tried before `q` that could not be bought. */
  private fallbackNotesFor(q: Quote): string[] {
    const notes: string[] = [];
    const mine = keyOf(q.candidate.offer.seller, q.candidate.offer.id);
    const at = this.ranked.findIndex((c) => keyOf(c.offer.seller, c.offer.id) === mine);
    for (const [i, c] of this.ranked.entries()) {
      const k = keyOf(c.offer.seller, c.offer.id);
      const failed = this.failures.get(k) ?? [];
      if (k === mine || failed.length === 0 || (at >= 0 && i > at)) continue;
      // a plan with a quote still unused was not given up on; it was just dearer
      if (this.quotes.some((x) => keyOf(x.candidate.offer.seller, x.candidate.offer.id) === k && !this.used.has(x))) continue;
      const codes = [...new Set(failed.map((f) => f.code))];
      const why = codes.length === 1 ? failedWords(codes[0]) : "could not be bought";
      notes.push(`${c.offer.id} ${why} in ${listWords(failed.map((f) => f.region))}, so the agent used ${q.candidate.offer.id}.`);
    }
    for (const f of this.failures.get(mine) ?? []) {
      if (f.region !== q.region) notes.push(`${f.region} ${failedWords(f.code)}, so the agent used ${q.region}.`);
    }
    return notes;
  }

  private surchargeFor(q: Quote): { pct: number; underHours: number } | null {
    const r = this.rules;
    if (q.candidate.offer.spot || !r.enabled || !(q.hours < r.surchargeBelowHours)) return null;
    const pct = q.candidate.offer.kind === "gpu" ? r.surchargePct.gpu : r.surchargePct.machine;
    return Number.isFinite(pct) && pct > 0 ? { pct, underHours: r.surchargeBelowHours } : null;
  }

  /** Puts a quote forward: stop for approval when it applies, else pay. */
  private async offer(q: Quote): Promise<void> {
    if (this.stopped || this.ended) return;
    // destroy pressed while a fallback was being quoted: end here, never show a new approval stop
    if (this.destroyRequested) return this.refuse("STOPPED", STOPPED);
    this.used.add(q);
    this.current = q;
    // a spot rate is not compared with on-demand list prices: keep the last on-demand figure and say so
    this.buyingSpot = q.candidate.offer.spot;
    this.setBuyable(q.candidate.offer.spot ? this.buyable : this.buyableOf(q.candidate.offer, q.amountUsd, q.hours, true));
    this.fallbackNotes = this.fallbackNotesFor(q);
    for (const r of this.rows) if (r.state === "chosen") r.state = "quoted";
    this.updateRow(q.candidate.offer, { state: "chosen", region: q.region, quoteUsd: q.amountUsd, quoteExact: usdExact(q.atomic), note: null, code: null });
    if (this.d.market === "real" || this.d.askBeforePaying) {
      this.approval = {
        code: this.newCode(),
        usd: q.amountUsd,
        atomic: q.atomic,
        exact: usdExact(q.atomic),
        surcharge: this.surchargeFor(q),
        token: "USDC",
        network: NETWORKS[this.d.market].label,
        payTo: q.accepts.payTo,
        plan: q.candidate.offer.id,
        region: q.region,
        hours: q.hours,
        seller: q.seller,
      };
      this.setPhase("approval");
      return;
    }
    this.setPhase("paying");
    return this.pay(q);
  }

  private async pay(q: Quote): Promise<void> {
    this.setPhase("paying");
    const payer = this.d.payer;
    if (!payer) return this.fail(NO_WALLET);
    if (this.alreadyPaid || this.signing) return this.fail(ALREADY_PAID);

    // machines that exist before this payment cannot be the one it buys
    // null when the list could not be read: then no machine is ever adopted by plan and region alone
    let before: Set<string> | null = null;
    try {
      before = new Set((await this.d.seller.instances()).map((i) => i.id));
    } catch {
      // without it an unknown outcome is reported as unknown, never matched to a machine
    }

    if (this.destroyRequested) return this.refuse("STOPPED", STOPPED);
    const intentAt = this.now();
    try {
      this.d.journal.append(this.entry("intent", q, {}));
    } catch (e) {
      return this.fail(`Could not write the purchase journal, so nothing was paid: ${msg(e)}`);
    }
    this.intentAt = intentAt;
    this.attempt(q.candidate.offer.id, q.region, `paying ${usdExact(q.atomic)}`, true);

    const payFn = async (required: PaymentRequired, accepts: Accepts): Promise<Record<string, string> | { refused: string }> => {
      // destroy pressed while the fresh 402 was in flight: nothing is signed
      if (this.destroyRequested) {
        this.refusal = { code: "STOPPED", detail: STOPPED };
        return { refused: STOPPED };
      }
      const g = checkPayment({
        accepts,
        market: this.d.market,
        approvedAtomic: BigInt(q.atomic),
        budgetLeftUsd: this.d.limits.budgetUsd,
        rateUsdHr: this.d.limits.rateUsdHr,
        hours: q.hours,
        alreadyPaid: this.alreadyPaid || this.signing,
        payTo: q.accepts.payTo,
        payer: payer.address,
      });
      if (!g.ok) {
        this.refusal = { code: g.code, detail: g.detail };
        return { refused: g.detail };
      }
      this.signing = true;
      const headers = await payer.payHeaders(required);
      this.alreadyPaid = true;
      // from here the money may be out: the payment shows as sent until it is confirmed
      this.payment = { usd: g.usd, atomic: accepts.amount, tx: null, at: this.now(), payer: payer.address, status: "unconfirmed" };
      this.paySignature = payerSignatureOf(headers);
      return headers;
    };

    const outcome: ProvisionOutcome = await this.d.seller.provision(q, payFn);

    if (outcome.kind === "active" || outcome.kind === "pending") {
      this.confirmPayment(outcome.tx);
      if (this.buyable?.firm && !this.buyingSpot) this.setBuyable({ ...this.buyable, paid: true });
      if (!outcome.tx) await this.lookUpTx(q);
      const p = this.payment!;
      this.safeAppend(this.entry("paid", q, { usd: p.usd, tx: p.tx, instance: outcome.instance.id }));
      return this.provision(q, outcome.instance);
    }

    if (outcome.kind === "not_charged") {
      // a signed payment was sent: whatever the seller says, it may have kept the money
      if (this.alreadyPaid) {
        const refused = outcome.code === "PAYMENT_REJECTED" || outcome.code === "PRICE_CAP";
        this.attempt(q.candidate.offer.id, q.region, outcome.detail, false, outcome.code);
        return this.afterSignature(q, refused ? "rejected" : "unclear", outcome.detail);
      }
      this.safeAppend(this.entry("failed", q, { detail: `${outcome.code}: ${outcome.detail}` }));
      this.attempt(q.candidate.offer.id, q.region, `Not charged: ${outcome.detail}`, false, outcome.code);
      if (outcome.code === "REFUSED_BY_GUARD" && this.refusal) {
        this.updateRow(q.candidate.offer, { state: "quote failed", note: this.refusal.detail, code: this.refusal.code });
        return this.refuse(this.refusal.code, this.refusal.detail);
      }
      // the owner asked to stop while this attempt was in flight: no fallback purchase
      if (this.destroyRequested) return this.refuse("STOPPED", STOPPED);
      if (FALLBACK_CODES.has(outcome.code) && !this.signing && this.fallbackCount < MAX_FALLBACKS) {
        this.noteFailure(q.candidate.offer, q.region, outcome.code);
        this.updateRow(q.candidate.offer, { state: "quote failed", note: outcome.detail, code: outcome.code });
        const next = await this.nextOption(q);
        if (this.destroyRequested) return this.refuse("STOPPED", STOPPED);
        if (next) {
          this.fallbackCount++;
          this.approval = null;
          return this.offer(next);
        }
      }
      return this.fail(outcome.detail);
    }

    // unknown: never sign again; look for the machine
    if (outcome.kind !== "unknown") return this.fail("Unexpected provision outcome");
    const paidUsd = this.payment?.usd ?? q.amountUsd;
    this.safeAppend(this.entry("unknown", q, { usd: paidUsd, detail: outcome.detail }));
    this.attempt(q.candidate.offer.id, q.region, outcome.detail, false, "UNKNOWN");
    const found = await this.findMachine(q, intentAt, before);
    if (!found) return this.afterSignature(q, "unclear", outcome.detail, true);
    this.paidAt = this.now();
    await this.lookUpTx(q);
    this.safeAppend(this.entry("paid", q, { usd: paidUsd, tx: this.payment?.tx ?? null, instance: found.id, detail: "adopted from the instance list" }));
    return this.provision(q, found);
  }

  /**
   * A signed payment was sent and no machine came of it. The run never pays again: it looks for the
   * transfer on chain (up to 6 times, 5 s apart), then ends failed with what it found. The journal
   * keeps the purchase open either way (paid when found, unknown when not).
   */
  private async afterSignature(q: Quote, kind: "rejected" | "unclear", detail: string, unknownWritten = false): Promise<void> {
    if (this.ended) return;
    const usd = this.payment?.usd ?? q.amountUsd;
    if (!unknownWritten) this.safeAppend(this.entry("unknown", q, { usd, detail }));
    this.updateRow(q.candidate.offer, { note: detail });
    const found = await this.checkChain(q, CHAIN_CHECKS);
    if (found && found !== "unavailable" && this.payment) {
      this.confirmPayment(found.tx);
      this.safeAppend(this.entry("paid", q, { usd, tx: found.tx, instance: null, detail: "the seller kept the payment and delivered no machine" }));
      return this.fail(`The seller took one payment of ${usdExact(this.payment.atomic)} and did not deliver a machine.`, "SELLER_KEPT_PAYMENT");
    }
    return this.fail(this.unconfirmedText(kind, found === "unavailable"), "PAYMENT_UNCONFIRMED");
  }

  /** `unavailable`: every chain lookup failed, so the run never actually looked. */
  private unconfirmedText(kind: "rejected" | "unclear", unavailable = false): string {
    const amount = this.payment ? usdExact(this.payment.atomic) : this.current ? usdExact(this.current.atomic) : "an unknown amount";
    const seller = kind === "rejected" ? "The seller says it was not accepted" : "The seller did not confirm it";
    if (!this.d.findPayment) {
      return `A payment of ${amount} was signed and sent. ${seller}. This app could not check the chain, so check the transaction yourself before paying anyone else.`;
    }
    if (unavailable) return `A payment of ${amount} was signed and sent. ${seller}, and the chain could not be checked right now, so check the transaction yourself before paying anyone else.`;
    return `A payment of ${amount} was signed and sent. ${seller}, and no transfer was found on chain yet. Check again later before paying anyone else.`;
  }

  /** Transaction ids other runs already recorded, so a lookup without this run's signature cannot take them. */
  private otherRunsTx(): string[] {
    try {
      const out = new Set<string>();
      for (const e of this.d.journal.all()) if (e.run !== this.d.id && typeof e.tx === "string" && e.tx) out.add(e.tx);
      return [...out];
    } catch {
      return [];
    }
  }

  /**
   * Looks for this run's transfer on chain. Null when the run has no chain check or looked and
   * found nothing; "unavailable" when every lookup failed.
   */
  private async checkChain(q: Quote, tries: number): Promise<{ tx: string } | null | "unavailable"> {
    const find = this.d.findPayment;
    const p = this.payment;
    if (!find || !p) return null;
    let looked = false;
    for (let i = 0; i < tries; i++) {
      if (i > 0) await this.sleep(CHAIN_GAP_MS);
      try {
        const base = { payer: p.payer, payTo: q.accepts.payTo, atomic: p.atomic, sinceMs: this.intentAt ?? this.startedAt };
        const r = await find(this.paySignature ? { ...base, signature: this.paySignature } : { ...base, exclude: this.otherRunsTx() });
        if (r === null) looked = true;
        else if (r !== "unavailable" && typeof r?.tx === "string" && r.tx) return r;
      } catch (e) {
        this.log(`chain check failed: ${msg(e)}`);
      }
    }
    return looked ? null : "unavailable";
  }

  /** One chain check to fill in a transaction id the seller did not report. */
  private async lookUpTx(q: Quote): Promise<void> {
    if (this.payment?.tx) return;
    const found = await this.checkChain(q, 1);
    if (found && found !== "unavailable") this.confirmPayment(found.tx);
  }

  /** After a not-charged failure: the candidate's next region, else the next quoted candidate. */
  private async nextOption(failed: Quote): Promise<Quote | null> {
    const c = failed.candidate;
    for (const region of c.regions.slice(0, MAX_REGIONS)) {
      if (this.quoteFailures >= MAX_QUOTE_FAILURES) break;
      const q = await this.tryQuote(c, region);
      if (q) {
        this.quotes.push(q);
        return q;
      }
    }
    return this.quotes.filter((q) => !this.used.has(q)).sort((a, b) => a.amountUsd - b.amountUsd)[0] ?? null;
  }

  private async findMachine(q: Quote, intentAt: number, before: Set<string> | null): Promise<Instance | null> {
    // without the list from before the payment, a machine with the same plan and region may be an older one
    if (!before) return null;
    const minExpiry = intentAt + q.hours * 3600_000 - EXPIRY_SLACK_MS;
    for (let i = 0; i < UNKNOWN_POLLS; i++) {
      if (i > 0) await this.sleep(UNKNOWN_POLL_MS);
      let list: Instance[];
      try {
        list = await this.d.seller.instances();
      } catch (e) {
        this.log(`instance list failed: ${msg(e)}`);
        continue;
      }
      const match = list
        .filter((m) => m.plan === q.candidate.offer.id && m.region === q.region && !before.has(m.id))
        .filter((m) => m.status !== "destroyed" && (m.expiresAt === null || m.expiresAt * 1000 >= minExpiry))
        .sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
      if (match) return match;
    }
    return null;
  }

  private async provision(q: Quote, first: Instance): Promise<void> {
    this.setPhase("provisioning");
    this.setMachine(q, first);
    let inst: Instance | null = first;
    for (let i = 0; !(inst && inst.status === "active" && validIp(inst.ip)); i++) {
      if (this.destroyRequested) return this.releaseOnRequest();
      if (i >= ACTIVE_POLLS) return this.fail(`The machine did not become active within 10 minutes (last status ${this.machine?.status ?? "unknown"})`);
      await this.sleep(ACTIVE_POLL_MS);
      try {
        inst = await this.d.seller.instance(first.id);
      } catch (e) {
        this.log(`instance poll failed: ${msg(e)}`);
        inst = null;
      }
      if (inst) this.setMachine(q, inst);
    }
    if (this.destroyRequested) return this.releaseOnRequest();

    const ip = validIp(inst.ip)!;
    let port22: "open" | "closed" | "not checked" = "not checked";
    if (!TEST_NET_3.test(ip) && probeable(ip)) {
      port22 = "closed";
      for (let i = 0; i < PROBE_TRIES; i++) {
        if (i > 0) await this.sleep(PROBE_GAP_MS);
        if (this.destroyRequested) return this.releaseOnRequest();
        if (await this.probe(ip).catch(() => false)) {
          port22 = "open";
          break;
        }
      }
    }
    if (!this.machine) return;
    this.machine.port22 = port22;
    this.safeAppend(this.entry("active", q, { usd: this.payment?.usd ?? q.amountUsd, tx: this.payment?.tx ?? null, instance: first.id }));

    const paidAt = this.paidAt ?? this.now();
    const byHours = paidAt + this.d.need.hours * 3600_000;
    this.machine.destroyAt = this.machine.expiresAt === null ? byHours : Math.min(byHours, this.machine.expiresAt);
    this.readyAt = this.now();
    this.setPhase("ready");
    this.record("accepted", null);
    if (this.destroyRequested) return this.startRelease();
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const at = this.machine?.destroyAt;
    if (at == null) return;
    const delay = Math.min(Math.max(at - this.now(), 1), MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.phase !== "ready") return;
      if (this.now() < at) return this.schedule();
      void this.destroy();
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Retries the destroy every 60 s, at most 10 times; release() clears it. */
  private armDestroyRetry(): void {
    if (!this.machine || this.machine.status === "destroyed" || this.phase === "released") return;
    if (this.destroyRetries >= DESTROY_RETRIES) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.destroyRetries++;
      void this.startRelease();
    }, DESTROY_RETRY_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private startRelease(): Promise<void> {
    if (this.destroying) return this.destroying;
    if (this.phase === "released" || !this.machine) return Promise.resolve();
    this.destroying = this.release().finally(() => {
      this.destroying = null;
    });
    return this.destroying;
  }

  /** Destroy asked for while paying or provisioning: the purchase did happen, so it is recorded as accepted. */
  private releaseOnRequest(): Promise<void> {
    this.record("accepted", "destroyed on request before it was ready");
    return this.startRelease();
  }

  private async release(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const m = this.machine!;
    const q = this.current;
    const before = this.phase;
    this.setPhase("releasing");
    try {
      await this.d.seller.destroy(m.id);
      const after = await this.d.seller.instance(m.id);
      if (after && after.status !== "destroyed") throw new Error(`the seller still lists ${m.id} as ${after.status}`);
    } catch (e) {
      this.error = `Destroy failed, the machine may still be running: ${msg(e)}`;
      this.destroyError = true;
      this.setPhase(before === "failed" ? "failed" : "ready");
      this.armDestroyRetry();
      return;
    }
    m.status = "destroyed";
    m.ip = null;
    m.ssh = null;
    if (this.destroyError) {
      this.error = null;
      this.destroyError = false;
    }
    if (q) this.safeAppend(this.entry("released", q, { usd: this.payment?.usd ?? q.amountUsd, tx: this.payment?.tx ?? null, instance: m.id }));
    this.releasedAt = this.now();
    this.setPhase("released");
    this.end();
  }

  // ---- end states --------------------------------------------------------

  /** `code` goes in front of the record's reason ("SELLER_KEPT_PAYMENT: ..."), so /records can word it. */
  private fail(error: string, code?: string, logLine?: string): void {
    if (this.ended) return;
    if (logLine) this.log(logLine);
    this.error = error;
    this.setPhase("failed");
    this.record("failed", code ? `${code}: ${error}` : error);
    this.end();
    // a machine the run knows of is never left without an armed destroy
    this.armDestroyRetry();
  }

  private refuse(code: string, detail: string): void {
    if (this.ended) return;
    this.refusal = { code, detail };
    this.setPhase("refused");
    this.record("refused", `${code}: ${detail}`);
    this.end();
  }

  private end(): void {
    this.ended = true;
    this.resolveDone();
  }

  /** One record per run: accepted at ready, or the failed/refused end. */
  private record(outcome: PurchaseRecord["outcome"], reason: string | null): void {
    if (this.recorded) return;
    this.recorded = true;
    const q = this.current;
    const r: PurchaseRecord = {
      at: this.now(),
      outcome,
      reason,
      plan: q?.candidate.offer.id ?? "",
      region: q?.region ?? "",
      // an amount only when a payment was signed: a quote that was never paid is not money spent
      usd: this.alreadyPaid ? (this.payment?.usd ?? q?.amountUsd ?? null) : null,
      tx: this.payment?.tx ?? null,
      server: this.machine?.id ?? null,
    };
    try {
      this.d.onRecord?.(r);
    } catch (e) {
      this.log(`record hook failed: ${msg(e)}`);
    }
  }

  // ---- helpers -----------------------------------------------------------

  private setPhase(p: MarketPhase): void {
    if (this.stopped) return; // stopped before paying: the run stays refused
    if (this.phase !== p) this.log(`phase ${p}`);
    this.phase = p;
  }

  private log(line: string): void {
    try {
      this.d.log?.(`[market ${this.d.id}] ${line}`);
    } catch {
      // logging never breaks a run
    }
  }

  private attempt(plan: string, region: string, what: string, ok: boolean, code: string | null = null): void {
    this.attempts.push({ at: this.now(), plan, region, what, ok, code });
  }

  /** The seller reported success, or the transfer was found on chain. */
  private confirmPayment(tx: string | null): void {
    if (!this.payment) return;
    this.paidAt ??= this.now();
    this.payment = { ...this.payment, tx: tx ?? this.payment.tx, status: "confirmed" };
  }

  private setMachine(q: Quote, inst: Instance): void {
    const ip = validIp(inst.ip);
    this.machine = {
      id: inst.id,
      ip,
      status: inst.status,
      expiresAt: inst.expiresAt === null ? null : inst.expiresAt * 1000,
      destroyAt: this.machine?.destroyAt ?? null,
      ssh: ip && this.key ? `ssh -i ${shellPath(this.key.privatePath)} root@${ip}` : null,
      port22: this.machine?.port22 ?? "not checked",
      plan: inst.plan || q.candidate.offer.id,
      region: inst.region || q.region,
    };
  }

  private entry(event: JournalEntry["event"], q: Quote, extra: Partial<JournalEntry>): JournalEntry {
    return {
      at: this.now(),
      run: this.d.id,
      market: this.d.market,
      seller: q.seller,
      event,
      plan: q.candidate.offer.id,
      region: q.region,
      usd: q.amountUsd,
      ...extra,
    };
  }

  private safeAppend(e: JournalEntry): void {
    try {
      this.d.journal.append(e);
    } catch (err) {
      this.log(`journal write failed for ${e.event}: ${msg(err)}`);
    }
  }

  private candidateRow(c: Candidate): OfferRow {
    return { ...this.baseRow(c.offer), region: null, hours: c.hours, estimateUsd: c.estimateUsd, quoteUsd: null, quoteExact: null, state: "candidate", note: null, code: null };
  }

  private leftOutRow(r: Rejection): OfferRow {
    return { ...this.baseRow(r.offer), region: null, hours: null, estimateUsd: null, quoteUsd: null, quoteExact: null, state: "left out", note: leftOutWords(r.reason, this.d.need), code: r.reason };
  }

  private baseRow(o: Offer) {
    return { seller: o.seller, id: o.id, provider: o.provider, kind: o.kind, vcpus: o.vcpus, ramGb: o.ramGb, vramGb: o.vramGb, gpu: o.gpu, listHourlyUsd: o.listHourlyUsd, hourlyUsd: o.hourlyUsd };
  }

  private updateRow(o: Offer, patch: Partial<OfferRow>): void {
    const row = this.rows.find((r) => r.state !== "left out" && keyOf(r.seller, r.id) === keyOf(o.seller, o.id));
    if (row) Object.assign(row, patch);
  }
}

function sameCode(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
