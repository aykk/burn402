import { describe, expect, it } from "vitest";
import type { TrainingRunView } from "@/lib/demo/train";
import { runAnnouncement, runMark } from "./announce";
import { failedWhere } from "./stages";

const job = (over: Partial<TrainingRunView>): TrainingRunView =>
  ({ id: "j1", phase: "negotiating", plan: null, paidUsd: null, actualSeconds: null, error: null, ...over }) as TrainingRunView;

describe("runAnnouncement", () => {
  it("treats the first snapshot after load as a baseline", () => {
    expect(runAnnouncement(undefined, job({ phase: "done" }))).toBeNull();
  });
  it("announces a new run and its stage", () => {
    expect(runAnnouncement(null, job({}))).toBe("Run started. Stage 1 of 4: Deal.");
  });
  it("stays quiet when nothing but the clock moved", () => {
    const j = job({ phase: "training", plan: "vc2", paidUsd: 0.01 });
    expect(runAnnouncement(runMark(j), j)).toBeNull();
  });
  it("announces the payment once, with the amount", () => {
    const before = job({ phase: "negotiating", plan: "vc2" });
    expect(runAnnouncement(runMark(before), job({ phase: "booting", plan: "vc2", paidUsd: 0.0123 }))).toBe(
      "Payment settled: $0.0123 USDC. Stage 3 of 4: Training.",
    );
  });
  it("announces done with time and amount", () => {
    const before = job({ phase: "publishing", plan: "vc2", paidUsd: 0.0123 });
    expect(runAnnouncement(runMark(before), job({ phase: "done", plan: "vc2", paidUsd: 0.0123, actualSeconds: 95 }))).toBe(
      "Run finished. Model trained in 1m 35s for $0.0123.",
    );
  });
  it("does not call a run that arrives already failed 'started'", () => {
    expect(runAnnouncement(null, job({ phase: "failed", error: "no quotes" }))).toBe("Run failed during deal. No quotes.");
  });
  it("announces failure with the stage and the error", () => {
    const before = job({});
    expect(runAnnouncement(runMark(before), job({ phase: "failed", error: "no quotes" }))).toBe("Run failed during deal. No quotes.");
  });
  it("does not call a failure while the server booted 'training'", () => {
    const before = job({ phase: "booting", plan: "vc2", paidUsd: 0.01 });
    const failed = job({ phase: "failed", plan: "vc2", paidUsd: 0.01, status: null, liveAt: null, error: "the box did not finish inside 25 minutes" });
    expect(runAnnouncement(runMark(before), failed)).toBe("Run failed while the server was booting. The box did not finish inside 25 minutes.");
  });
});

describe("failedWhere", () => {
  const paid = { phase: "failed" as const, plan: "vc2", paidUsd: 0.01 };
  const status = (over: Partial<NonNullable<TrainingRunView["status"]>>) =>
    ({ phase: "starting", progress: 0, configs_done: 0, ...over }) as NonNullable<TrainingRunView["status"]>;
  it("names the stage before the server was rented", () => {
    expect(failedWhere(job({ phase: "failed" }))).toBe("during deal");
    expect(failedWhere(job({ phase: "failed", plan: "vc2" }))).toBe("during payment");
  });
  it("says booting when the box never answered", () => {
    expect(failedWhere(job({ ...paid, status: null, liveAt: null }))).toBe("while the server was booting");
  });
  it("says before training when the box answered but never trained", () => {
    expect(failedWhere(job({ ...paid, status: status({ phase: "downloading" }), liveAt: 100 }))).toBe("before training started");
  });
  it("trusts an error that says training never started", () => {
    expect(failedWhere(job({ ...paid, status: status({ phase: "training" }), liveAt: 100, error: "stopped before training started" }))).toBe("before training started");
  });
  it("says training once the box reported it", () => {
    expect(failedWhere(job({ ...paid, status: status({ phase: "training", progress: 0.4 }), liveAt: 100 }))).toBe("during training");
  });
});
