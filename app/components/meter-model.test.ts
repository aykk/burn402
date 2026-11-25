import { describe, expect, it } from "vitest";
import { allowanceWords, budgetShare, draftLimits, jobGauge, leadingZeros, meterView, shareText, walletReadout, type MeterJob } from "./meter-model";

const HOUR = 3_600_000;

const approval = {
  code: "c0de", usd: 0.01, atomic: "10000", exact: "$0.0100", surcharge: null, token: "USDC" as const, network: "Solana devnet",
  payTo: "ELT2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad5Ux", plan: "vc2-1c-1gb", region: "ewr", hours: 1, seller: "testseller",
};

function job(over: Partial<MeterJob>): MeterJob {
  return {
    phase: "scanning",
    limits: { budgetUsd: 1, rateUsdHr: 0.05 },
    need: { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false },
    approval: null, payment: null, machine: null, paidAt: null, releasedAt: null, error: null, refusal: null, spent: "nothing",
    ...over,
  };
}

const T0 = 1_795_000_000_000;
const paid = { approval, payment: { usd: 0.01, atomic: "10000", tx: "5xTx", at: T0, payer: "3Ybt", status: "confirmed" as const }, paidAt: T0, spent: "paid" as const };
const base = { formBudgetUsd: 1, formRateUsdHr: 0.05 };

describe("meterView", () => {
  it("ready with no run shows the form's budget and limit", () => {
    expect(meterView({ formBudgetUsd: 2, formRateUsdHr: 0.1, job: null, nowMs: T0 })).toMatchObject({
      phase: "ready", budgetUsd: 2, rateUsdHr: 0.1, remainingUsd: 2, quotedUsd: null, paidUsd: null, usedUsd: null,
    });
  });
  it("scanning shows the run's limits and no amount yet", () => {
    const v = meterView({ ...base, formBudgetUsd: 9, job: job({ phase: "quoting" }), nowMs: T0 });
    expect(v).toMatchObject({ phase: "searching", budgetUsd: 1, rateUsdHr: 0.05, remainingUsd: 1, quotedUsd: null });
  });
  it("approval carries the firm quote, not paid", () => {
    const v = meterView({ ...base, job: job({ phase: "approval", approval }), nowMs: T0 });
    expect(v).toMatchObject({ phase: "approval", quotedUsd: 0.01, quotedHours: 1, paidUsd: null, remainingUsd: 1 });
  });
  it("paid drains over the hours asked for: half the time, half used", () => {
    const v = meterView({ ...base, job: job({ ...paid, phase: "ready" }), nowMs: T0 + HOUR / 2 });
    expect(v.phase).toBe("running");
    expect(v.paidUsd).toBe(0.01);
    expect(v.remainingUsd).toBeCloseTo(0.99, 9);
    expect(v.usedUsd).toBeCloseTo(0.005, 9);
    expect(v.secondsLeft).toBeCloseTo(1800, 6);
  });
  it("the drain is capped at what was paid", () => {
    const v = meterView({ ...base, job: job({ ...paid, phase: "ready" }), nowMs: T0 + 3 * HOUR });
    expect(v.usedUsd).toBeCloseTo(0.01, 9);
    expect(v.secondsLeft).toBe(0);
  });
  it("an earlier destroy time (the paid expiry) shortens the drain", () => {
    const machine = { id: "m", ip: "203.0.113.1", status: "active", expiresAt: T0 + HOUR / 2, destroyAt: T0 + HOUR / 2, ssh: null, port22: "not checked" as const, plan: "p", region: "ewr" };
    const v = meterView({ ...base, job: job({ ...paid, phase: "ready", machine }), nowMs: T0 + HOUR / 4 });
    expect(v.usedUsd).toBeCloseTo(0.005, 9);
  });
  it("paying with the payment already reported counts as running", () => {
    expect(meterView({ ...base, job: job({ ...paid, phase: "paying" }), nowMs: T0 }).phase).toBe("running");
    expect(meterView({ ...base, job: job({ phase: "paying", approval }), nowMs: T0 }).phase).toBe("paying");
  });
  it("released freezes at the release time and reports how long it ran", () => {
    const v = meterView({ ...base, job: job({ ...paid, phase: "released", releasedAt: T0 + 600_000 }), nowMs: T0 + 5 * HOUR });
    expect(v.phase).toBe("released");
    expect(v.usedUsd).toBeCloseTo(0.01 / 6, 9);
    expect(v.ranSeconds).toBe(600);
    expect(v.remainingUsd).toBeCloseTo(0.99, 9);
  });
  it("refused before paying keeps the whole budget and no quote", () => {
    const v = meterView({ ...base, job: job({ phase: "refused", approval, refusal: { code: "CANCELLED", detail: "x" } }), nowMs: T0 });
    expect(v).toMatchObject({ phase: "refused", remainingUsd: 1, paidUsd: null, usedUsd: null });
    expect(jobGauge(v)).toBeNull();
  });
  it("failed carries the error", () => {
    const v = meterView({ ...base, job: job({ phase: "failed", error: "No usable quote" }), nowMs: T0 });
    expect(v).toMatchObject({ phase: "failed", error: "No usable quote", remainingUsd: 1 });
  });
  it("no NaN when paidAt is missing: falls back to the payment time", () => {
    const v = meterView({ ...base, job: job({ ...paid, paidAt: null, phase: "ready" }), nowMs: T0 + HOUR / 2 });
    expect(v.usedUsd).toBeCloseTo(0.005, 9);
  });
});

describe("jobGauge", () => {
  const view = (over: Partial<MeterJob>, nowMs: number) => meterView({ ...base, job: job(over), nowMs });

  it("no gauge before there is a quote", () => {
    expect(jobGauge(meterView({ ...base, job: null, nowMs: T0 }))).toBeNull();
    expect(jobGauge(view({ phase: "scanning" }, T0))).toBeNull();
  });
  it("a quote fills the gauge and says how long it buys", () => {
    expect(jobGauge(view({ phase: "approval", approval }, T0))).toMatchObject({ state: "quoted", scaleUsd: 0.01, leftUsd: 0.01, fill: 1, secondsLeft: 3600 });
  });
  it("the paid amount drains to zero over the rented time", () => {
    const mid = jobGauge(view({ ...paid, phase: "ready" }, T0 + HOUR / 2))!;
    expect(mid.state).toBe("draining");
    expect(mid.leftUsd).toBeCloseTo(0.005, 9);
    expect(mid.fill).toBeCloseTo(0.5, 9);
    const end = jobGauge(view({ ...paid, phase: "ready" }, T0 + HOUR))!;
    expect(end).toMatchObject({ leftUsd: 0, fill: 0, secondsLeft: 0 });
  });
  it("released, or failed after the machine was destroyed, shows the machine gone, empty", () => {
    const machine = { id: "m", ip: null, status: "destroyed", expiresAt: null, destroyAt: null, ssh: null, port22: "not checked" as const, plan: "p", region: "ewr" };
    expect(jobGauge(view({ ...paid, phase: "released", releasedAt: T0 + 1000, machine }, T0 + HOUR))).toMatchObject({ state: "shut", scaleUsd: 0.01, leftUsd: 0, fill: 0 });
    expect(jobGauge(view({ ...paid, phase: "failed", error: "x", machine }, T0 + 1000))).toMatchObject({ state: "shut", fill: 0 });
  });
  it("failed after paying with a machine still known is held, not shut: it may still be running", () => {
    const machine = { id: "m", ip: null, status: "pending", expiresAt: null, destroyAt: null, ssh: null, port22: "not checked" as const, plan: "p", region: "ewr" };
    const v = view({ ...paid, phase: "failed", error: "did not become active", machine }, T0 + HOUR / 2);
    expect(v.machineMayRun).toBe(true);
    const g = jobGauge(v)!;
    expect(g.state).toBe("held");
    expect(g.scaleUsd).toBe(0.01);
    expect(g.leftUsd).toBeCloseTo(0.005, 9);
    expect(view({ ...paid, phase: "released", releasedAt: T0 + 1000, machine }, T0 + HOUR).machineMayRun).toBe(false);
  });
});

describe("B1: money after a signed payment", () => {
  const kept = { usd: 0.010382, atomic: "10382", tx: "4uwC", at: T0, payer: "3Ybt", status: "confirmed" as const };
  const ended = (over: Partial<MeterJob>) => meterView({ ...base, job: job({ phase: "failed", approval, error: "x", ...over }), nowMs: T0 + 5000 });

  it("a payment the seller kept, no machine: the meter shows it spent, the budget less the amount, no machine gauge", () => {
    const v = ended({ spent: "paid", payment: kept });
    expect(v.remainingUsd).toBeCloseTo(1 - 0.010382, 9);
    expect(jobGauge(v)).toBeNull();
    expect(walletReadout(v)).toEqual({ label: "Spent", value: "$0.010382" });
  });
  it("an unconfirmed payment: sent and not confirmed, the exact amount, never nothing spent", () => {
    const v = ended({ spent: "maybe", payment: { ...kept, status: "unconfirmed" } });
    expect(v.remainingUsd).toBeCloseTo(1 - 0.010382, 9);
    expect(jobGauge(v)).toBeNull();
    expect(walletReadout(v)).toEqual({ label: "Sent, not confirmed", value: "$0.010382" });
  });
  it("nothing spent only when spent is nothing", () => {
    const v = ended({ spent: "nothing" });
    expect(v.remainingUsd).toBe(1);
    expect(walletReadout(v)).toEqual({ label: "Nothing spent", value: "$0.00" });
  });
  it("a payment sent but not yet confirmed, with no machine, is not machine time draining", () => {
    const v = meterView({ ...base, job: job({ phase: "paying", approval, spent: "maybe", payment: { ...kept, status: "unconfirmed" } }), nowMs: T0 + 5000 });
    expect(v.phase).toBe("paying");
    expect(jobGauge(v)).toMatchObject({ state: "sent", scaleUsd: 0.010382, fill: 1, secondsLeft: null });
  });
});

describe("allowance and draft", () => {
  it("S4: at the approval stop the allowance is what would be left after paying", () => {
    expect(allowanceWords("quoted")).toEqual({ verb: "would have", tail: "left after paying" });
    expect(allowanceWords("draining")).toEqual({ verb: "has", tail: "left" });
    expect(allowanceWords(null)).toEqual({ verb: "has", tail: "left" });
  });
  it("N2: only a valid budget and limit reach the meter", () => {
    expect(draftLimits(1, 0.05)).toEqual({ budgetUsd: 1, rateUsdHr: 0.05 });
    expect(draftLimits(99999999, 0.05)).toBeNull();
    expect(draftLimits(1, 5)).toBeNull();
    expect(draftLimits(Number.NaN, 0.05)).toBeNull();
    expect(draftLimits(0.001, 0.001)).toBeNull();
    expect(draftLimits(20, 20)).toEqual({ budgetUsd: 20, rateUsdHr: 20 });
  });
});

describe("share and digits", () => {
  it("budgetShare is a clamped fraction", () => {
    expect(budgetShare(0.0026, 5)).toBeCloseTo(0.00052, 9);
    expect(budgetShare(9, 5)).toBe(1);
    expect(budgetShare(1, 0)).toBe(0);
    expect(budgetShare(Number.NaN, 5)).toBe(0);
  });
  it("shareText keeps tiny shares honest", () => {
    expect(shareText(0)).toBe("0%");
    expect(shareText(0.00000052)).toBe("under 0.01%");
    expect(shareText(0.00052)).toBe("0.05%");
    expect(shareText(0.025)).toBe("2.5%");
    expect(shareText(0.374)).toBe("37%");
    expect(shareText(1)).toBe("100%");
  });
  it("leadingZeros splits off the digits that carry no value", () => {
    expect(leadingZeros("$0.0012")).toEqual(["$0.00", "12"]);
    expect(leadingZeros("$0.0000")).toEqual(["$0.0000", ""]);
    expect(leadingZeros("$0.5000")).toEqual(["$0.", "5000"]);
    expect(leadingZeros("$1.2500")).toEqual(["$", "1.2500"]);
  });
});
