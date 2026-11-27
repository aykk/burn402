import { describe, expect, it } from "vitest";
import { plainReason, recordWords, transactionOutcome } from "./record-words";

const words = (over: Partial<Parameters<typeof recordWords>[0]>) =>
  recordWords({ outcome: null, plan: null, usd: null, tx: null, reason: null, ...over });

describe("record headlines", () => {
  it("NS2: a normal purchase states the exact amount paid", () => {
    expect(words({ outcome: "accepted", plan: "vc2-1c-1gb", usd: 0.010382, tx: "4ZmZ" }).headline).toBe("paid $0.010382 USDC for a vc2-1c-1gb server");
    expect(words({ outcome: "accepted", plan: "p", usd: 0.011, tx: "x" }).headline).toBe("paid $0.0110 USDC for a p server");
  });
  it("NS3: a run that never chose a plan never reads 'a none server'", () => {
    const refused = words({ outcome: "refused", plan: "none", reason: "No plan fits what you asked for inside your limits: 8 too small, 3 GPU plans (you asked for CPU)." });
    expect(refused.headline).toBe("asked for a server and no plan fit your limits");
    const failed = words({ outcome: "failed", plan: "none", reason: "No seller gave a usable quote. The last problem: The seller asked to be paid in SOL instead of USDC on Solana devnet." });
    expect(failed.headline).toBe("asked for a server and no seller gave a usable quote");
    expect(words({ outcome: "failed", plan: "none" }).headline).toBe("asked for a server and it could not be started");
    expect(words({ outcome: "refused", plan: null }).headline).not.toMatch(/none/);
  });
  it("NN6: a payment the seller kept says so once, with the exact amount", () => {
    const w = words({ outcome: "failed", plan: "vc2-1c-1gb", usd: 0.010382, tx: "2hZE", reason: "SELLER_KEPT_PAYMENT: The seller took one payment of $0.010382 and did not deliver a machine." });
    expect(w.headline).toBe("paid $0.010382; the seller kept it and delivered nothing");
    expect(w.label).toBe("paid, nothing delivered");
    expect(w.reason).toBe("The seller took one payment of $0.010382 and did not deliver a machine.");
  });
  it("NS3: an older record where the seller rejected the payment does not read as if nothing happened", () => {
    const w = words({
      outcome: "failed",
      plan: "vc2-1c-1gb",
      reason: 'Test seller (simulated machines) rejected the payment: {"error":"payment rejected, pay again","quote_usd":0.010382}',
    });
    expect(w.headline).toBe("sent a payment for a vc2-1c-1gb server and the seller rejected it");
    expect(w.label).toBe("payment rejected by the seller");
    expect(w.tone).toBe("bad");
    expect(w.reason).not.toMatch(/[{}]|quote_usd/);
    expect(w.reason).toContain("payment rejected, pay again");
    expect(w.reason).toContain("$0.010382");
    expect(w.reason).toMatch(/does not say whether the money moved/);
  });
  it("NN6: refusals are the agent's, not the broker's", () => {
    expect(transactionOutcome("refused").label).toBe("refused by your agent");
    expect(words({ outcome: "refused", plan: "vc2-1c-1gb", reason: "x" }).label).toBe("refused by your agent");
  });
  it("cancel keeps the market's wording", () => {
    expect(words({ outcome: "refused", plan: "vc2-1c-1gb", reason: "CANCELLED: The owner cancelled at the approval stop; nothing was signed" })).toMatchObject({
      headline: "asked for a vc2-1c-1gb server and you cancelled before paying",
      label: "cancelled by you",
      reason: "You cancelled at the approval stop. Nothing was signed.",
    });
  });
});

describe("NS3: older reasons in plain words", () => {
  it("codes and token addresses become words", () => {
    expect(plainReason("No usable quote: WRONG_ASSET: Seller asked for So11111111111111111111111111111111111111112, not USDC on Solana devnet")).toBe(
      "No seller gave a usable quote. The last problem: the seller asked to be paid in SOL instead of USDC on Solana devnet.",
    );
    expect(plainReason("No plan fits the need inside the limits (8 OVER_RATE, 3 WRONG_KIND)")).toBe(
      "No plan fits what you asked for inside your limits: 8 over your hourly limit, 3 not the kind of machine you asked for.",
    );
    expect(plainReason("No plan fits the need inside the limits (8 TOO_SMALL, 3 WRONG_KIND)")).toBe(
      "No plan fits what you asked for inside your limits: 8 too small, 3 not the kind of machine you asked for.",
    );
  });
  it("stored reasons start with a code; it never shows", () => {
    expect(plainReason("OVER_QUOTE: Seller now asks 12458 atomic units, above the approved 10382")).toBe("The seller now asks $0.012458, more than the $0.010382 you approved.");
    expect(plainReason("NOTHING_FITS: No plan fits the need inside the limits (8 TOO_SMALL, 3 WRONG_KIND)")).toBe(
      "No plan fits what you asked for inside your limits: 8 too small, 3 not the kind of machine you asked for.",
    );
    const w = recordWords({ outcome: "failed", plan: "vc2-1c-1gb", usd: null, tx: null, reason: 'PAYMENT_REJECTED: Test seller rejected the payment: {"error":"no"}' });
    expect(w.reason).toMatch(/^Test seller rejected the payment and answered "no"\./);
  });
  it("atomic units become exact dollars", () => {
    expect(plainReason("Seller now asks 12458 atomic units, above the approved 10382")).toBe("The seller now asks $0.012458, more than the $0.010382 you approved.");
  });
  it("the owner is 'you'", () => {
    expect(plainReason("The owner cancelled at the approval stop; nothing was signed")).toBe("You cancelled at the approval stop. Nothing was signed.");
  });
  it("NN6: no capital letter after a colon mid-sentence", () => {
    expect(plainReason("No seller gave a usable quote. The last problem: The seller asked to be paid in SOL instead of USDC on Solana devnet.")).toBe(
      "No seller gave a usable quote. The last problem: the seller asked to be paid in SOL instead of USDC on Solana devnet.",
    );
  });
  it("never raw JSON, never a bare code; a neutral sentence when nothing readable is left", () => {
    expect(plainReason('The seller answered {"detail":"busy"}')).toBe('The seller answered "busy".');
    expect(plainReason("SOME_NEW_CODE")).toBe("The record gives no reason in words.");
    expect(plainReason("Failed with SOME_NEW_CODE")).toBe("The record gives no reason in words.");
    expect(plainReason("")).toBeNull();
    expect(plainReason(null)).toBeNull();
  });
  it("text that is already plain stays as it is", () => {
    const t = "The seller now asks $0.012458, more than the $0.010382 you approved.";
    expect(plainReason(t)).toBe(t);
    expect(plainReason("No plan fits what you asked for inside your limits: 8 over your hourly limit, 3 GPU plans (you asked for CPU).")).toBe(
      "No plan fits what you asked for inside your limits: 8 over your hourly limit, 3 GPU plans (you asked for CPU).",
    );
  });
  it("the older broker reasons keep their wording", () => {
    expect(plainReason("plan 0.263/hr > mandate rate 0.25/hr")).toBe("The server costs $0.263 an hour and the budget allowed $0.25.");
    expect(plainReason("BUDGET_EXCEEDED: spent 1.2 of 1")).toBe("The budget had no money left in it.");
  });
});
