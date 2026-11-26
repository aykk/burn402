import { describe, expect, it } from "vitest";
import { attemptOutcome, type Attempt } from "./AttemptLedger";
import { moneyText, usd2, usd4 } from "./format";

const a = (over: Partial<Attempt>): Attempt => ({ what: "", result: "", ok: true, blocked: null, mark: null, quiet: false, proves: "", ...over });

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

describe("attemptOutcome", () => {
  it("reads a refusal as Blocked, in ink", () => {
    expect(attemptOutcome(a({ result: "refused: you capped it at $0.05/hour", blocked: true }), true)).toEqual({ word: "Blocked", reason: "You capped it at $0.05 an hour.", color: "var(--foreground)" });
  });
  it("reads an attempt that got through as Got through, in red", () => {
    expect(attemptOutcome(a({ result: "not stopped: the seller kept it", blocked: false }), true)).toEqual({ word: "Got through", reason: "The seller kept it.", color: "var(--bad)" });
  });
});
