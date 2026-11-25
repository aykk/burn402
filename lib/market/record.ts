import type { TransactionRecord } from "../x402";
import type { PurchaseRecord } from "./run";

/**
 * A purchase decision in the shape the gate's TRANSACTION events use, so it is stored,
 * anchored and listed the same way. `at` goes from ms to seconds; an empty plan (the run
 * ended before any quote) becomes "none" because an Arweave tag value cannot be empty.
 */
export function toTransactionRecord(r: PurchaseRecord, ctx: { subject: string; mandate: string | null; mandateJti: string | null }): TransactionRecord {
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
  };
}
