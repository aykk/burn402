import { createHash } from "node:crypto";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { toClientSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { getSetComputeUnitLimitInstruction, setTransactionMessageComputeUnitPrice } from "@solana-program/compute-budget";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getApproveCheckedInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  prependTransactionMessageInstruction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type KeyPairSigner,
} from "@solana/kit";
import { base58Decode } from "../x402/client";
import { signerFromSecret, verifyEd25519 } from "./auth";
import { MAX_PAYMENT_USD, NETWORKS } from "./guard";
import type { Payer } from "./pay";
import type { MarketId } from "./types";

/**
 * Paying from a connected wallet without holding its key or its money.
 *
 * The seller lets only the wallet that paid manage the machine, and it asks for a fresh signature on
 * every status check, so a browser wallet cannot be the payer: it would have to pop up for each one.
 * Instead the visitor's wallet signs one transaction that lets the agent's wallet move exactly the quoted
 * amount of USDC out of the visitor's account (an SPL token approval), and the agent pays the seller from
 * that approval. The money goes from the visitor's account straight to the seller; the agent's wallet
 * never holds it, can never move more than was approved, and owns the machine it then manages.
 */

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** What a wallet adds of its own before it signs: a priority fee (compute budget) and Phantom's safety checks (Lighthouse). */
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
/** The only programs an approval may call. Anything else could move the wallet's funds some other way. */
const APPROVAL_PROGRAMS = new Set<string>([TOKEN_PROGRAM_ADDRESS, MEMO_PROGRAM, COMPUTE_BUDGET_PROGRAM, LIGHTHOUSE_PROGRAM]);
/** The approval, its note, and room for a wallet's own few. */
const MAX_APPROVAL_INSTRUCTIONS = 8;
const USDC_DECIMALS = 6;
/** The x402 exact scheme's own numbers for a token transfer (the facilitator checks them). */
const COMPUTE_UNIT_LIMIT = 20_000;
const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;
/** SPL token instruction 13: ApproveChecked { amount: u64, decimals: u8 }. */
const IX_APPROVE_CHECKED = 13;
/** What an approval costs the wallet in network fee, with room to spare (a signature is 5,000 lamports). */
const MIN_LAMPORTS = 10_000;
const MAX_TX_BYTES = 1232;
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True for a base58 string that decodes to a 32-byte Solana address. */
export function isWalletAddress(v: unknown): v is string {
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) return false;
  try {
    return base58Decode(v).length === 32;
  } catch {
    return false;
  }
}

/** A problem the visitor can fix (no USDC, no SOL for the fee, a wrong transaction): shown as written. */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletError";
  }
}

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const RPC_TIMEOUT_MS = 15_000;

/** Plain JSON-RPC against the market's Solana node. Throws the node's own message on an error answer. */
export function rpcFor(market: MarketId, fetchImpl: typeof fetch = fetch): Rpc {
  const url = NETWORKS[market].rpcUrl;
  return async (method, params) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!isObj(body)) throw new Error(`${NETWORKS[market].label} did not answer (HTTP ${response.status})`);
    if (isObj(body.error)) throw new Error(typeof body.error.message === "string" ? body.error.message : `${NETWORKS[market].label} refused the request`);
    return body.result;
  };
}

/** The wallet's USDC account on a market: the standard (associated) token account for the market's USDC. */
export async function usdcAccount(market: MarketId, owner: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ mint: address(NETWORKS[market].usdc), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return ata;
}

export type WalletFunds = {
  /** the wallet's USDC account */
  account: string;
  /** false when the wallet has never held this market's USDC */
  exists: boolean;
  atomic: bigint;
  /** who may move USDC out of the account, and how much is left of that permission */
  delegate: string | null;
  delegated: bigint;
};

/** What the wallet's USDC account holds and who it has approved, as confirmed on chain. */
export async function walletFunds(rpc: Rpc, market: MarketId, owner: string): Promise<WalletFunds> {
  const account = await usdcAccount(market, owner);
  const result = await rpc("getAccountInfo", [account, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const value = isObj(result) ? result.value : null;
  const data = isObj(value) && isObj(value.data) ? value.data : null;
  const info = data && isObj(data.parsed) && isObj(data.parsed.info) ? data.parsed.info : null;
  if (!info || info.mint !== NETWORKS[market].usdc || info.owner !== owner) return { account, exists: false, atomic: BigInt(0), delegate: null, delegated: BigInt(0) };
  const amountOf = (v: unknown): bigint => (isObj(v) && typeof v.amount === "string" && /^\d+$/.test(v.amount) ? BigInt(v.amount) : BigInt(0));
  return {
    account,
    exists: true,
    atomic: amountOf(info.tokenAmount),
    delegate: typeof info.delegate === "string" ? info.delegate : null,
    delegated: amountOf(info.delegatedAmount),
  };
}

/**
 * The note carried by an approval, tying it to one approval stop of one run. A digest, so the one-time
 * code never appears on chain. A wallet's approval made for another run can never be passed off as this one.
 */
export function approvalMemo(runId: string, code: string): string {
  return `burn402 ${createHash("sha256").update(`${runId}:${code}`, "utf8").digest("hex").slice(0, 32)}`;
}

const usd = (atomic: bigint) => `$${(Number(atomic) / 1e6).toFixed(6).replace(/0{1,4}$/, "")}`;

export type ApprovalAsk = { market: MarketId; owner: string; delegate: string; atomic: bigint; memo: string };

/**
 * The transaction the visitor's wallet is asked to sign: "let `delegate` move exactly `atomic` USDC out of
 * my account", with the run's note. Unsigned, base64; the wallet pays its small network fee. Refuses with a
 * plain reason when the wallet could not complete it (no USDC, too little, no SOL for the fee).
 */
export async function buildApproval(rpc: Rpc, ask: ApprovalAsk): Promise<string> {
  const net = NETWORKS[ask.market];
  const funds = await walletFunds(rpc, ask.market, ask.owner);
  if (!funds.exists) throw new WalletError(`Your wallet holds no USDC on ${net.label}.`);
  if (funds.atomic < ask.atomic) throw new WalletError(`Your wallet holds ${usd(funds.atomic)} USDC on ${net.label}; this rental needs ${usd(ask.atomic)}.`);
  const balance = await rpc("getBalance", [ask.owner, { commitment: "confirmed" }]);
  const lamports = isObj(balance) && typeof balance.value === "number" ? balance.value : 0;
  if (lamports < MIN_LAMPORTS) throw new WalletError(`Your wallet needs a little SOL on ${net.label} to pay the network fee for the approval (well under a cent).`);

  const latest = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const lv = isObj(latest) && isObj(latest.value) ? latest.value : null;
  if (!lv || typeof lv.blockhash !== "string" || typeof lv.lastValidBlockHeight !== "number") throw new Error(`${net.label} did not give a recent blockhash`);

  const owner = address(ask.owner);
  const approve = getApproveCheckedInstruction({
    source: address(funds.account),
    mint: address(net.usdc),
    delegate: address(ask.delegate),
    owner: createNoopSigner(owner),
    amount: ask.atomic,
    decimals: USDC_DECIMALS,
  });
  const memo = { programAddress: address(MEMO_PROGRAM), accounts: [], data: new TextEncoder().encode(ask.memo) };
  // legacy format: every wallet signs it, and it needs no lookup tables
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: lv.blockhash as Blockhash, lastValidBlockHeight: BigInt(lv.lastValidBlockHeight as number) }, m),
    (m) => appendTransactionMessageInstructions([approve, memo], m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Checks what the wallet sent back before it is put on chain. The server relays this transaction, so it
 * must be exactly an approval and nothing else:
 *  - signed by the visitor's wallet, the only signer, which also pays the fee;
 *  - it calls only the token program (once: approve exactly `atomic` of the market's USDC, from the
 *    wallet's own account, to `delegate`), the memo program (this run's note), and what a wallet adds of
 *    its own, a priority fee and Phantom's safety checks. Any other program is refused: it could move
 *    the wallet's funds by another route.
 */
export function checkSignedApproval(signedBase64: string, ask: ApprovalAsk & { account: string }): { ok: true; wire: string } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (typeof signedBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signedBase64)) return bad("the signed transaction is not base64");
  const bytes = new Uint8Array(Buffer.from(signedBase64, "base64"));
  if (bytes.length === 0 || bytes.length > MAX_TX_BYTES) return bad("the signed transaction has an impossible size");
  try {
    const tx = getTransactionDecoder().decode(bytes);
    const signature = (tx.signatures as Record<string, Uint8Array | null>)[ask.owner];
    if (!signature) return bad("the transaction is not signed by your wallet");
    if (!verifyEd25519(base58Decode(ask.owner), tx.messageBytes as unknown as Uint8Array, signature)) return bad("your wallet's signature on the transaction is not valid");

    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (message.version !== "legacy" && message.version !== 0) return bad("the transaction is in a format this app does not read");
    if ("addressTableLookups" in message && Array.isArray(message.addressTableLookups) && message.addressTableLookups.length > 0) return bad("the transaction uses lookup tables, which this app does not read");
    const keys = message.staticAccounts.map(String);
    if (keys[0] !== ask.owner) return bad("your wallet must pay the approval's network fee");
    if (message.header.numSignerAccounts !== 1) return bad("the approval must be signed by your wallet alone");
    if (message.instructions.length > MAX_APPROVAL_INSTRUCTIONS) return bad("the transaction holds more instructions than an approval needs");
    if (!message.instructions.every((i) => APPROVAL_PROGRAMS.has(keys[i.programAddressIndex]))) return bad("the transaction does something besides the approval");

    const token = message.instructions.filter((ix) => keys[ix.programAddressIndex] === TOKEN_PROGRAM_ADDRESS);
    if (token.length !== 1) return bad("the transaction must hold exactly one token instruction, the approval");
    const ix = token[0];
    const data = ix.data ? new Uint8Array(ix.data) : new Uint8Array();
    const accounts = (ix.accountIndices ?? []).map((i) => keys[i]);
    if (data.length !== 10 || data[0] !== IX_APPROVE_CHECKED) return bad("the token instruction is not an approval");
    const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
    if (amount !== ask.atomic || data[9] !== USDC_DECIMALS) return bad("the approval is not for the quoted amount");
    if (accounts.length !== 4 || accounts[0] !== ask.account || accounts[1] !== NETWORKS[ask.market].usdc || accounts[2] !== ask.delegate || accounts[3] !== ask.owner) {
      return bad("the approval does not name your USDC account and this run's agent");
    }
    const memo = new TextEncoder().encode(ask.memo);
    const noted = message.instructions.some((m) => keys[m.programAddressIndex] === MEMO_PROGRAM && m.data !== undefined && same(new Uint8Array(m.data), memo));
    if (!noted) return bad("the approval was not made for this run");
    return { ok: true, wire: Buffer.from(bytes).toString("base64") };
  } catch {
    return bad("the signed transaction could not be read");
  }
}

/** Puts a signed transaction on chain; resolves to its id. The node simulates it first and refuses one that would fail. */
export async function sendSigned(rpc: Rpc, wireBase64: string): Promise<string> {
  const signature = await rpc("sendTransaction", [wireBase64, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
  if (typeof signature !== "string" || !signature) throw new Error("the network did not accept the transaction");
  return signature;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the chain shows that `delegate` may move at least `atomic` out of the wallet's USDC account.
 * This, not anything the browser says, is what lets the agent pay.
 */
export async function waitForAllowance(
  rpc: Rpc,
  ask: { market: MarketId; owner: string; delegate: string; atomic: bigint },
  opts: { timeoutMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepMs;
  const until = now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    try {
      const funds = await walletFunds(rpc, ask.market, ask.owner);
      if (funds.delegate === ask.delegate && funds.delegated >= ask.atomic) {
        if (funds.atomic < ask.atomic) throw new WalletError(`your wallet no longer holds the ${usd(ask.atomic)} USDC it approved`);
        return;
      }
    } catch (e) {
      if (e instanceof WalletError) throw e;
      // the node did not answer: ask again until the time is up
    }
    if (now() >= until) throw new WalletError("your wallet's approval did not show up on chain in time, so nothing was paid");
    await sleep(opts.everyMs ?? 1500);
  }
}

/**
 * The x402 "exact" payment, built as the library builds it except for one thing: the USDC leaves the
 * visitor's account, moved by the agent's key under the visitor's approval. The agent's key is the only
 * one that signs; the facilitator adds the fee payer's signature and reports the agent as the payer.
 */
class DelegatedExactScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  readonly findDefaultAsset: SchemeNetworkClient["findDefaultAsset"];

  constructor(
    private readonly agent: KeyPairSigner,
    private readonly o: { market: MarketId; owner: string; rpc: Rpc },
  ) {
    this.findDefaultAsset = new ExactSvmScheme(toClientSvmSigner(agent)).findDefaultAsset;
  }

  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
    const net = NETWORKS[this.o.market];
    // the guard has already held the requirement to this market's USDC; the token program and decimals follow from that
    if (requirements.asset !== net.usdc) throw new Error("a connected wallet pays in this market's USDC only");
    const extra: Obj = isObj(requirements.extra) ? requirements.extra : {};
    const feePayer = extra.feePayer;
    if (typeof feePayer !== "string" || !feePayer) throw new Error("the seller named no fee payer");
    const versions = "transactionVersions" in extra ? extra.transactionVersions : [0];
    if (!Array.isArray(versions) || !versions.includes(0)) throw new Error("the seller asked for a transaction format this app does not build");

    const mint = address(net.usdc);
    const [destination] = await findAssociatedTokenPda({ mint, owner: address(requirements.payTo), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const transfer = getTransferCheckedInstruction({
      source: address(await usdcAccount(this.o.market, this.o.owner)),
      mint,
      destination,
      authority: this.agent,
      amount: BigInt(requirements.amount),
      decimals: USDC_DECIMALS,
    });
    // the seller's memo when it gives one, else a random one, so two equal payments are never the same transaction
    const memoText = typeof extra.memo === "string" && extra.memo ? extra.memo : createHash("sha256").update(`${Date.now()}:${Math.random()}:${requirements.amount}`).digest("hex").slice(0, 32);
    const memo = { programAddress: address(MEMO_PROGRAM), accounts: [], data: new TextEncoder().encode(memoText) };

    let lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint };
    if (typeof extra.recentBlockhash === "string" && extra.recentBlockhash) {
      lifetime = { blockhash: extra.recentBlockhash as Blockhash, lastValidBlockHeight: BigInt(0) };
    } else {
      const latest = await this.o.rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const lv = isObj(latest) && isObj(latest.value) ? latest.value : null;
      if (!lv || typeof lv.blockhash !== "string" || typeof lv.lastValidBlockHeight !== "number") throw new Error(`${net.label} did not give a recent blockhash`);
      lifetime = { blockhash: lv.blockhash as Blockhash, lastValidBlockHeight: BigInt(lv.lastValidBlockHeight) };
    }

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageComputeUnitPrice(COMPUTE_UNIT_PRICE_MICROLAMPORTS, m),
      (m) => setTransactionMessageFeePayer(address(feePayer) as Address, m),
      (m) => prependTransactionMessageInstruction(getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }), m),
      (m) => appendTransactionMessageInstructions([transfer, memo], m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    );
    const signed = await partiallySignTransactionMessageWithSigners(message);
    return { x402Version, payload: { transaction: getBase64EncodedWireTransaction(signed) } };
  }
}

/**
 * A payer that spends a connected wallet's USDC under its approval. `address` and `signer` are the agent's
 * wallet (it signs the payment and owns the machine); `funds` is the visitor's wallet, where the money
 * comes from. Before it signs, it waits until the chain shows the approval for at least the amount asked.
 */
export async function makeDelegatePayer(secretKeyBase58: string, o: { market: MarketId; owner: string; rpc?: Rpc; wait?: Parameters<typeof waitForAllowance>[2] }): Promise<Payer> {
  if (!isWalletAddress(o.owner)) throw new Error("that is not a Solana wallet address");
  const signer = await signerFromSecret(secretKeyBase58);
  if (signer.address === o.owner) throw new Error("that wallet is the agent's own; pay from the agent wallet instead");
  const agent = await createKeyPairSignerFromBytes(base58Decode(secretKeyBase58));
  const rpc = o.rpc ?? rpcFor(o.market);
  const client = new x402Client().register("solana:*", new DelegatedExactScheme(agent, { market: o.market, owner: o.owner, rpc })).setSpendControls({ maxAmountPerPayment: `$${MAX_PAYMENT_USD}` });
  const http = new x402HTTPClient(client);
  return {
    address: signer.address,
    signer,
    funds: o.owner,
    async payHeaders(required) {
      const amount = required.accepts[0]?.amount;
      if (typeof amount !== "string" || !/^\d+$/.test(amount)) throw new Error("the payment request names no amount");
      await waitForAllowance(rpc, { market: o.market, owner: o.owner, delegate: signer.address, atomic: BigInt(amount) }, o.wait);
      return http.encodePaymentSignatureHeader(await http.createPaymentPayload(required));
    },
  };
}
