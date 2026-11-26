import { networkName, tokenName, usdExact, usdMoreThan } from "./money";
import type { MarketId } from "./types";

/** `rpcUrl` is a public JSON-RPC endpoint, used only to read whether a payment landed. */
export const NETWORKS: Record<MarketId, { caip2: string; usdc: string; label: string; rpcUrl: string }> = {
  test: {
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    label: "Solana devnet",
    rpcUrl: "https://api.devnet.solana.com",
  },
  real: {
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    label: "Solana mainnet",
    rpcUrl: "https://api.mainnet-beta.solana.com",
  },
};

export type GuardCode =
  | "WRONG_NETWORK"
  | "WRONG_ASSET"
  | "OVER_QUOTE"
  | "OVER_BUDGET"
  | "OVER_RATE"
  | "ALREADY_PAID"
  | "MALFORMED";

export type Accepts = { scheme: string; network: string; asset: string; amount: string; payTo: string; extra?: Record<string, unknown> };

type GuardInput = {
  accepts: Accepts;
  market: MarketId;
  approvedAtomic: bigint;
  budgetLeftUsd: number;
  rateUsdHr: number;
  hours: number;
  alreadyPaid: boolean;
  payTo?: string;
  /** the paying wallet's address; a requirement naming it as fee payer is refused */
  payer?: string;
};
type GuardResult = { ok: true; usd: number } | { ok: false; code: GuardCode; detail: string };

const MAX_AMOUNT_DIGITS = 30;

export function atomicToUsd(atomic: string): number {
  return Number(atomic) / 1e6;
}

/** Rounds up to the next atomic unit. */
export function usdToAtomic(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError("usd must be a finite non-negative number");
  // toFixed(6) strips float noise (0.01 * 1e6) without hiding real fractions of an atomic unit.
  return BigInt(Math.ceil(Number((usd * 1e6).toFixed(6))));
}

/** Seller-supplied text is cut short before it reaches a message. */
const clip = (v: unknown): string => {
  const t = String(v);
  return t.length > 64 ? `${t.slice(0, 64)}...` : t;
};

const FIELD_NAMES = { scheme: "kind of payment", network: "network", asset: "token", amount: "amount", payTo: "recipient" } as const;

/** The token as the owner would say it; a USDC mint from the other market names that market. */
function tokenFor(asset: string, market: MarketId): string {
  const name = tokenName(asset);
  if (name !== "USDC" || asset === NETWORKS[market].usdc) return name;
  const other = (Object.keys(NETWORKS) as MarketId[]).find((m) => NETWORKS[m].usdc === asset);
  return other ? `USDC from ${NETWORKS[other].label}` : name;
}

const fail = (code: GuardCode, detail: string): GuardResult => ({ ok: false, code, detail });

/** Last check before a payment is signed. Never throws: anything unexpected is MALFORMED. */
/** The most this app will sign in a single payment, whatever the budget says. The payer's own cap (pay.ts) uses the same number. */
export const MAX_PAYMENT_USD = 5;
const MAX_PAYMENT_ATOMIC = BigInt(MAX_PAYMENT_USD) * BigInt(1_000_000);

export function checkPayment(input: GuardInput): GuardResult {
  try {
    return check(input);
  } catch (e) {
    return fail("MALFORMED", `The payment terms could not be checked: ${e instanceof Error ? e.message : "unknown error"}.`);
  }
}

function check(input: GuardInput): GuardResult {
  const { accepts, market, approvedAtomic, budgetLeftUsd, rateUsdHr, hours, alreadyPaid, payTo, payer } = input;
  const net = NETWORKS[market];
  if (!net) return fail("MALFORMED", "Unknown market");
  if (!accepts || typeof accepts !== "object") return fail("MALFORMED", "Payment terms are missing");
  for (const k of ["scheme", "network", "asset", "amount", "payTo"] as const) {
    if (typeof accepts[k] !== "string" || accepts[k] === "") return fail("MALFORMED", `The seller's payment terms have no ${FIELD_NAMES[k]}.`);
  }
  if (!/^\d+$/.test(accepts.amount) || accepts.amount.length > MAX_AMOUNT_DIGITS) {
    return fail("MALFORMED", "The seller's payment amount is not a plain whole number.");
  }
  if (typeof approvedAtomic !== "bigint" || approvedAtomic < BigInt(0)) return fail("MALFORMED", "Approved amount is invalid");
  for (const [name, v] of [["budget", budgetLeftUsd], ["rate limit", rateUsdHr], ["hours", hours]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v)) return fail("MALFORMED", `The ${name} is not a number`);
  }
  if (hours <= 0) return fail("MALFORMED", "Hours must be above zero");
  if (typeof alreadyPaid !== "boolean") return fail("MALFORMED", "Already-paid flag is not a boolean");
  if (alreadyPaid) return fail("ALREADY_PAID", "This run already made a payment, so the agent will not pay again.");

  if (accepts.scheme !== "exact") {
    return fail("WRONG_NETWORK", `The seller asked for a kind of payment this agent does not make ("${clip(accepts.scheme)}"); it pays only exact amounts.`);
  }
  if (accepts.network !== net.caip2) return fail("WRONG_NETWORK", `The seller asked to be paid on ${clip(networkName(accepts.network))} instead of ${net.label}.`);
  const feePayer = accepts.extra && typeof accepts.extra === "object" ? accepts.extra.feePayer : undefined;
  if (typeof payer === "string" && payer !== "" && feePayer === payer) return fail("WRONG_NETWORK", "The seller asked your wallet to pay the network fee.");
  if (accepts.asset !== net.usdc) return fail("WRONG_ASSET", `The seller asked to be paid in ${tokenFor(accepts.asset, market)} instead of USDC on ${net.label}.`);

  const amount = BigInt(accepts.amount);
  if (amount > approvedAtomic) {
    return fail("OVER_QUOTE", `The seller now asks ${usdExact(accepts.amount)}, more than the ${usdExact(approvedAtomic.toString())} you approved.`);
  }
  if (payTo !== undefined && payTo !== accepts.payTo) {
    return fail("OVER_QUOTE", `The seller changed the recipient of the payment from ${clip(payTo)} to ${clip(accepts.payTo)}.`);
  }
  if (amount > MAX_PAYMENT_ATOMIC) {
    return fail("OVER_BUDGET", `${usdExact(accepts.amount)} is more than the $${MAX_PAYMENT_USD.toFixed(2)} this app will pay in one payment.`);
  }
  const usd = atomicToUsd(accepts.amount);
  if (usd > budgetLeftUsd) return fail("OVER_BUDGET", `${usdExact(accepts.amount)} is more than the ${usdMoreThan(usd, budgetLeftUsd)[1]} left in your budget.`);
  if (usd / hours > rateUsdHr) {
    const [rate, limit] = usdMoreThan(usd / hours, rateUsdHr);
    return fail("OVER_RATE", `${rate} an hour is more than your hourly limit of ${limit}.`);
  }
  return { ok: true, usd };
}
