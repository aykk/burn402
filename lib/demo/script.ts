import { signMandate, toCompact, type Mandate } from "../mandate";
import { clusterForMarket, toTransactionRecord } from "../market/record";
import { destroyOpenPurchase, type RecoverResult } from "../market/recover";
import { MarketRun, type MarketPhase, type MarketRunView } from "../market/run";
import { WalletError, approvalMemo, buildApproval, buildRevoke, checkSignedApproval, checkSignedRevoke, rpcFor, sendSigned, usdcAccount, type ApprovalAsk } from "../market/delegate";
import { EvmWalletError, chainOfWallet, isEvmAddress, preparePayment, secondsLeft, signedByWallet, walletAuthChallenge, walletAuthHeaders, type PreparedPayment, type WalletAuthChallenge, type WalletPayer, type WalletTypedData } from "../market/evm";
import { BASE_NETWORKS } from "../market/guard";
import { usdExact } from "../market/money";
import type { Payer } from "../market/pay";
import { SellerClient } from "../market/seller";
import { publicHosts, publicReal } from "../market/access";
import { baseReady, delegatePayerFor, findPaymentFor, marketJournal, marketPricesFeed, nuzaFeed, payerFor, payerOwning, sellerFor, sshKeyDir, walletPayerFor, type RunInput } from "../market/session";
import { OVERSPEND_BUSY, overspendRunning } from "../market/overspend-lock";
import { DemoLog } from "./log";
import type { Actor, Runtime } from "./runtime";

export const MARKET_ENDED: ReadonlySet<MarketPhase> = new Set(["released", "failed", "refused"]);

/** True while the site answers on a public address: visitors then rent through agent wallets that more than one renter shares. */
const sharedWallets = (): boolean => publicHosts().size > 0;
/** Phases in which a run is talking to the seller right now (not waiting for a person, not holding a machine). */
const MARKET_WORKING: ReadonlySet<MarketPhase> = new Set(["scanning", "choosing", "quoting", "paying", "provisioning", "releasing"]);
/** A sign-in message the wallet was handed is taken back within this long (the seller allows five minutes). */
const SIGN_IN_TTL_MS = 4 * 60_000;
/** What an Ethereum wallet needs to know about the network it signs for, to switch to it or add it. */
export type WalletNetwork = { chainId: number; name: string; rpcUrl: string; explorer: string };
const shortEvm = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** A signed payment with less than this left before it expires is not sent. */
const MIN_SIGNATURE_SECONDS = 45;

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
  /** The current run's payer: it says whether a connected wallet funds the run, and which agent wallet that wallet approves. */
  private marketPayer: Payer | null = null;
  /** True while a wallet's approval is being checked and sent, so two clicks cannot send it twice. */
  private approving = false;
  /** The payment an Ethereum wallet was last asked to sign, kept so only its signature for exactly that is taken. */
  private walletPayment: { run: string; code: string; prepared: PreparedPayment } | null = null;
  /** The sign-in message an Ethereum wallet was last asked to sign, to look at or destroy its own machine. Good once. */
  private walletSignIn: { run: string; kind: "look" | "destroy"; challenge: WalletAuthChallenge; at: number } | null = null;

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

    // from a connected wallet, the agent's key still signs: it spends that wallet's USDC under the wallet's own approval
    // A stranger's real rental is paid from their own wallet and set up with their own key, or it does not start.
    // The route checks this too; it is repeated here so no other way in can skip it.
    if (this.kind === "public" && input.market === "real" && (!publicReal() || !input.wallet || !input.sshPublicKey)) {
      throw new Error("a public visitor's real rental needs their own wallet and their own SSH key");
    }
    // An Ethereum wallet pays the seller itself, on Base, and owns the machine: no key of this app's signs anything.
    const chain = chainOfWallet(input.wallet);
    if (chain === "base" && !baseReady()[input.market]) throw new Error("the test market is not set up to be paid on Base (the test seller has no Base address to be paid at)");
    // a public visitor's rental is signed by the public agent key, never by the owner's
    const payer = !input.wallet ? await payerFor(input.market, this.kind) : chain === "base" ? walletPayerFor(input.wallet) : await delegatePayerFor(input.market, input.wallet, this.kind);
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
      sshPublicKey: input.sshPublicKey ?? undefined,
      // While the site is public, agent wallets are shared (visitors with each other, and on the test market with
      // the owner): a machine is then never adopted by plan and region alone, for anyone. It could be someone else's.
      adopt: !sharedWallets(),
      findPayment: findPaymentFor(input.market, undefined, chain),
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
    this.marketPayer = payer;
    this.walletPayment = null;
    this.walletSignIn = null;
    this.log.push(
      "step",
      "MARKET",
      `${agent.name} starts a ${input.market === "real" ? "real (mainnet)" : "test (devnet)"} run ${id}: budget $${input.limits.budgetUsd}, up to $${input.limits.rateUsdHr}/hour, ${payer ? (payer.funds ? `paying from the connected wallet ${payer.funds}, approved to ${payer.address}` : `paying from ${payer.address}`) : "no wallet set up"}`,
    );
    void run.start();
    return run.view();
  }

  /** What a wallet-funded run asks the visitor's wallet to approve at this approval stop; null when the agent's own wallet pays. */
  private approvalAsk(runId: string, code: string): { ok: true; ask: ApprovalAsk | null } | { ok: false; error: string } {
    const run = this.market;
    if (!run || run.view().id !== runId) return { ok: false, error: "that run is not the current run" };
    const approval = run.awaiting(code);
    if (!approval) return { ok: false, error: "the run is not waiting for this approval" };
    const payer = this.marketPayer;
    // an Ethereum wallet signs the payment itself (see walletTypedPayment): there is no approval for the agent to ask for
    if (!payer?.funds || payer.self) return { ok: true, ask: null };
    return { ok: true, ask: { market: run.view().market, owner: payer.funds, delegate: payer.address, atomic: BigInt(approval.atomic), memo: approvalMemo(runId, code) } };
  }

  /**
   * The transaction the visitor's wallet signs at the approval stop of a wallet-funded run: permission
   * for the agent to move exactly the quoted amount. Unsigned; nothing is sent or paid here.
   */
  async walletApproval(runId: string, code: string): Promise<{ ok: true; transaction: string; chain: "solana:devnet" | "solana:mainnet"; wallet: string } | { ok: false; error: string }> {
    const found = this.approvalAsk(runId, code);
    if (!found.ok) return found;
    if (!found.ask) return { ok: false, error: this.marketPayer?.self ? "this run is paid by an Ethereum wallet, which signs the payment itself" : "this run is paid from the agent's wallet, not a connected one" };
    try {
      const transaction = await buildApproval(rpcFor(found.ask.market), found.ask);
      return { ok: true, transaction, chain: found.ask.market === "real" ? "solana:mainnet" : "solana:devnet", wallet: found.ask.owner };
    } catch (error) {
      return { ok: false, error: error instanceof WalletError ? error.message : `The approval could not be prepared: ${(error as Error).message}` };
    }
  }

  /**
   * Pays for the quote at the approval stop. A wallet-funded run needs the approval the wallet signed:
   * it is checked (the wallet's signature, this run's note, exactly the quoted amount to this run's
   * agent), put on chain, and only then does the run go on to pay.
   */
  async approveMarket(runId: string, code: string, signedTransaction?: string): Promise<{ ok: true; run: MarketRunView } | { ok: false; error: string }> {
    const found = this.approvalAsk(runId, code);
    if (!found.ok) return found;
    const run = this.market!;
    if (this.marketPayer?.self) return this.approveFromWallet(run, code, signedTransaction);
    // the overspend test sets the test seller's faults; a payment must not start while it runs
    if (overspendRunning()) return { ok: false, error: OVERSPEND_BUSY };
    if (found.ask) {
      if (typeof signedTransaction !== "string" || !signedTransaction) return { ok: false, error: "approve the payment in your wallet first" };
      if (this.approving) return { ok: false, error: "the approval is already being sent" };
      this.approving = true;
      try {
        const checked = checkSignedApproval(signedTransaction, { ...found.ask, account: await usdcAccount(found.ask.market, found.ask.owner) });
        if (!checked.ok) return { ok: false, error: `The approval was not accepted: ${checked.error}.` };
        let tx: string;
        // from here the approval may reach the chain, even if the node's answer is lost
        run.noteWalletApproval();
        try {
          tx = await sendSigned(rpcFor(found.ask.market), checked.wire);
        } catch (error) {
          // a node that timed out may still have passed the transaction on: say so rather than "not sent"
          return { ok: false, error: `The approval was not confirmed as sent (${(error as Error).message}), so nothing was paid. If it still lands, it covers this one amount only and your next approval replaces it. Try again.` };
        }
        this.log.push("info", "MARKET", `run ${runId}: the connected wallet approved ${run.awaiting(code)?.exact ?? "the quoted amount"} for the agent (transaction ${tx})`);
      } finally {
        this.approving = false;
      }
    }
    const result = run.approve(code);
    if (result.ok) return { ok: true, run: run.view() };
    // the run stopped waiting while the wallet's approval was being sent (cancelled, or reset): say what is left behind
    if (found.ask) return { ok: false, error: "Your wallet's approval was sent, but the run was no longer waiting, so nothing was paid. The approval covers this amount only; your next approval replaces it, or revoke it in your wallet." };
    return result;
  }

  /**
   * The message an Ethereum wallet signs at the approval stop of a run it pays for itself: USDC, exactly the
   * quoted amount, from that wallet to the seller. Unsigned; nothing is sent or paid here. The network is
   * what the wallet must be switched to before it will sign.
   */
  async walletTypedPayment(runId: string, code: string): Promise<{ ok: true; typedData: WalletTypedData; network: WalletNetwork; wallet: string } | { ok: false; error: string }> {
    const run = this.market;
    if (!run || run.view().id !== runId) return { ok: false, error: "that run is not the current run" };
    const payer = this.marketPayer;
    if (!payer?.self) return { ok: false, error: "this run is not paid by an Ethereum wallet" };
    const quote = run.awaitingQuote(code);
    if (!quote) return { ok: false, error: "the run is not waiting for this approval" };
    if (!quote.required) return { ok: false, error: "the seller's payment terms for this quote were not kept" };
    const market = run.view().market;
    try {
      const prepared = await preparePayment(quote.required, { wallet: payer.address, market });
      this.walletPayment = { run: runId, code, prepared };
      const net = BASE_NETWORKS[market];
      return { ok: true, typedData: prepared.typedData, network: { chainId: net.chainId, name: net.label, rpcUrl: net.rpcUrl, explorer: net.explorer }, wallet: prepared.wallet };
    } catch (error) {
      return { ok: false, error: error instanceof EvmWalletError ? error.message : `The payment could not be prepared: ${(error as Error).message}` };
    }
  }

  /**
   * Pays for the quote with the message the Ethereum wallet signed. Only the signature of exactly the
   * payment this session prepared for this approval is taken; it is checked to be that wallet's before
   * the run goes on.
   */
  private async approveFromWallet(run: MarketRun, code: string, signature?: string): Promise<{ ok: true; run: MarketRunView } | { ok: false; error: string }> {
    const runId = run.view().id;
    if (overspendRunning()) return { ok: false, error: OVERSPEND_BUSY };
    const held = this.walletPayment;
    if (typeof signature !== "string" || !signature || !held || held.run !== runId || held.code !== code) return { ok: false, error: "sign the payment in your wallet first" };
    if (this.approving) return { ok: false, error: "the payment is already being sent" };
    this.approving = true;
    try {
      if (!(await signedByWallet(held.prepared, signature))) {
        return { ok: false, error: "The signature was not accepted: it is not this wallet's signature of this payment. Nothing was paid. (A smart-contract wallet account cannot be used here yet; use an ordinary account.)" };
      }
      // A signature is good for a few minutes only. One about to run out would be refused by the seller after being
      // sent, which reads as a payment in doubt; it is dropped here instead, unsent.
      if (secondsLeft(held.prepared) < MIN_SIGNATURE_SECONDS) {
        this.walletPayment = null;
        return { ok: false, error: "That signature has run out of time (it is good for a few minutes). Nothing was sent or paid. Press the button again to sign a fresh one." };
      }
      if (!run.awaiting(code)) return { ok: false, error: "The run was no longer waiting, so nothing was paid. The signature was not sent anywhere." };
      (this.marketPayer as WalletPayer).arm(held.prepared, signature);
      this.walletPayment = null;
      const result = run.approve(code);
      if (!result.ok) return result;
      this.log.push("info", "MARKET", `run ${runId}: the wallet ${shortEvm(held.prepared.wallet)} signed a payment of ${usdExact(held.prepared.terms.amount)} to the seller`);
      return { ok: true, run: run.view() };
    } finally {
      this.approving = false;
    }
  }

  /**
   * The sign-in message an Ethereum wallet signs to look at ("look") or destroy ("destroy") the machine it
   * owns. The seller takes each signed message once, so a new one is made every time. Nothing is sent here.
   */
  walletSignInMessage(runId: string, kind: "look" | "destroy"): { ok: true; message: string; wallet: string } | { ok: false; error: string } {
    const run = this.market;
    if (!run || run.view().id !== runId) return { ok: false, error: "that run is not the current run" };
    const payer = this.marketPayer;
    const machine = run.view().machine;
    if (!payer?.self || !machine) return { ok: false, error: "this run has no machine that your wallet owns" };
    const challenge = walletAuthChallenge(payer.address, kind === "look" ? "GET" : "DELETE", SellerClient.instancePath(machine.id));
    this.walletSignIn = { run: runId, kind, challenge, at: Date.now() };
    return { ok: true, message: challenge.message, wallet: payer.address };
  }

  /** Uses the sign-in the wallet signed: one look at its machine, or its destroy. */
  async useWalletSignIn(runId: string, kind: "look" | "destroy", signature: string): Promise<{ ok: true; run: MarketRunView } | { ok: false; error: string }> {
    const run = this.market;
    const held = this.walletSignIn;
    const payer = this.marketPayer;
    if (!run || run.view().id !== runId || !payer?.self) return { ok: false, error: "that run is not the current run" };
    if (!held || held.run !== runId || held.kind !== kind || Date.now() - held.at > SIGN_IN_TTL_MS) return { ok: false, error: "That sign-in is too old or was already used. Try again." };
    // good once: the seller refuses a repeat, so it is not kept
    this.walletSignIn = null;
    const headers = await walletAuthHeaders(payer.address, held.challenge, signature);
    if (!headers) return { ok: false, error: "The signature was not accepted: it is not this wallet's signature of the sign-in message." };
    const result = kind === "look" ? await run.look(headers) : await run.destroyOwned(headers);
    if (!result.ok) return result;
    if (kind === "destroy") this.log.push("info", "MARKET", `run ${runId}: the wallet ${shortEvm(payer.address)} destroyed its machine`);
    return { ok: true, run: run.view() };
  }

  /** The wallet and agent of a wallet-funded run that is over: the only time an approval can be left unused. */
  private endedWalletRun(runId: string): { ok: true; market: RunInput["market"]; owner: string; delegate: string } | { ok: false; error: string } {
    const run = this.market;
    if (!run || run.view().id !== runId) return { ok: false, error: "that run is not the current run" };
    const payer = this.marketPayer;
    if (!payer?.funds) return { ok: false, error: "this run was paid from the agent's wallet, not a connected one" };
    if (payer.self) return { ok: false, error: "this run was paid by your wallet directly, so the agent was never given an approval to take back" };
    if (!MARKET_ENDED.has(run.view().phase)) return { ok: false, error: "wait until the run is over" };
    return { ok: true, market: run.view().market, owner: payer.funds, delegate: payer.address };
  }

  /**
   * What the wallet of an ended wallet-funded run still lets the agent move, read from the chain, and the
   * transaction that takes it back. `none` when nothing is left. Unsigned; nothing is sent here.
   */
  async walletRevoke(runId: string): Promise<{ ok: true; none: true } | { ok: true; none: false; transaction: string; chain: "solana:devnet" | "solana:mainnet"; wallet: string; exact: string } | { ok: false; error: string }> {
    const found = this.endedWalletRun(runId);
    if (!found.ok) return found;
    try {
      const built = await buildRevoke(rpcFor(found.market), found);
      if (!built) return { ok: true, none: true };
      return { ok: true, none: false, transaction: built.transaction, chain: found.market === "real" ? "solana:mainnet" : "solana:devnet", wallet: found.owner, exact: usdExact(built.atomic.toString()) };
    } catch (error) {
      return { ok: false, error: error instanceof WalletError ? error.message : `The approval could not be read: ${(error as Error).message}` };
    }
  }

  /** Relays the revoke the wallet signed, after checking it is exactly that. */
  async sendWalletRevoke(runId: string, signedTransaction: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const found = this.endedWalletRun(runId);
    if (!found.ok) return found;
    const checked = checkSignedRevoke(signedTransaction, { owner: found.owner, account: await usdcAccount(found.market, found.owner) });
    if (!checked.ok) return { ok: false, error: `The revoke was not accepted: ${checked.error}.` };
    try {
      const tx = await sendSigned(rpcFor(found.market), checked.wire);
      this.log.push("info", "MARKET", `run ${runId}: the connected wallet took back its unused approval (transaction ${tx})`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `The revoke was not confirmed as sent (${(error as Error).message}). Try again.` };
    }
  }

  /** Destroys the current run's machine, cancels it at the approval stop, or destroys a machine recovered from the journal. */
  async destroyMarket(input: { run?: string; cancel?: boolean; open?: { run: string } }): Promise<{ ok: true; message?: string } | { ok: false; error: string }> {
    const current = this.market;
    const target = input.open?.run ?? input.run;
    if (!target) return { ok: false, error: "say which run" };
    if (current && current.view().id === target) {
      if (input.cancel) return current.cancel();
      const owned = current.view();
      // a machine the visitor's Ethereum wallet owns answers only to that wallet
      if (owned.selfManaged && owned.machine && (owned.phase === "provisioning" || owned.phase === "ready" || owned.phase === "failed")) {
        return { ok: false, error: "This machine belongs to your wallet, so destroying it needs your wallet's signature. Press Destroy now and sign in the wallet." };
      }
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
    // with no machine id the search goes by plan and region through everything the wallet owns; every public
    // visitor shares that wallet, so the search could land on someone else's machine
    if (this.kind === "public" && !open.instance) return { ok: false, error: "This purchase has no machine on record. Dismiss it instead." };
    // paid by an Ethereum wallet: the machine is that wallet's, and nothing on this computer can sign for it
    if (isEvmAddress(open.agent)) {
      return { ok: false, error: `This machine belongs to the wallet ${shortEvm(open.agent)} that paid for it, and only that wallet can destroy it. It runs until its prepaid time is over. Once it is gone, dismiss this.` };
    }
    // the same holds for the owner while the site is public: the match could land on a visitor's machine
    if (!open.instance && sharedWallets()) {
      return { ok: false, error: "This purchase has no machine on record, and while the site is public a machine is never picked by plan and region alone (it could be a visitor's). Check the seller's list with npm run market:sweep (add --audience public for visitors' machines), then dismiss this." };
    }
    // machines known to belong to other runs are never picked by the plan-and-region match
    const exclude = new Set(journal.all().filter((e) => e.run !== runId && e.instance).map((e) => e.instance!));
    const live = this.market?.view().machine?.id;
    if (live) exclude.add(live);
    let result: RecoverResult;
    try {
      // the machine answers only to the agent wallet that paid for it, which the journal recorded
      result = await destroyOpenPurchase(open, sellerFor(open.market, await payerOwning(open.market, open.agent)), journal, { exclude });
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    if (!result.ok) return result;
    this.log.push("info", "MARKET", `run ${open.run}: ${result.message}`);
    return { ok: true, message: result.message };
  }
}
