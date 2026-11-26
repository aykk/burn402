import { describe, expect, it } from "vitest";
import { clusterOf, clusterForMarket, describePurchase, toTransactionRecord } from "./record";
import type { PurchaseRecord } from "./run";

const ctx = { subject: "ans://v1.0.0.ops.burn402.xyz", mandate: "hash123", mandateJti: "m_mkt_1" };
const base: PurchaseRecord = { at: 1_764_000_000_500, outcome: "accepted", reason: null, plan: "vc2-1c-1gb", region: "ewr", usd: 0.0108, tx: "5xTx", server: "ts-1" };

describe("toTransactionRecord", () => {
  it("maps an accepted purchase", () => {
    expect(toTransactionRecord(base, ctx)).toEqual({
      at: 1_764_000_000.5,
      subject: ctx.subject,
      mandate: "hash123",
      mandateJti: "m_mkt_1",
      plan: "vc2-1c-1gb",
      region: "ewr",
      outcome: "accepted",
      reason: null,
      usd: 0.0108,
      tx: "5xTx",
      server: "ts-1",
    });
  });

  it("carries the Solana cluster when the caller gives one, and leaves the field out otherwise", () => {
    expect(toTransactionRecord(base, { ...ctx, cluster: "devnet" }).cluster).toBe("devnet");
    expect(toTransactionRecord(base, { ...ctx, cluster: "mainnet" }).cluster).toBe("mainnet");
    expect("cluster" in toTransactionRecord(base, ctx)).toBe(false);
  });

  it("maps a market to its cluster, and reads only known clusters back from a stored record", () => {
    expect(clusterForMarket("test")).toBe("devnet");
    expect(clusterForMarket("real")).toBe("mainnet");
    expect(clusterOf("devnet")).toBe("devnet");
    expect(clusterOf("mainnet")).toBe("mainnet");
    expect(clusterOf("testnet")).toBeNull();
    expect(clusterOf(undefined)).toBeNull();
  });

  it("maps a guard refusal with its code and detail in reason", () => {
    const r = toTransactionRecord({ ...base, outcome: "refused", reason: "OVER_QUOTE: asked 0.02, approved 0.01", tx: null, server: null }, ctx);
    expect(r.outcome).toBe("refused");
    expect(r.reason).toBe("OVER_QUOTE: asked 0.02, approved 0.01");
    expect(r.tx).toBeNull();
    expect(r.mandateJti).toBe("m_mkt_1");
  });

  it("maps a failure", () => {
    const r = toTransactionRecord({ ...base, outcome: "failed", reason: "payment outcome unknown", server: null }, { ...ctx, mandate: null, mandateJti: null });
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("payment outcome unknown");
    expect(r.mandate).toBeNull();
  });

  it("keeps a run that ended before any quote readable", () => {
    const r = toTransactionRecord({ ...base, outcome: "failed", reason: "every source failed", plan: "", region: "", usd: null, tx: null, server: null }, ctx);
    expect(r.plan).toBe("none");
    expect(r.region).toBe("");
    expect(r.usd).toBeNull();
  });
});

describe("describePurchase", () => {
  const kept = "SELLER_KEPT_PAYMENT: The seller took one payment of $0.010382 and did not deliver a machine.";
  it("a payment the seller kept reads as paid with nothing delivered, with the amount", () => {
    expect(describePurchase({ outcome: "failed", plan: "vc2-1c-1gb", usd: 0.010382, tx: "t1", reason: kept })).toEqual({
      headline: "paid $0.010382 for a vc2-1c-1gb server and the seller kept it without delivering the server",
      label: "paid, nothing delivered",
      tone: "bad",
      reason: "The seller took one payment of $0.010382 and did not deliver a machine.",
    });
  });

  it("an unconfirmed payment says so", () => {
    const r = describePurchase({ outcome: "failed", plan: "vc2-1c-1gb", usd: 0.010382, tx: null, reason: "PAYMENT_UNCONFIRMED: A payment of $0.010382 was signed and sent." });
    expect(r).toMatchObject({ headline: "sent a payment of $0.010382 for a vc2-1c-1gb server that was never confirmed", label: "payment not confirmed", tone: "bad" });
  });

  it("an owner cancellation and stop read as the owner's choice (N12)", () => {
    expect(describePurchase({ outcome: "refused", plan: "vc2-1c-1gb", usd: null, tx: null, reason: "CANCELLED: You cancelled before paying. Nothing was spent." })).toEqual({
      headline: "asked for a vc2-1c-1gb server and you cancelled before paying",
      label: "cancelled by you",
      tone: "warn",
      reason: "You cancelled before paying. Nothing was spent.",
    });
    expect(describePurchase({ outcome: "refused", plan: "vc2-1c-1gb", usd: null, tx: null, reason: "STOPPED: You stopped the run before anything was paid." })).toMatchObject({
      label: "stopped by you",
      headline: "asked for a vc2-1c-1gb server and you stopped it before paying",
    });
  });

  it("a failure after a confirmed payment names the amount", () => {
    expect(describePurchase({ outcome: "failed", plan: "vc2-1c-1gb", usd: 0.010382, tx: "t1", reason: "The machine did not become active within 10 minutes" })).toMatchObject({
      headline: "paid $0.010382 for a vc2-1c-1gb server and it could not be started",
      label: "paid, could not be started",
      tone: "bad",
    });
  });

  it("leaves everything else to the existing wording", () => {
    expect(describePurchase({ outcome: "accepted", plan: "p", usd: 0.01, tx: "t", reason: null })).toBeNull();
    expect(describePurchase({ outcome: "refused", plan: "p", usd: null, tx: null, reason: "OVER_QUOTE: x" })).toBeNull();
    expect(describePurchase({ outcome: "failed", plan: "p", usd: null, tx: null, reason: "every source failed" })).toBeNull();
  });
});
