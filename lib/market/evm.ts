import { randomBytes } from "node:crypto";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, getAddress, http, parseAbi, verifyMessage, verifyTypedData, type Hex } from "viem";
import { authMessage } from "./auth";
import { BASE_NETWORKS, MAX_PAYMENT_USD, type Chain } from "./guard";
import type { Payer, PaymentRequired } from "./pay";
import type { MarketId } from "./types";

/**
 * Paying from an Ethereum wallet (MetaMask, Coinbase Wallet, Rabby and the like), in USDC on Base.
 *
 * The wallet pays the seller directly and so owns the machine. It signs one message in the browser: an
 * authorization for USDC to move exactly the quoted amount from it to the seller (EIP-3009, the x402
 * "exact" payment on Ethereum-type chains). That costs the wallet no network fee, and it is not a
 * transaction the wallet sends: the seller's side puts it on chain. This app never holds the money or a
 * key; it prepares the message, checks the signature, and passes the payment on with the order.
 *
 * Because the wallet owns the machine, the seller answers questions about it only to that wallet, with a
 * fresh signature each time (it refuses a repeated one). So the app cannot watch or destroy such a machine
 * by itself: every look and the destroy are signed in the browser too.
 */

export class EvmWalletError extends Error {}

export const isEvmAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** A run pays on Base when it is paid from an Ethereum address; everything else pays on Solana. */
export const chainOfWallet = (wallet: string | null | undefined): Chain => (isEvmAddress(wallet) ? "base" : "solana");

const same = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What the wallet is shown and signs (eth_signTypedData_v4): every number as a decimal string, so it survives JSON. */
export type WalletTypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "TransferWithAuthorization";
  message: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
};

export type PreparedPayment = {
  wallet: string;
  market: MarketId;
  typedData: WalletTypedData;
  /** exactly what the signature covers; a payment for anything else cannot be made with it */
  terms: { network: string; asset: string; payTo: string; amount: string; name: string; version: string };
  /** the payment as it will be sent, with the signature still blank */
  payload: PaymentPayload;
  /** the authorization's one-time number: how the payment is found on chain later */
  nonce: string;
};

const TRANSFER_TYPE = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];
const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
/** A signature is good for at most this long, whatever the seller asks for. */
const MAX_VALID_SECONDS = 2 * 3600;
const BLANK_SIGNATURE = `0x${"00".repeat(65)}` as Hex;

const termsOf = (req: PaymentRequirements): PreparedPayment["terms"] | null => {
  const extra = isObj(req.extra) ? req.extra : {};
  if (typeof extra.name !== "string" || typeof extra.version !== "string") return null;
  return { network: req.network, asset: req.asset, payTo: req.payTo, amount: req.amount, name: extra.name, version: extra.version };
};

/**
 * Builds the one message the wallet signs for a quote: USDC on this market's Base network, from the
 * wallet to the seller, for exactly the quoted amount. The x402 library writes it; this checks every
 * field of what it wrote before a wallet is ever shown it. Signs nothing, sends nothing.
 */
export async function preparePayment(required: PaymentRequired, o: { wallet: string; market: MarketId; now?: () => number }): Promise<PreparedPayment> {
  const net = BASE_NETWORKS[o.market];
  const req = required.accepts.length === 1 ? required.accepts[0] : null;
  if (!req) throw new EvmWalletError("The seller's payment terms are not a single offer.");
  if (!isEvmAddress(o.wallet)) throw new EvmWalletError("That is not an Ethereum wallet address.");
  if (req.scheme !== "exact" || req.network !== net.caip2 || !same(req.asset, net.usdc)) throw new EvmWalletError(`The seller did not ask for USDC on ${net.label}.`);
  if (!isEvmAddress(req.payTo) || !/^\d{1,30}$/.test(req.amount)) throw new EvmWalletError("The seller's payment terms are malformed.");
  const terms = termsOf(req);
  if (!terms) throw new EvmWalletError("The seller did not say which USDC contract version to sign for.");
  const method = isObj(req.extra) ? req.extra.assetTransferMethod : undefined;
  if (method !== undefined && method !== "eip3009") throw new EvmWalletError("The seller asked for a kind of approval this app does not ask a wallet for.");

  const wallet = getAddress(o.wallet);
  let seen: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> } | null = null;
  const signer = {
    address: wallet,
    // the library asks its signer to sign; here it is only asked what it would sign
    async signTypedData(m: NonNullable<typeof seen>) {
      if (seen) throw new EvmWalletError("The payment asked for more than one signature.");
      seen = m;
      return BLANK_SIGNATURE;
    },
  };
  const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer)).setSpendControls({ maxAmountPerPayment: `$${MAX_PAYMENT_USD}` });
  const payload = await new x402HTTPClient(client).createPaymentPayload({ ...required, accepts: [req] });
  const t = seen as { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> } | null;
  if (!t) throw new EvmWalletError("The payment could not be prepared for a wallet to sign.");

  // Everything the wallet will be shown is checked against the quote, field by field.
  const m = t.message;
  const big = (v: unknown): bigint | null => (typeof v === "bigint" ? v : typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);
  const value = big(m.value);
  const validAfter = big(m.validAfter);
  const validBefore = big(m.validBefore);
  const nowSec = BigInt(Math.floor((o.now ?? Date.now)() / 1000));
  const fields = Object.keys(m).sort().join(",");
  if (
    t.primaryType !== "TransferWithAuthorization" ||
    fields !== "from,nonce,to,validAfter,validBefore,value" ||
    big(t.domain.chainId) !== BigInt(net.chainId) ||
    !same(t.domain.verifyingContract, net.usdc) ||
    t.domain.name !== terms.name ||
    t.domain.version !== terms.version ||
    !same(m.from, wallet) ||
    !same(m.to, req.payTo) ||
    value === null ||
    value !== BigInt(req.amount) ||
    validAfter === null ||
    validBefore === null ||
    validBefore <= nowSec ||
    validBefore - nowSec > BigInt(MAX_VALID_SECONDS) ||
    typeof m.nonce !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(m.nonce)
  ) {
    throw new EvmWalletError("The prepared payment did not match the quote, so no wallet was asked to sign it.");
  }

  return {
    wallet,
    market: o.market,
    terms,
    payload,
    nonce: m.nonce,
    typedData: {
      domain: { name: terms.name, version: terms.version, chainId: net.chainId, verifyingContract: getAddress(net.usdc) },
      types: { EIP712Domain: DOMAIN_TYPE, TransferWithAuthorization: TRANSFER_TYPE },
      primaryType: "TransferWithAuthorization",
      message: { from: wallet, to: getAddress(req.payTo), value: value.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce: m.nonce },
    },
  };
}

/** An ordinary account's signature: 65 bytes. */
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/**
 * True when `signature` is the wallet's signature of the prepared message, checked by arithmetic alone.
 * Only an ordinary account's signature passes. A smart-contract account (a Safe, a "smart wallet") signs
 * differently, and is refused on purpose: the seller's sign-in for looking at a machine and destroying it
 * takes ordinary signatures only, so such a wallet could pay and then never reach what it paid for.
 * Never throws.
 */
export async function signedByWallet(p: PreparedPayment, signature: string): Promise<boolean> {
  if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) return false;
  const d = p.typedData;
  const args = {
    address: p.wallet as Hex,
    domain: { ...d.domain, verifyingContract: d.domain.verifyingContract as Hex },
    types: { TransferWithAuthorization: TRANSFER_TYPE },
    primaryType: "TransferWithAuthorization" as const,
    message: { from: d.message.from as Hex, to: d.message.to as Hex, value: BigInt(d.message.value), validAfter: BigInt(d.message.validAfter), validBefore: BigInt(d.message.validBefore), nonce: d.message.nonce as Hex },
    signature: signature as Hex,
  };
  try {
    return await verifyTypedData(args);
  } catch {
    return false;
  }
}

/** Seconds the prepared payment's signature is still good for. */
export function secondsLeft(p: PreparedPayment, now: () => number = Date.now): number {
  return Number(p.typedData.message.validBefore) - Math.floor(now() / 1000);
}

/** A payer for one run whose money and signature are the visitor's own Ethereum wallet. */
export type WalletPayer = Payer & {
  self: true;
  chain: "base";
  /** Hands over the signed message for a prepared payment. The payer then pays that, once, and nothing else. */
  arm(prepared: PreparedPayment, signature: string): void;
};

const NOT_HERE = "this wallet signs in the browser, not on this computer";

/**
 * Pays with a signature the wallet already gave, and only for the terms that signature covers: if the
 * seller's terms have changed since (amount, recipient, token, network), it refuses rather than pay.
 */
export function makeWalletPayer(walletAddress: string): WalletPayer {
  const wallet = getAddress(walletAddress);
  let armed: { prepared: PreparedPayment; signature: string } | null = null;
  let used = false;
  const http402 = new x402HTTPClient(new x402Client());
  return {
    address: wallet,
    funds: wallet,
    self: true,
    chain: "base",
    signer: {
      address: wallet,
      sign: async () => {
        throw new Error(NOT_HERE);
      },
    },
    arm(prepared, signature) {
      if (used) throw new Error("this run's payment was already made");
      if (!same(prepared.wallet, wallet)) throw new Error("that payment was prepared for another wallet");
      armed = { prepared, signature };
    },
    async payHeaders(required) {
      if (!armed) throw new Error("your wallet has not signed this payment");
      if (used) throw new Error("this run's payment was already made");
      const req = required.accepts.length === 1 ? required.accepts[0] : null;
      const now = req ? termsOf(req) : null;
      const t = armed.prepared.terms;
      if (!req || !now || now.network !== t.network || !same(now.asset, t.asset) || !same(now.payTo, t.payTo) || now.amount !== t.amount || now.name !== t.name || now.version !== t.version) {
        throw new Error("the seller changed its payment terms after your wallet signed, so nothing was paid");
      }
      used = true;
      const inner = isObj(armed.prepared.payload.payload) ? armed.prepared.payload.payload : {};
      // the seller compares `accepted` with what it asks for now; the signature covers the amount, the recipient and the token
      const payload: PaymentPayload = { ...armed.prepared.payload, accepted: req, ...(required.resource ? { resource: required.resource } : {}), payload: { ...inner, signature: armed.signature } };
      return http402.encodePaymentSignatureHeader(payload);
    },
    payReference: () => armed?.prepared.nonce ?? null,
  };
}

// ---- signing in to the seller as the wallet --------------------------------------------------

/** One management call for the wallet to sign: the seller takes each signed message once, within five minutes. */
export type WalletAuthChallenge = { method: "GET" | "DELETE"; path: string; timestampMs: number; nonce: string; message: string };

/** The seller's sign-in message for an Ethereum wallet names the address in lower case. */
export function walletAuthChallenge(wallet: string, method: "GET" | "DELETE", path: string, o: { now?: () => number; nonce?: () => string } = {}): WalletAuthChallenge {
  const timestampMs = (o.now ?? Date.now)();
  const nonce = o.nonce ? o.nonce() : randomBytes(16).toString("hex");
  return { method, path, timestampMs, nonce, message: authMessage({ chain: "base", address: wallet.toLowerCase(), method, path, body: "", timestampMs, nonce }) };
}

/** The sign-in headers for a challenge the wallet signed (personal_sign), or null when the signature is not that wallet's. */
export async function walletAuthHeaders(wallet: string, c: WalletAuthChallenge, signature: string): Promise<Record<string, string> | null> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    if (!(await verifyMessage({ address: wallet as Hex, message: c.message, signature: signature as Hex }))) return null;
  } catch {
    return null;
  }
  return {
    "X-Auth-Address": wallet.toLowerCase(),
    "X-Auth-Chain": "base",
    "X-Auth-Signature": signature,
    "X-Auth-Timestamp": String(c.timestampMs),
    "X-Auth-Nonce": c.nonce,
    "X-Auth-Sig-Encoding": "hex",
  };
}

/** The seller's side of the same check, for the test seller. Does not track nonces; the caller must reject reuse. */
export async function verifyWalletAuth(
  headers: Headers,
  p: { method: string; path: string; body: string; nowMs: number; maxSkewMs?: number },
): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
  const address = headers.get("X-Auth-Address");
  const signature = headers.get("X-Auth-Signature");
  const timestamp = headers.get("X-Auth-Timestamp");
  const nonce = headers.get("X-Auth-Nonce");
  if (!address || !signature || !timestamp || !nonce) return { ok: false, reason: "missing auth headers" };
  if (headers.get("X-Auth-Chain") !== "base") return { ok: false, reason: "unsupported chain" };
  if (headers.get("X-Auth-Sig-Encoding") !== "hex") return { ok: false, reason: "unsupported signature encoding" };
  if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reason: "malformed nonce" };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "malformed timestamp" };
  const timestampMs = Number(timestamp);
  if (Math.abs(p.nowMs - timestampMs) > (p.maxSkewMs ?? 300_000)) return { ok: false, reason: "timestamp outside the allowed window" };
  if (!/^0x[0-9a-f]{40}$/.test(address)) return { ok: false, reason: "malformed address" };
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, reason: "malformed signature" };
  try {
    const message = authMessage({ chain: "base", address, method: p.method, path: p.path, body: p.body, timestampMs, nonce });
    if (!(await verifyMessage({ address: address as Hex, message, signature: signature as Hex }))) return { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true, address };
}

// ---- looking a payment up on chain ------------------------------------------------------------

const USDC_ABI = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)", "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"]);
/** How far back the payment's transaction is looked for: a little over the two hours a signature can last (a block every 2 s). */
const LOOKBACK_BLOCKS = BigInt(4000);

export type BaseChainReader = {
  used(usdc: string, payer: string, nonce: string): Promise<boolean>;
  /** the transaction that used the authorization, when it can be found */
  usedIn(usdc: string, payer: string, nonce: string): Promise<string | null>;
};

function rpcReader(rpcUrl: string): BaseChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
  return {
    used: (usdc, payer, nonce) => client.readContract({ address: usdc as Hex, abi: USDC_ABI, functionName: "authorizationState", args: [payer as Hex, nonce as Hex] }),
    async usedIn(usdc, payer, nonce) {
      const latest = await client.getBlockNumber();
      const logs = await client.getLogs({
        address: usdc as Hex,
        event: USDC_ABI[1],
        args: { authorizer: payer as Hex, nonce: nonce as Hex },
        fromBlock: latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : BigInt(0),
        toBlock: latest,
      });
      return logs[0]?.transactionHash ?? null;
    },
  };
}

/**
 * Whether the wallet's signed authorization was used, read from USDC itself: each authorization carries a
 * one-time number, and the token records when one is spent. Null when it was not (the money has not moved);
 * "unavailable" when the chain could not be read, or when it was used but its transaction could not be
 * found. Read-only; never pays.
 */
export async function findBasePayment(o: { market: MarketId; payer: string; nonce?: string | null; reader?: BaseChainReader }): Promise<{ tx: string } | null | "unavailable"> {
  const net = BASE_NETWORKS[o.market];
  if (!o.nonce || !/^0x[0-9a-fA-F]{64}$/.test(o.nonce) || !isEvmAddress(o.payer)) return "unavailable";
  const reader = o.reader ?? rpcReader(net.rpcUrl);
  try {
    if (!(await reader.used(net.usdc, o.payer, o.nonce))) return null;
  } catch {
    return "unavailable";
  }
  try {
    const tx = await reader.usedIn(net.usdc, o.payer, o.nonce);
    return tx ? { tx } : "unavailable";
  } catch {
    return "unavailable";
  }
}
