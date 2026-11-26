import { describe, expect, it } from "vitest";
import type { MarketRunView } from "@/lib/market/run";
import { marketAnnouncement, marketMark } from "./announce";

const run = (over: Partial<MarketRunView>): MarketRunView =>
  ({ id: "mkt_1", market: "test", phase: "scanning", rows: [], leftOut: [], approval: null, payment: null, machine: null, error: null, refusal: null, spent: "nothing", ...over }) as MarketRunView;

const approval = { code: "c", usd: 0.01, atomic: "10000", exact: "$0.0100", surcharge: null, token: "USDC" as const, network: "Solana devnet", payTo: "ELT2xxxxxxxxd5Ux", plan: "vc2-1c-1gb", region: "ewr", hours: 1, seller: "t" };
const payment = { usd: 0.0104, atomic: "10400", tx: "tx", at: 1, payer: "p", status: "confirmed" as const };
const machine = { id: "m", ip: "203.0.113.1", status: "active", expiresAt: null, destroyAt: null, ssh: null, port22: "not checked" as const, plan: "vc2-1c-1gb", region: "ewr" };

describe("marketAnnouncement", () => {
  it("treats the first snapshot after load as a baseline", () => {
    expect(marketAnnouncement(undefined, run({ phase: "released" }))).toBeNull();
  });
  it("announces a new run and its stage", () => {
    expect(marketAnnouncement(null, run({}))).toBe("Run started. Stage 1 of 4: Scan.");
  });
  it("stays quiet when nothing but the clock moved", () => {
    const r = run({ phase: "ready", payment, machine });
    expect(marketAnnouncement(marketMark(r), r)).toBeNull();
  });
  it("announces the approval stop with what will be paid", () => {
    const before = run({ phase: "quoting" });
    expect(marketAnnouncement(marketMark(before), run({ phase: "approval", approval }))).toBe(
      "Stage 3 of 4: Pay. Waiting for your approval to pay $0.0100 USDC for vc2-1c-1gb.",
    );
  });
  it("announces the payment once, with the amount", () => {
    const before = run({ phase: "paying", approval });
    expect(marketAnnouncement(marketMark(before), run({ phase: "provisioning", approval, payment }))).toBe(
      "Payment sent: $0.0104 USDC. Stage 4 of 4: Machine.",
    );
  });
  it("announces the machine ready and destroyed", () => {
    const before = run({ phase: "provisioning", payment, machine });
    expect(marketAnnouncement(marketMark(before), run({ phase: "ready", payment, machine }))).toBe("Machine ready at 203.0.113.1.");
    const ready = run({ phase: "ready", payment, machine });
    expect(marketAnnouncement(marketMark(ready), run({ phase: "released", payment, spent: "paid", machine }))).toBe("Machine destroyed. Spent $0.0104.");
  });
  it("amounts are exact, and an unconfirmed payment is never announced as spent", () => {
    const exact = { ...approval, usd: 0.010382, atomic: "10382", exact: "$0.010382" };
    const sent = { usd: 0.010382, atomic: "10382", tx: null, at: 1, payer: "p", status: "unconfirmed" as const };
    expect(marketAnnouncement(marketMark(run({ phase: "quoting" })), run({ phase: "approval", approval: exact }))).toBe(
      "Stage 3 of 4: Pay. Waiting for your approval to pay $0.010382 USDC for vc2-1c-1gb.",
    );
    expect(marketAnnouncement(marketMark(run({ phase: "paying", approval: exact })), run({ phase: "paying", approval: exact, payment: sent, spent: "maybe" }))).toBe(
      "Payment sent: $0.010382 USDC, not confirmed yet. Stage 4 of 4: Machine.",
    );
    const ready = run({ phase: "ready", payment: sent, spent: "maybe", machine });
    expect(marketAnnouncement(marketMark(ready), run({ phase: "released", payment: sent, spent: "maybe", machine }))).toBe(
      "Machine destroyed. A payment of $0.010382 was sent and is not confirmed.",
    );
  });
  it("announces a refusal in plain words", () => {
    const before = run({ phase: "approval", approval });
    expect(marketAnnouncement(marketMark(before), run({ phase: "refused", approval, refusal: { code: "CANCELLED", detail: "x" } }))).toBe(
      "You cancelled before paying. Nothing was spent.",
    );
  });
  it("announces a failure with the error", () => {
    expect(marketAnnouncement(marketMark(run({})), run({ phase: "failed", error: "No price list could be read" }))).toBe(
      "Run failed. No price list could be read.",
    );
  });
});
