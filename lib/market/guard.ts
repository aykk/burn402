import type { MarketId } from "./types";

export const NETWORKS: Record<MarketId, { caip2: string; usdc: string; label: string }> = {
  test: {
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    label: "Solana devnet",
  },
  real: {
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    label: "Solana mainnet",
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

export type Accepts = { scheme: string; network: string; asset: string; amount: string; payTo: string };

type GuardInput = {
  accepts: Accepts;
  market: MarketId;
  approvedAtomic: bigint;
  budgetLeftUsd: number;
  rateUsdHr: number;
  hours: number;
  alreadyPaid: boolean;
  payTo?: string;
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

const fail = (code: GuardCode, detail: string): GuardResult => ({ ok: false, code, detail });

/** Last check before a payment is signed. Never throws: anything unexpected is MALFORMED. */
export function checkPayment(input: GuardInput): GuardResult {
  try {
    return check(input);
  } catch (e) {
    return fail("MALFORMED", `Payment terms could not be checked: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}

function check(input: GuardInput): GuardResult {
  const { accepts, market, approvedAtomic, budgetLeftUsd, rateUsdHr, hours, alreadyPaid, payTo } = input;
  const net = NETWORKS[market];
  if (!net) return fail("MALFORMED", "Unknown market");
  if (!accepts || typeof accepts !== "object") return fail("MALFORMED", "Payment terms are missing");
  for (const k of ["scheme", "network", "asset", "amount", "payTo"] as const) {
    if (typeof accepts[k] !== "string" || accepts[k] === "") return fail("MALFORMED", `Payment terms have no ${k}`);
  }
  if (!/^\d+$/.test(accepts.amount) || accepts.amount.length > MAX_AMOUNT_DIGITS) {
    return fail("MALFORMED", "Payment amount is not a plain whole number");
  }
  if (typeof approvedAtomic !== "bigint" || approvedAtomic < BigInt(0)) return fail("MALFORMED", "Approved amount is invalid");
  for (const [name, v] of [["budget", budgetLeftUsd], ["rate limit", rateUsdHr], ["hours", hours]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v)) return fail("MALFORMED", `The ${name} is not a number`);
  }
  if (hours <= 0) return fail("MALFORMED", "Hours must be above zero");
  if (typeof alreadyPaid !== "boolean") return fail("MALFORMED", "Already-paid flag is not a boolean");
  if (alreadyPaid) return fail("ALREADY_PAID", "This run already has a payment; refusing to pay again");

  if (accepts.scheme !== "exact" || accepts.network !== net.caip2) {
    return fail("WRONG_NETWORK", `Seller asked for ${clip(accepts.scheme)} on ${clip(accepts.network)}; this market is exact on ${net.label}`);
  }
  if (accepts.asset !== net.usdc) return fail("WRONG_ASSET", `Seller asked for ${clip(accepts.asset)}, not USDC on ${net.label}`);

  const amount = BigInt(accepts.amount);
  if (amount > approvedAtomic) {
    return fail("OVER_QUOTE", `Seller now asks ${amount} atomic units, above the approved ${approvedAtomic}`);
  }
  if (payTo !== undefined && payTo !== accepts.payTo) {
    return fail("OVER_QUOTE", `Seller changed the recipient from ${clip(payTo)} to ${clip(accepts.payTo)}`);
  }
  const usd = atomicToUsd(accepts.amount);
  if (usd > budgetLeftUsd) return fail("OVER_BUDGET", `$${usd} is more than the $${budgetLeftUsd} left in the budget`);
  if (usd / hours > rateUsdHr) return fail("OVER_RATE", `$${usd / hours} per hour is above the $${rateUsdHr} per hour limit`);
  return { ok: true, usd };
}
