import { randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { DEFAULT_RULES } from "./types";
import { choose, summarize, type Candidate, type Rejection } from "./choose";
import { checkPayment, NETWORKS, type Accepts } from "./guard";
import type { Journal, JournalEntry } from "./journal";
import type { Payer, PaymentRequired } from "./pay";
import { QuoteError, type Instance, type ProvisionOutcome, type Quote, type SellerClient } from "./seller";
import { newSshKey } from "./sshkey";
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
  state: "chosen" | "quoted" | "candidate" | "quote failed" | "left out";
  note: string | null;
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
  approval: { code: string; usd: number; atomic: string; token: "USDC"; network: string; payTo: string; plan: string; region: string; hours: number; seller: string } | null;
  payment: { usd: number; tx: string | null; at: number; payer: string } | null;
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
  attempts: { at: number; plan: string; region: string; what: string; ok: boolean }[];
  startedAt: number;
  paidAt: number | null;
  readyAt: number | null;
  releasedAt: number | null;
  error: string | null;
  refusal: { code: string; detail: string } | null;
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
const NO_WALLET = "no wallet is set up for this market";
const UNKNOWN_OUTCOME = "payment outcome unknown; check the journal";
const FALLBACK_CODES = new Set(["OUT_OF_STOCK", "SELLER_ERROR"]);
const TEST_NET_3 = /^203\.0\.113\.\d{1,3}$/;

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

  private starting: Promise<void> | null = null;
  private ended = false;
  private key: { publicKey: string; privatePath: string } | null = null;
  private quotes: Quote[] = [];
  private readonly used = new Set<Quote>();
  private readonly tried = new Set<string>();
  private quoteFailures = 0;
  private lastQuoteError = "";
  private fallbacks = 0;
  /** the quote shown at the approval stop, or being paid */
  private current: Quote | null = null;
  /** true once the payer has been asked to sign: no fallback and no second payment after this */
  private signing = false;
  private alreadyPaid = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroying: Promise<void> | null = null;
  private destroyRequested = false;
  private recorded = false;

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
    this.starting ??= this.guarded(() => this.scan());
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
    this.current = null;
    this.refuse("CANCELLED", "The owner cancelled at the approval stop; nothing was signed");
    return { ok: true };
  }

  destroy(): Promise<void> {
    if (this.phase === "paying" || this.phase === "provisioning") {
      // a payment or machine is in flight: the run destroys the machine as soon as it is known
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
      machine: this.machine,
      attempts: this.attempts,
      startedAt: this.startedAt,
      paidAt: this.paidAt,
      readyAt: this.readyAt,
      releasedAt: this.releasedAt,
      error: this.error,
      refusal: this.refusal,
    };
    return JSON.parse(JSON.stringify(v)) as MarketRunView;
  }

  // ---- steps -------------------------------------------------------------

  private async guarded(step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (e) {
      this.fail(`Unexpected error: ${msg(e)}`);
    }
  }

  private async scan(): Promise<void> {
    this.setPhase("scanning");
    const offers: Offer[] = [];
    let rules: HourlyRules = DEFAULT_RULES;
    const label = this.d.seller.config.label;
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
    return this.choose(offers, rules);
  }

  private async choose(offers: Offer[], rules: HourlyRules): Promise<void> {
    this.setPhase("choosing");
    const { ranked, rejected } = choose(offers, this.d.need, this.d.limits, rules);
    this.leftOut = summarize(rejected);
    this.rows = [...ranked.map((c) => this.candidateRow(c)), ...rejected.map((r) => this.leftOutRow(r))];
    if (ranked.length === 0) {
      const counts = this.leftOut.map((l) => `${l.count} ${l.reason}`).join(", ");
      return this.refuse("NOTHING_FITS", `No plan fits the need inside the limits${counts ? ` (${counts})` : ""}`);
    }
    return this.quote(ranked);
  }

  private async quote(ranked: Candidate[]): Promise<void> {
    this.setPhase("quoting");
    try {
      this.key = newSshKey(this.d.keyDir, `run-${this.d.id.replace(/[^A-Za-z0-9_-]/g, "_")}`);
    } catch (e) {
      return this.fail(`Could not create an SSH key: ${msg(e)}`);
    }
    for (const c of ranked) {
      if (this.quotes.length >= MAX_QUOTES || this.quoteFailures >= MAX_QUOTE_FAILURES) break;
      for (const region of c.regions.slice(0, MAX_REGIONS)) {
        if (this.quoteFailures >= MAX_QUOTE_FAILURES) break;
        const q = await this.tryQuote(c, region);
        if (q) {
          this.quotes.push(q);
          break;
        }
      }
    }
    if (this.quotes.length === 0) return this.fail(`No usable quote: ${this.lastQuoteError || "no seller answered"}`);
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
      const why = e instanceof QuoteError ? `${e.code}: ${e.message}` : msg(e);
      return this.quoteFailed(c, region, why);
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
    if (!g.ok) return this.quoteFailed(c, region, `${g.code}: ${g.detail}`, q.amountUsd);
    this.attempt(c.offer.id, region, `quoted $${q.amountUsd}`, true);
    this.updateRow(c.offer, { state: "quoted", region, hours: q.hours, quoteUsd: q.amountUsd, note: null });
    return q;
  }

  private quoteFailed(c: Candidate, region: string, why: string, quoteUsd: number | null = null): null {
    this.quoteFailures++;
    this.lastQuoteError = why;
    this.attempt(c.offer.id, region, `quote failed: ${why}`, false);
    this.updateRow(c.offer, { state: "quote failed", region, quoteUsd, note: why });
    return null;
  }

  /** Puts a quote forward: stop for approval when it applies, else pay. */
  private async offer(q: Quote): Promise<void> {
    this.used.add(q);
    this.current = q;
    for (const r of this.rows) if (r.state === "chosen") r.state = "quoted";
    this.updateRow(q.candidate.offer, { state: "chosen", region: q.region, quoteUsd: q.amountUsd, note: null });
    if (this.d.market === "real" || this.d.askBeforePaying) {
      this.approval = {
        code: this.newCode(),
        usd: q.amountUsd,
        atomic: q.atomic,
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
    if (this.alreadyPaid || this.signing) return this.fail("This run already has a payment; refusing to pay again");

    // machines that exist before this payment cannot be the one it buys
    let before = new Set<string>();
    try {
      before = new Set((await this.d.seller.instances()).map((i) => i.id));
    } catch {
      // best effort; the expiry check below still applies
    }

    const intentAt = this.now();
    try {
      this.d.journal.append(this.entry("intent", q, {}));
    } catch (e) {
      return this.fail(`Could not write the purchase journal, so nothing was paid: ${msg(e)}`);
    }
    this.attempt(q.candidate.offer.id, q.region, `paying $${q.amountUsd}`, true);

    let signedUsd: number | null = null;
    const payFn = async (required: PaymentRequired, accepts: Accepts): Promise<Record<string, string> | { refused: string }> => {
      const g = checkPayment({
        accepts,
        market: this.d.market,
        approvedAtomic: BigInt(q.atomic),
        budgetLeftUsd: this.d.limits.budgetUsd,
        rateUsdHr: this.d.limits.rateUsdHr,
        hours: q.hours,
        alreadyPaid: this.alreadyPaid || this.signing,
        payTo: q.accepts.payTo,
      });
      if (!g.ok) {
        this.refusal = { code: g.code, detail: g.detail };
        return { refused: `${g.code}: ${g.detail}` };
      }
      this.signing = true;
      const headers = await payer.payHeaders(required);
      this.alreadyPaid = true;
      signedUsd = g.usd;
      return headers;
    };

    const outcome: ProvisionOutcome = await this.d.seller.provision(q, payFn);
    const paidUsd = signedUsd ?? q.amountUsd;

    if (outcome.kind === "active" || outcome.kind === "pending") {
      this.recordPayment(paidUsd, outcome.tx, payer.address);
      this.safeAppend(this.entry("paid", q, { usd: paidUsd, tx: outcome.tx, instance: outcome.instance.id }));
      return this.provision(q, outcome.instance);
    }

    if (outcome.kind === "not_charged") {
      const why = `${outcome.code}: ${outcome.detail}`;
      this.safeAppend(this.entry("failed", q, { detail: why }));
      this.attempt(q.candidate.offer.id, q.region, `not charged: ${why}`, false);
      if (outcome.code === "REFUSED_BY_GUARD" && this.refusal) {
        this.updateRow(q.candidate.offer, { state: "quote failed", note: why });
        return this.refuse(this.refusal.code, this.refusal.detail);
      }
      if (FALLBACK_CODES.has(outcome.code) && !this.signing && this.fallbacks < MAX_FALLBACKS) {
        this.updateRow(q.candidate.offer, { state: "quote failed", note: why });
        const next = await this.nextOption(q);
        if (next) {
          this.fallbacks++;
          this.approval = null;
          return this.offer(next);
        }
      }
      return this.fail(why);
    }

    // unknown: never sign again; look for the machine
    if (outcome.kind !== "unknown") return this.fail("Unexpected provision outcome");
    this.safeAppend(this.entry("unknown", q, { usd: paidUsd, detail: outcome.detail }));
    this.attempt(q.candidate.offer.id, q.region, `outcome unknown: ${outcome.detail}`, false);
    const found = await this.findMachine(q, intentAt, before);
    if (!found) return this.fail(`${UNKNOWN_OUTCOME} (${outcome.detail})`);
    this.recordPayment(paidUsd, null, payer.address);
    this.safeAppend(this.entry("paid", q, { usd: paidUsd, tx: null, instance: found.id, detail: "adopted from the instance list" }));
    return this.provision(q, found);
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

  private async findMachine(q: Quote, intentAt: number, before: Set<string>): Promise<Instance | null> {
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
    for (let i = 0; !(inst && inst.status === "active" && inst.ip); i++) {
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

    const ip = inst.ip!;
    let port22: "open" | "closed" | "not checked" = "not checked";
    if (!TEST_NET_3.test(ip)) {
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

  private fail(error: string): void {
    if (this.ended) return;
    this.error = error;
    this.setPhase("failed");
    this.record("failed", error);
    this.end();
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
      usd: this.payment?.usd ?? q?.amountUsd ?? null,
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

  private attempt(plan: string, region: string, what: string, ok: boolean): void {
    this.attempts.push({ at: this.now(), plan, region, what, ok });
  }

  private recordPayment(usd: number, tx: string | null, payer: string): void {
    this.paidAt = this.now();
    this.payment = { usd, tx, at: this.paidAt, payer };
  }

  private setMachine(q: Quote, inst: Instance): void {
    const ip = inst.ip;
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
    return { ...this.baseRow(c.offer), region: null, hours: c.hours, estimateUsd: c.estimateUsd, quoteUsd: null, state: "candidate", note: null };
  }

  private leftOutRow(r: Rejection): OfferRow {
    return { ...this.baseRow(r.offer), region: null, hours: null, estimateUsd: null, quoteUsd: null, state: "left out", note: r.reason };
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
