import type { TransactionRecord } from "../x402";
import { usdPlain } from "./money";
import type { PurchaseRecord } from "./run";
import type { MarketId } from "./types";

export type Cluster = "devnet" | "mainnet";

export const clusterForMarket = (m: MarketId): Cluster => (m === "real" ? "mainnet" : "devnet");

/** A cluster read back from a stored record: only the two known values, else null (older records carry none). */
export const clusterOf = (v: unknown): Cluster | null => (v === "devnet" || v === "mainnet" ? v : null);

/**
 * A purchase decision in the shape the gate's TRANSACTION events use, so it is stored,
 * anchored and listed the same way. `at` goes from ms to seconds; an empty plan (the run
 * ended before any quote) becomes "none" because an Arweave tag value cannot be empty.
 */
export function toTransactionRecord(r: PurchaseRecord, ctx: { subject: string; mandate: string | null; mandateJti: string | null; cluster?: Cluster }): TransactionRecord {
  return {
    at: r.at / 1000,
    subject: ctx.subject,
    mandate: ctx.mandate,
    mandateJti: ctx.mandateJti,
    plan: r.plan || "none",
    region: r.region,
    outcome: r.outcome,
    reason: r.reason,
    usd: r.usd,
    tx: r.tx,
    server: r.server,
    ...(ctx.cluster ? { cluster: ctx.cluster } : {}),
  };
}

/** The reason codes a market run puts in front of a record's reason, for the records page. */
export const RECORD_CODES = { kept: "SELLER_KEPT_PAYMENT", unconfirmed: "PAYMENT_UNCONFIRMED", cancelled: "CANCELLED", stopped: "STOPPED" } as const;

export type PurchaseWords = { headline: string; label: string; tone: "good" | "bad" | "warn"; reason: string | null };

/**
 * Words for a market purchase record where the generic wording would be wrong: a payment the seller
 * kept, one never confirmed, a paid failure, and the owner's own cancel or stop. Null for the rest.
 */
export function describePurchase(t: { outcome: string | null; plan: string | null; usd: number | null | undefined; tx: string | null | undefined; reason: string | null | undefined }): PurchaseWords | null {
  const server = t.plan && t.plan !== "none" ? `a ${t.plan} server` : "a server";
  const code = t.reason ? /^([A-Z_]+): /.exec(t.reason)?.[1] : undefined;
  const reason = t.reason ? t.reason.replace(/^[A-Z_]+: /, "") : null;
  const amount = typeof t.usd === "number" && Number.isFinite(t.usd) ? usdPlain(t.usd) : null;
  if (t.outcome === "refused" && code === RECORD_CODES.cancelled) {
    return { headline: `asked for ${server} and you cancelled before paying`, label: "cancelled by you", tone: "warn", reason };
  }
  if (t.outcome === "refused" && code === RECORD_CODES.stopped) {
    return { headline: `asked for ${server} and you stopped it before paying`, label: "stopped by you", tone: "warn", reason };
  }
  if (t.outcome !== "failed") return null;
  if (code === RECORD_CODES.kept) {
    return { headline: `paid ${amount ?? "money"} for ${server} and the seller kept it without delivering the server`, label: "paid, nothing delivered", tone: "bad", reason };
  }
  if (code === RECORD_CODES.unconfirmed) {
    return { headline: `sent a payment of ${amount ?? "an unknown amount"} for ${server} that was never confirmed`, label: "payment not confirmed", tone: "bad", reason };
  }
  if (t.tx && amount) return { headline: `paid ${amount} for ${server} and it could not be started`, label: "paid, could not be started", tone: "bad", reason };
  return null;
}
