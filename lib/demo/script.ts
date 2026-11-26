import { signMandate, toCompact, type Mandate } from "../mandate";
import { clusterForMarket, toTransactionRecord } from "../market/record";
import { destroyOpenPurchase, type RecoverResult } from "../market/recover";
import { MarketRun, type MarketPhase, type MarketRunView } from "../market/run";
import { findPaymentFor, marketJournal, marketPricesFeed, nuzaFeed, payerFor, sellerFor, sshKeyDir, type RunInput } from "../market/session";
import { OVERSPEND_BUSY, overspendRunning } from "../market/overspend-lock";
import { DemoLog } from "./log";
import type { Actor, Runtime } from "./runtime";

export const MARKET_ENDED: ReadonlySet<MarketPhase> = new Set(["released", "failed", "refused"]);
/** Phases in which a run is talking to the seller right now (not waiting for a person, not holding a machine). */
const MARKET_WORKING: ReadonlySet<MarketPhase> = new Set(["scanning", "choosing", "quoting", "paying", "provisioning", "releasing"]);

/**
 * One visitor's session: their current market run, signed by the owner's key and recorded on Arweave.
 * The owner's session logs to the runtime's log; a public visitor's has a log of its own, so nobody
 * reads another visitor's lines.
 */
export class DemoSession {
  readonly rt: Runtime;
  readonly kind: "owner" | "public";
  readonly log: DemoLog;
  /** Every run this session started, so it can only see and destroy its own purchases. */
  readonly runIds = new Set<string>();
  market: MarketRun | null = null;
  private marketStarting: Promise<MarketRunView> | null = null;

  constructor(rt: Runtime, kind: "owner" | "public" = "owner") {
    this.rt = rt;
    this.kind = kind;
    this.log = kind === "owner" ? rt.log : new DemoLog();
  }

  /** True while this session's run is talking to the seller (the overspend test must not set faults meanwhile). */
  get marketWorking(): boolean {
    return this.marketStarting !== null || (this.market !== null && MARKET_WORKING.has(this.market.view().phase));
  }

  mandate(overrides: Partial<Mandate> & Pick<Mandate, "jti" | "iss" | "sub">): Mandate {
    const now = Math.floor(Date.now() / 1000);
    return {
      aud: overrides.sub,
      parent: null,
      depth: 0,
      max_depth: 3,
      scope: ["compute:provision"],
      limit_usd: 20,
      rate_usd_hr: 0.01,
      nbf: now - 60,
      exp: now + 7200,
      ...overrides,
    };
  }

  private async sign(m: Mandate, by: Actor): Promise<string> {
    return toCompact(await signMandate(m, by));
  }

  /** True while a market run is starting or not over. */
  get marketBusy(): boolean {
    return this.marketStarting !== null || (this.market !== null && !MARKET_ENDED.has(this.market.view().phase));
  }

  /** One run at a time: while a run is not over, this returns it instead of starting another. */
  startMarketRun(input: RunInput): Promise<MarketRunView> {
    if (this.market && !MARKET_ENDED.has(this.market.view().phase)) return Promise.resolve(this.market.view());
    // checked synchronously, so a run cannot start between the overspend test taking its lock and checking marketBusy
    if (!this.marketStarting && overspendRunning()) return Promise.reject(new Error(OVERSPEND_BUSY));
    this.marketStarting ??= this.newMarketRun(input).finally(() => {
      this.marketStarting = null;
    });
    return this.marketStarting;
  }

  private async newMarketRun(input: RunInput): Promise<MarketRunView> {
    const { rt } = this;
    // public sessions can start in the same millisecond: a random tail keeps run ids unique
    const id = `mkt_${Date.now().toString(36)}${this.kind === "public" ? Math.random().toString(36).slice(2, 6) : ""}`;
    this.runIds.add(id);
    const jti = `m_${id}`;
    const agent = { name: "your agent", ansName: rt.actors.ops.name };
    const signer = rt.actors.ops;

    // the run's limits, signed by the owner for the buying agent and admitted by the mandate registry
    const { human } = rt.actors;
    const now = Math.floor(Date.now() / 1000);
    const compact = await this.sign(
      this.mandate({
        jti,
        iss: human.name,
        sub: agent.ansName,
        max_depth: 2,
        limit_usd: input.limits.budgetUsd,
        rate_usd_hr: input.limits.rateUsdHr,
        nbf: now - 60,
        exp: now + Math.ceil(input.need.hours * 3600) + 3600,
      }),
      human,
    );
    const [p, pl, sig] = compact.split(".");
    const admitted = await rt.registry.admitRoot({ protected: p, payload: pl, signature: sig });
    if (!admitted.ok) throw new Error("your budget was refused before the run started");
    const mandate = admitted.mandate.hash;

    const payer = await payerFor(input.market);
    const run = new MarketRun({
      id,
      market: input.market,
      seller: sellerFor(input.market, payer),
      spotFeed: input.market === "real" ? () => nuzaFeed() : undefined,
      marketPrices: marketPricesFeed,
      payer,
      journal: marketJournal(rt.config.root),
      need: input.need,
      limits: input.limits,
      askBeforePaying: input.askBeforePaying,
      agent,
      keyDir: sshKeyDir(rt.config.root),
      findPayment: findPaymentFor(input.market),
      onRecord: (record) => {
        void rt.storeTransaction(toTransactionRecord(record, { subject: agent.ansName, mandate, mandateJti: jti, cluster: clusterForMarket(input.market) }), {
          signer,
          cluster: clusterForMarket(input.market),
          log: this.log,
        });
      },
      log: (line) => this.log.push("info", "MARKET", line),
    });
    this.market = run;
    this.log.push(
      "step",
      "MARKET",
      `${agent.name} starts a ${input.market === "real" ? "real (mainnet)" : "test (devnet)"} run ${id}: budget $${input.limits.budgetUsd}, up to $${input.limits.rateUsdHr}/hour, ${payer ? `paying from ${payer.address}` : "no wallet set up"}`,
    );
    void run.start();
    return run.view();
  }

  approveMarket(runId: string, code: string): { ok: true; run: MarketRunView } | { ok: false; error: string } {
    const run = this.market;
    if (!run || run.view().id !== runId) return { ok: false, error: "that run is not the current run" };
    // the overspend test sets the test seller's faults; a payment must not start while it runs
    if (overspendRunning()) return { ok: false, error: OVERSPEND_BUSY };
    const result = run.approve(code);
    return result.ok ? { ok: true, run: run.view() } : result;
  }

  /** Destroys the current run's machine, cancels it at the approval stop, or destroys a machine recovered from the journal. */
  async destroyMarket(input: { run?: string; cancel?: boolean; open?: { run: string } }): Promise<{ ok: true; message?: string } | { ok: false; error: string }> {
    const current = this.market;
    const target = input.open?.run ?? input.run;
    if (!target) return { ok: false, error: "say which run" };
    if (current && current.view().id === target) {
      if (input.cancel) return current.cancel();
      await current.destroy();
      const v = current.view();
      if (v.error && v.machine && v.machine.status !== "destroyed" && v.phase !== "paying" && v.phase !== "provisioning") return { ok: false, error: v.error };
      return { ok: true };
    }
    if (input.cancel) return { ok: false, error: "only the current run can be cancelled" };
    if (!input.open) return { ok: false, error: "that run is not the current run" };
    return this.destroyOpen(target);
  }

  private async destroyOpen(runId: string): Promise<{ ok: true; message?: string } | { ok: false; error: string }> {
    const journal = marketJournal(this.rt.config.root);
    const open = journal.open().find((o) => o.run === runId);
    // a public visitor can only reach purchases their own session made
    if (!open || (this.kind === "public" && !this.runIds.has(runId))) return { ok: false, error: "that purchase is not listed as open" };
    // machines known to belong to other runs are never picked by the plan-and-region match
    const exclude = new Set(journal.all().filter((e) => e.run !== runId && e.instance).map((e) => e.instance!));
    const live = this.market?.view().machine?.id;
    if (live) exclude.add(live);
    let result: RecoverResult;
    try {
      result = await destroyOpenPurchase(open, sellerFor(open.market, await payerFor(open.market)), journal, { exclude });
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    if (!result.ok) return result;
    this.log.push("info", "MARKET", `run ${open.run}: ${result.message}`);
    return { ok: true, message: result.message };
  }
}
