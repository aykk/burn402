import { describe, expect, it } from "vitest";
import type { PlanQuote } from "@/lib/train";
import { meterView, type MeterJob } from "./meter-model";

function q(plan: string, hourlyUsd: number, jobUsd: number): PlanQuote {
  return {
    plan, family: "vc2", familyLabel: "regular", vcpus: 2, ramGb: 4, hourlyUsd,
    coreSpeed: 0.36, workers: 1, ramNeededGb: 1, trainSeconds: 100, totalSeconds: 200,
    jobUsd, budgetHours: 10, withinRate: true, withinBudget: true, withinDeadline: true, enoughRam: true,
  };
}

function job(over: Partial<MeterJob>): MeterJob {
  return {
    phase: "training", budgetUsd: 1, rateUsdHr: 1, quotes: [], chosen: null, plan: null,
    paidUsd: null, paidAt: null, doneAt: null, error: null, ...over,
  };
}

const base = { formBudgetUsd: 1, formRateUsdHr: 1 };
const rented = [q("vc2-1c-1gb", 0.007, 0.0006), q("vc2-2c-4gb", 0.027, 0.0022)];
const running = { plan: "vc2-2c-4gb", quotes: rented, paidUsd: 0.0022, paidAt: 1000 };

describe("meterView", () => {
  it("ready with no job", () => {
    expect(meterView({ ...base, job: null, nowSec: 5 })).toMatchObject({
      phase: "ready", budgetUsd: 1, remainingUsd: 1, quotedUsd: null, burnedUsd: null,
    });
  });
  it("negotiating before a quote", () => {
    const v = meterView({ ...base, job: job({ phase: "negotiating" }), nowSec: 5 });
    expect(v).toMatchObject({ phase: "negotiating", remainingUsd: 1, quotedUsd: null });
  });
  it("negotiating with a quote", () => {
    const v = meterView({ ...base, job: job({ phase: "negotiating", chosen: q("vc2-2c-4gb", 0.027, 0.0022) }), nowSec: 5 });
    expect(v.quotedUsd).toBe(0.0022);
  });
  it("running drains at the rented plan's rate", () => {
    const v = meterView({ ...base, job: job(running), nowSec: 1160 });
    expect(v.phase).toBe("running");
    expect(v.remainingUsd).toBeCloseTo(0.9978, 6);
    expect(v.burnedUsd).toBeCloseTo(0.0012, 6);
  });
  it("drain is capped at what was paid", () => {
    const v = meterView({ ...base, job: job(running), nowSec: 1000 + 3600 });
    expect(v.burnedUsd).toBeCloseTo(0.0022, 6);
  });
  it("rented plan missing from quotes falls back to chosen", () => {
    const v = meterView({
      ...base,
      job: job({ ...running, plan: "vc2-4c-8gb", quotes: [q("vc2-1c-1gb", 0.007, 0.0006)], chosen: q("vc2-2c-4gb", 0.027, 0.0022) }),
      nowSec: 1160,
    });
    expect(v.quotedUsd).toBe(0.0022);
    expect(v.burnedUsd).toBeCloseTo(0.0012, 6);
  });
  it("failed during negotiation shows the error and no amber", () => {
    const error = "your agent finished without renting a server";
    const v = meterView({ ...base, job: job({ phase: "failed", error }), nowSec: 50 });
    expect(v).toMatchObject({ phase: "failed", remainingUsd: 1, quotedUsd: null, burnedUsd: null, error });
  });
  it("done freezes at doneAt", () => {
    const v = meterView({ ...base, job: job({ ...running, phase: "done", doneAt: 1100 }), nowSec: 5000 });
    expect(v.phase).toBe("done");
    expect(v.burnedUsd).toBeCloseTo(0.00075, 6);
  });
  it("no NaN when paidAt is missing", () => {
    const v = meterView({ ...base, job: job({ ...running, paidAt: null }), nowSec: 1160 });
    expect(v.burnedUsd).toBe(0);
  });
});
