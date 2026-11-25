import { describe, expect, it } from "vitest";
import { toTransactionRecord } from "./record";
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
