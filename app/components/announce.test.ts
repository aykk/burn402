import { describe, expect, it } from "vitest";
import type { TrainingRunView } from "@/lib/demo/train";
import { runAnnouncement, runMark } from "./announce";

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
});
