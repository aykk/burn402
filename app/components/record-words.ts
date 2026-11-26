import { describePurchase } from "../../lib/market/record";
import { sellerReason, tokenName, usdExact } from "../../lib/market/money";
import { colonCase } from "./market-copy";

/**
 * Plain words for transaction records on /records. Records are stored as they were written, so older ones
 * carry codes, atomic units and raw seller JSON; they are reworded here, when the page reads them, never
 * changed where they are stored.
 */

export type Outcome = { label: string; tone: "good" | "bad" | "warn" };
export type RecordWords = Outcome & { headline: string; reason: string | null };

type Facts = { outcome: string | null; plan: string | null; usd: number | null | undefined; tx: string | null | undefined; reason: string | null | undefined };

export function transactionOutcome(outcome: string | null): Outcome {
  if (outcome === "accepted") return { label: "allowed and paid", tone: "good" };
  if (outcome === "refused") return { label: "refused by your agent", tone: "warn" };
  if (outcome === "payment rejected") return { label: "payment rejected", tone: "bad" };
  if (outcome === "failed") return { label: "could not be started", tone: "bad" };
  return { label: outcome ? outcome.replace(/_/g, " ").toLowerCase() : "outcome not on record", tone: "warn" };
}

/** Counts of left-out plans in older "No plan fits" reasons, by code. The need's kind is not on record. */
const COUNT_WORDS: Record<string, string> = {
  OVER_RATE: "over your hourly limit",
  OVER_BUDGET: "over your budget",
  TOO_SMALL: "too small",
  WRONG_KIND: "not the kind of machine you asked for",
  OUT_OF_STOCK: "out of stock",
  NO_REGION: "not in your regions",
  SPOT_NOT_ALLOWED: "interruptible",
  NOT_RENTABLE: "not for rent by an agent",
};

/** What an older quote or payment code meant, as the middle of a sentence. */
const CODE_WORDS: Record<string, string> = {
  WRONG_ASSET: "the seller asked to be paid in a different token",
  WRONG_NETWORK: "the seller asked to be paid on a different network",
  OVER_QUOTE: "the seller raised the price after quoting",
  OVER_RATE: "the quote was over your hourly limit",
  OVER_BUDGET: "the quote was over your budget",
  PRICE_CAP: "the quote was over your budget",
  OUT_OF_STOCK: "the plan was out of stock",
  SELLER_ERROR: "the seller answered with an error",
  UNREACHABLE: "the seller did not answer",
  NO_402: "the seller gave no price",
  ALREADY_PAID: "this run had already paid once",
  PAYMENT_REJECTED: "the seller rejected the payment",
  REFUSED_BY_GUARD: "your agent refused the payment",
};

/** A paid USDC amount stored as dollars, exactly as the chain moved it: 0.010382 is "$0.010382", 0.011 is "$0.0110". */
export function usdPaid(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "an unreadable amount";
  return usdExact(String(Math.round(usd * 1e6)));
}

const NO_WORDS = "The record gives no reason in words.";
const CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const LEAD_CODE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*):\s*([\s\S]*)$/;
const BASE58 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

const sentenceCase = (t: string) => {
  const s = t.trim();
  const up = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
};


/** The broker-era reasons, as the page has always worded them. Null when the reason is not one of them. */
function brokerReason(reason: string): string | null {
  const rate = /plan ([\d.]+)\/hr > mandate rate ([\d.]+)\/hr/.exec(reason);
  if (rate) return `the server costs $${rate[1]} an hour and the budget allowed $${rate[2]}`;
  if (/UNKNOWN_KEY|SIGNATURE_INVALID/.test(reason)) return "the budget was signed by a key that does not belong to the agent named on it";
  if (/BUDGET_EXCEEDED/.test(reason)) return "the budget had no money left in it";
  if (/WINDOW_EXPIRED/.test(reason)) return "the budget had already expired";
  if (/SCOPE_ESCALATION/.test(reason)) return "the budget does not cover renting servers";
  if (/IDENTITY_UNANCHORED/.test(reason)) return "the agent is not registered in ANS";
  if (/DEPTH_EXCEEDED/.test(reason)) return "the budget had been passed on more times than it allows";
  if (/PLAN_UNKNOWN/.test(reason)) return "there is no such plan at the provider";
  if (/PLAN_UNAVAILABLE/.test(reason)) return "that plan is not available in this region";
  if (/Cannot add instance|out of stock|capacity/i.test(reason)) return "the provider had none of that plan left to give";
  if (/PROVIDER_ERROR/.test(reason)) return `the provider refused to start it: ${reason.replace(/^.*HTTP \d+: /, "").slice(0, 120)}`;
  return null;
}

/** One coded quote problem ("WRONG_ASSET: Seller asked for So11…, not USDC on Solana devnet") in words. */
function codedProblem(code: string, detail: string): string {
  const asset = /^Seller asked for (\S+?),? not (\S+) on (.+?)\.?$/.exec(detail.trim());
  if (code === "WRONG_ASSET" && asset) return `the seller asked to be paid in ${tokenName(asset[1])} instead of ${asset[2]} on ${asset[3]}`;
  return CODE_WORDS[code] ?? detail;
}

/** A stored reason in plain words: exact dollars, no codes, no raw JSON. Null when there is none. */
export function plainReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string" || !reason.trim()) return null;
  let t = reason.trim();

  const broker = brokerReason(t);
  if (broker) return sentenceCase(broker);

  // A leading code ("OVER_QUOTE: ...") only says which kind of reason follows.
  const lead = LEAD_CODE.exec(t);
  if (lead) t = lead[2].trim() || CODE_WORDS[lead[1]] || "";

  const fits = /^No plan fits the need inside the limits \((.*)\)\.?$/.exec(t);
  if (fits) {
    const parts = fits[1].split(/,\s*/).map((p) => {
      const m = /^(\d+) ([A-Z_]+)$/.exec(p.trim());
      return m ? `${m[1]} ${COUNT_WORDS[m[2]] ?? "left out for another reason"}` : p;
    });
    t = `No plan fits what you asked for inside your limits: ${parts.join(", ")}`;
  }

  const quote = /^No usable quote: (?:([A-Z][A-Z_]+): )?(.*)$/.exec(t);
  if (quote) t = `No seller gave a usable quote. The last problem: ${quote[1] ? codedProblem(quote[1], quote[2]) : quote[2]}`;

  t = t.replace(/^(?:The )?[Ss]eller now asks (\d+) atomic units, above the approved (\d+)/, (_, a: string, b: string) => `The seller now asks ${usdExact(a)}, more than the ${usdExact(b)} you approved`);
  t = t.replace(/(\d+) atomic units/g, (_, a: string) => usdExact(a));
  t = t.replace(/^The owner cancelled([^;]*); nothing was signed/, "You cancelled$1. Nothing was signed");
  t = t.replace(/\bthe owner\b/gi, (m) => (m[0] === "T" ? "You" : "you"));

  // Raw seller JSON becomes the seller's own short message.
  t = t.replace(/\s*\{.*\}/g, (json) => {
    const said = sellerReason(json.trim());
    return said === "the seller gave no reason" ? "" : ` "${said}"`;
  });
  // Known token addresses by name; any other long address shortened.
  t = t.replace(BASE58, (a) => {
    const name = tokenName(a);
    return name === "SOL" || name === "USDC" ? name : `${a.slice(0, 4)}…${a.slice(-4)}`;
  });

  t = colonCase(t).trim().replace(/:$/, "");
  if (!t || CODE.test(t)) return NO_WORDS;
  return sentenceCase(t);
}

/** "a vc2-1c-1gb server", or "a server" when no plan was chosen (stored as "none"). */
const serverOf = (plan: string | null) => (plan && plan !== "none" ? `a ${plan} server` : "a server");

/** A seller's rejection of a payment the agent had sent, as older records wrote it: "<seller> rejected the payment: {json}". */
function rejectedPayment(reason: string | null | undefined): { seller: string; said: string; quote: string | null } | null {
  const text = typeof reason === "string" ? reason.trim().replace(LEAD_CODE, "$2") : "";
  const m = /^(.*?) rejected the payment: ([\s\S]*)$/.exec(text);
  if (!m) return null;
  let quote: string | null = null;
  try {
    const body = JSON.parse(m[2]) as { quote_usd?: unknown };
    if (typeof body.quote_usd === "number" && Number.isFinite(body.quote_usd)) quote = usdPaid(body.quote_usd);
  } catch {
    // not JSON: the seller's words are used as they are
  }
  const said = /^\s*\{/.test(m[2]) ? sellerReason(m[2]) : m[2].trim();
  return { seller: m[1].trim() || "The seller", said, quote };
}

/** Headline, outcome and reason for one transaction record. */
export function recordWords(t: Facts): RecordWords {
  const server = serverOf(t.plan);
  const amount = typeof t.usd === "number" && Number.isFinite(t.usd) ? usdPaid(t.usd) : null;

  // The market's own wording for a kept or unconfirmed payment, a paid failure, and the owner's cancel or stop.
  const market = describePurchase({ outcome: t.outcome, plan: t.plan, usd: t.usd, tx: t.tx, reason: t.reason });
  if (market) {
    const kept = market.label === "paid, nothing delivered";
    return {
      headline: kept ? `paid ${amount ?? "money"}; the seller kept it and delivered nothing` : market.headline,
      label: market.label,
      tone: market.tone,
      reason: plainReason(market.reason),
    };
  }

  const rejected = t.outcome === "failed" ? rejectedPayment(t.reason) : null;
  if (rejected) {
    const said = rejected.said === "the seller gave no reason" ? "gave no reason" : `answered "${rejected.said}"`;
    const quote = rejected.quote ? ` The quote was ${rejected.quote}.` : "";
    return {
      headline: `sent a payment for ${server} and the seller rejected it`,
      label: "payment rejected by the seller",
      tone: "bad",
      reason: `${rejected.seller} rejected the payment and ${said}.${quote} This record does not say whether the money moved; check the payer's wallet.`,
    };
  }

  const reason = plainReason(t.reason);
  const outcome = transactionOutcome(t.outcome);
  let headline: string;
  if (t.outcome === "accepted") headline = `paid ${amount ? `${amount} USDC ` : ""}for ${server}`;
  else if (t.outcome === "refused") headline = /^No plan fits/i.test(reason ?? "") && server === "a server" ? "asked for a server and no plan fit your limits" : `asked for ${server} and was refused`;
  else if (t.outcome === "payment rejected") headline = `tried to pay for ${server} and the payment was rejected`;
  else if (t.outcome === "failed") headline = /usable quote/i.test(reason ?? "") && server === "a server" ? "asked for a server and no seller gave a usable quote" : `asked for ${server} and it could not be started`;
  else headline = `asked for ${server}`;
  return { headline, ...outcome, reason };
}
