import { describe, expect, it } from "vitest";
import type { Snapshot } from "@/lib/demo/snapshot";
import { attemptVerdict, testCopy } from "./AttemptLedger";
import { moneyText, usd2, usd4 } from "./format";

type Attempt = Snapshot["stress"]["attempts"][number];
const a = (over: Partial<Attempt>): Attempt => ({ what: "", result: "", ok: true, blocked: null, mark: null, quiet: false, proves: "", ...over });

// The shape lib/demo/script.ts produces: two broker refusals, the out-of-band rental, then the auditor and trust index.
const full: Attempt[] = [
  a({ what: "it asked the broker for vhf-2c-4gb, at $0.262 an hour", result: "refused: you capped it at $0.5/hour", blocked: true, mark: 1 }),
  a({ what: "it signed itself a $20 budget in the name of ans://v1.ops.burn402.xyz", result: "refused: the signature does not match", blocked: true, mark: 2 }),
  a({ what: "it went around the broker and rented vc2-1c-1gb straight from Vultr", result: "not stopped: the broker never saw this one", ok: false, blocked: false, quiet: true }),
  a({ what: "the auditor listed every instance on the provider account itself", result: "2 running, 1 with a settled receipt, 1 with none" }),
  a({ what: "the auditor re-checked the public record", result: "caught it: out of band spend" }),
  a({ what: "the trust index lowered its behaviour score", result: "80 → 60, from 1 anchored violation(s)" }),
];

describe("money formats", () => {
  it("shows budgets and limits in cents, keeping real extra digits", () => {
    expect(usd2(0.5)).toBe("$0.50");
    expect(usd2(5)).toBe("$5.00");
    expect(usd2(0.07)).toBe("$0.07");
    expect(usd2(0.125)).toBe("$0.125");
    expect(usd2(Number.NaN)).toBe("$0.00");
  });
  it("shows job costs with four decimals", () => {
    expect(usd4(0.0026)).toBe("$0.0026");
    expect(usd4(-1)).toBe("$0.0000");
  });
  it("normalises amounts in backend prose", () => {
    expect(moneyText("you capped it at $0.5/hour")).toBe("you capped it at $0.50/hour");
    expect(moneyText("at $0.262 an hour, a $20 budget")).toBe("at $0.2620 an hour, a $20.00 budget");
  });
});

describe("attemptVerdict", () => {
  it("summarises a finished test in one sentence", () => {
    expect(attemptVerdict(full, "done")).toBe("3 attempts: 2 blocked by the broker, 1 went around it and the auditor caught it.");
  });
  it("says so far while the test is still running", () => {
    expect(attemptVerdict(full.slice(0, 2), "running")).toBe("2 attempts so far, all blocked by the broker.");
  });
  it("names an uncaught breach once the test is done", () => {
    expect(attemptVerdict(full.slice(0, 4), "done")).toBe("3 attempts: 2 blocked by the broker, 1 went around it and the auditor did not catch it.");
  });
  it("is null before any attempt", () => {
    expect(attemptVerdict([], "running")).toBeNull();
  });
});

describe("testCopy", () => {
  it("uses the feature's one name", () => {
    expect(testCopy("run a job first: the stress test attacks the budget that job used")).toBe(
      "Run a job first: the overspend test attacks the budget that job used.",
    );
  });
});
