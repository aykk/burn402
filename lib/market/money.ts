/**
 * Plain words for money, tokens, networks and seller answers. Every sentence the market code
 * shows the owner goes through these, so amounts are exact dollars and nothing raw leaks out.
 */

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
/** The USDC mints of the two markets (the same values as NETWORKS in guard.ts; a test checks they agree). */
const USDC_MINTS = new Set(["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]);
const NETWORK_NAMES: Record<string, string> = {
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana devnet",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana mainnet",
};

const MAX_REASON = 120;
const NO_REASON = "the seller gave no reason";

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Exact dollars for a USDC amount in atomic units (6 decimals): "10382" is "$0.010382",
 * "10000" is "$0.0100". Trailing zeros are trimmed down to 4 decimals, never further.
 */
export function usdExact(atomic: string): string {
  if (typeof atomic !== "string" || !/^\d{1,30}$/.test(atomic)) return "an unreadable amount";
  const digits = atomic.replace(/^0+(?=\d)/, "").padStart(7, "0");
  const whole = digits.slice(0, -6);
  const frac = digits.slice(-6).replace(/(\d{4}\d*?)0+$/, "$1");
  return `$${group(whole)}.${frac}`;
}

/** Dollars for a limit or budget the owner typed: up to 6 decimals, at least 2 ("$1.00", "$0.05", "$0.010382"). */
export function usdPlain(usd: number): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "an unreadable amount";
  const fixed = Math.abs(usd).toFixed(6);
  const [whole, frac] = fixed.split(".");
  return `${usd < 0 ? "-" : ""}$${group(whole)}.${frac.replace(/(\d{2}\d*?)0+$/, "$1")}`;
}

const short = (s: string) => (s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

/** "USDC", "SOL", or "another token (Abcd…Wxyz)". */
export function tokenName(mint: string): string {
  if (mint === WRAPPED_SOL) return "SOL";
  if (USDC_MINTS.has(mint)) return "USDC";
  return `another token (${short(String(mint))})`;
}

/** "Solana devnet", "Solana mainnet", or "another network (…)". */
export function networkName(caip2: string): string {
  return NETWORK_NAMES[caip2] ?? `another network (${String(caip2).slice(0, 40)})`;
}

/** A seller's short message from a JSON answer (error, message, detail or reason), capped; never the raw body. */
export function sellerReason(text: string): string {
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    return NO_REASON;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return NO_REASON;
  const b = body as Record<string, unknown>;
  for (const k of ["error", "message", "detail", "reason"]) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim().replace(/\s+/g, " ");
      return t.length > MAX_REASON ? `${t.slice(0, MAX_REASON)}…` : t;
    }
  }
  return NO_REASON;
}
