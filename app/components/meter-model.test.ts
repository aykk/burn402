import { describe, expect, it } from "vitest";
import type { PlanQuote } from "@/lib/train";
import { budgetShare, jobGauge, leadingZeros, meterView, shareText, type MeterJob } from "./meter-model";

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

describe("jobGauge", () => {
  const view = (over: Partial<MeterJob>, nowSec: number) => meterView({ ...base, job: job(over), nowSec });

  it("no gauge before there is a price", () => {
    expect(jobGauge(meterView({ ...base, job: null, nowSec: 5 }))).toBeNull();
    expect(jobGauge(view({ phase: "negotiating" }, 5))).toBeNull();
  });
  it("a quote fills the gauge and says how long it buys", () => {
    const g = jobGauge(view({ phase: "negotiating", chosen: q("vc2-2c-4gb", 0.036, 0.0026) }, 5));
    expect(g).toMatchObject({ state: "quoted", scaleUsd: 0.0026, leftUsd: 0.0026, fill: 1 });
    expect(g!.secondsLeft).toBeCloseTo(260, 6);
  });
  it("the paid amount drains to zero at the rented plan's rate", () => {
    const start = jobGauge(view(running, 1000))!;
    expect(start).toMatchObject({ state: "draining", scaleUsd: 0.0022, fill: 1 });
    expect(start.secondsLeft).toBeCloseTo((0.0022 / 0.027) * 3600, 6);
    const mid = jobGauge(view(running, 1160))!;
    expect(mid.leftUsd).toBeCloseTo(0.001, 6);
    expect(mid.fill).toBeCloseTo(0.001 / 0.0022, 6);
    expect(mid.secondsLeft).toBeCloseTo((0.001 / 0.027) * 3600, 6);
    const end = jobGauge(view(running, 1000 + 3600))!;
    expect(end).toMatchObject({ state: "draining", leftUsd: 0, fill: 0, secondsLeft: 0 });
  });
  it("done or failed after paying shows the server shut down, empty", () => {
    expect(jobGauge(view({ ...running, phase: "done", doneAt: 1100 }, 5000))).toMatchObject({
      state: "shut", scaleUsd: 0.0022, leftUsd: 0, fill: 0, secondsLeft: 0,
    });
    expect(jobGauge(view({ ...running, phase: "failed", error: "x" }, 1100))).toMatchObject({ state: "shut", fill: 0 });
  });
  it("a failed run that never paid has no job gauge", () => {
    expect(jobGauge(view({ phase: "failed", chosen: q("a", 0.03, 0.002), error: "x" }, 5))).toBeNull();
  });
  it("unknown rate leaves the time out, never NaN", () => {
    const g = jobGauge(view({ ...running, quotes: [], chosen: null }, 1160))!;
    expect(g.state).toBe("draining");
    expect(g.fill).toBe(1);
    expect(g.secondsLeft).toBeNull();
  });
});

describe("meterView server time", () => {
  it("ranSeconds is paidAt to doneAt, only once done", () => {
    expect(meterView({ ...base, job: job(running), nowSec: 1160 }).ranSeconds).toBeNull();
    expect(meterView({ ...base, job: job({ ...running, phase: "done", doneAt: 1190 }), nowSec: 5000 }).ranSeconds).toBe(190);
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
