import { describe, expect, it } from "vitest";
import type { MarketRunView } from "@/lib/market/run";
import { approvalSentence, endState, hoursText, leftOutPhrase, leftOutSummary, paymentLine, prepaidLine, quoteNote, shortAddress, solscanUrl, sourceLines, surchargeLine, timeLeft } from "./market-copy";
import { marketStage } from "./stages";

const need = { kind: "cpu" as const, vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false };

function run(over: Partial<MarketRunView>): MarketRunView {
  return {
    id: "mkt_1", market: "test", marketLabel: "Test seller", phase: "scanning", need, limits: { budgetUsd: 1, rateUsdHr: 0.05 },
    askBeforePaying: true, agent: { name: "your agent", ansName: "ans://x" }, sources: [], rows: [], leftOut: [], approval: null,
    payment: null, machine: null, attempts: [], startedAt: 0, paidAt: null, readyAt: null, releasedAt: null, error: null, refusal: null,
    spent: "nothing", fallbacks: [], overspendTest: false,
    ...over,
  };
}

const approval = {
  code: "c", usd: 0.010382, atomic: "10382", exact: "$0.010382", surcharge: null, token: "USDC" as const, network: "Solana mainnet",
  payTo: "ELT2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxd5Ux", plan: "vc2-1c-1gb", region: "ewr", hours: 1, seller: "x402layer",
};

describe("wording", () => {
  it("hours read as people say them", () => {
    expect(hoursText(1)).toBe("1 hour");
    expect(hoursText(3)).toBe("3 hours");
    expect(hoursText(1.5)).toBe("1.5 hours");
    expect(hoursText(0.5)).toBe("30 minutes");
    expect(hoursText(1 / 60)).toBe("1 minute");
  });
  it("time left switches to hours past an hour", () => {
    expect(timeLeft(45)).toBe("45s");
    expect(timeLeft(125)).toBe("2m 05s");
    expect(timeLeft(3600 + 5 * 60 + 9)).toBe("1h 05m");
  });
  it("addresses shorten to four and four", () => {
    expect(shortAddress(approval.payTo)).toBe("ELT2…d5Ux");
    expect(shortAddress("abc")).toBe("abc");
  });
  it("the approval line names amount, token, recipient, network, plan, region and hours", () => {
    expect(approvalSentence(approval)).toBe("Pay $0.010382 USDC to ELT2…d5Ux on Solana mainnet for vc2-1c-1gb in ewr, 1 hour.");
  });
  it("the seller's surcharge is one plain line, from the field's numbers", () => {
    expect(surchargeLine({ pct: 15, underHours: 24 })).toBe("Includes the seller's 15% surcharge for rentals under 24 hours.");
    expect(surchargeLine({ pct: 10, underHours: 1 })).toBe("Includes the seller's 10% surcharge for rentals under 1 hour.");
    expect(surchargeLine(null)).toBeNull();
  });
  it("left-out reasons in plain words, with the total", () => {
    expect(leftOutSummary([{ reason: "TOO_SMALL", count: 22 }, { reason: "OVER_RATE", count: 9 }], need)).toBe("31 plans left out: 22 too small, 9 over your hourly limit");
    expect(leftOutSummary([{ reason: "WRONG_KIND", count: 1 }], need)).toBe("1 plan left out: 1 GPU plan (you asked for CPU)");
    expect(leftOutSummary([{ reason: "TOO_SMALL", count: 7 }, { reason: "WRONG_KIND", count: 3 }], need)).toBe("10 plans left out: 7 too small, 3 GPU plans (you asked for CPU)");
    expect(leftOutSummary([{ reason: "WRONG_KIND", count: 2 }], { ...need, kind: "gpu" })).toBe("2 plans left out: 2 CPU plans (you asked for a GPU)");
    expect(leftOutSummary([{ reason: "SOMETHING_NEW", count: 2 }], need)).toBe("2 plans left out: 2 for another reason");
    expect(leftOutSummary([], need)).toBeNull();
  });
  it("a left-out row says why in words, never a code", () => {
    expect(leftOutPhrase("WRONG_KIND", need)).toBe("GPU, you asked for CPU");
    expect(leftOutPhrase("OVER_RATE", need)).toBe("over your hourly limit");
    expect(leftOutPhrase(null, need)).toBe("left out");
    expect(leftOutPhrase("SOMETHING_NEW", need)).toBe("left out");
  });
  it("a failed quote becomes a short note, read from its code", () => {
    expect(quoteNote("OUT_OF_STOCK")).toBe("out of stock");
    expect(quoteNote("WRONG_ASSET")).toBe("asked for a different token");
    expect(quoteNote("SOMETHING_NEW")).toBe("quote failed");
    expect(quoteNote(null)).toBe("quote failed");
  });
  it("the payment line says settled only for a confirmed payment, with the exact amount", () => {
    expect(paymentLine({ atomic: "10382", status: "confirmed" }, "test")).toBe("Paid $0.010382 over x402, settled on Solana devnet.");
    expect(paymentLine({ atomic: "10382", status: "unconfirmed" }, "real")).toBe("Sent $0.010382 over x402 on Solana mainnet, not confirmed yet.");
  });
  it("after an early destroy, one line on what was paid and that unused time is not refunded", () => {
    expect(prepaidLine({ atomic: "10382", status: "confirmed" }, 1, 51)).toBe("Paid $0.010382 for 1 hour. Destroyed after 51 s. The seller does not refund unused time.");
    expect(prepaidLine({ atomic: "10382", status: "unconfirmed" }, 2, 125)).toBe("Sent $0.010382 for 2 hours, not confirmed yet. Destroyed after 2 min 5 s. The seller does not refund unused time.");
    expect(prepaidLine({ atomic: "10382", status: "confirmed" }, 1, null)).toBe("Paid $0.010382 for 1 hour. The seller does not refund unused time.");
  });
  it("sources: plans, spot offers and failures", () => {
    expect(
      sourceLines([
        { name: "x402layer", ok: true, count: 148, note: null },
        { name: "Spot GPU prices (nuza)", ok: true, count: 0, note: null },
      ]),
    ).toEqual([
      { text: "148 plans from x402layer", ok: true },
      { text: "0 spot offers from nuza", ok: true },
    ]);
    expect(sourceLines([{ name: "Spot GPU prices (nuza)", ok: false, count: 0, note: "nuza answered 500" }])).toEqual([
      { text: "Spot offers from nuza could not be read (nuza answered 500)", ok: false },
    ]);
  });
  it("the seller named in the panel's subtitle is not named again in the sources line", () => {
    expect(sourceLines([{ name: "Test seller", ok: true, count: 11, note: null }], "Test seller")).toEqual([{ text: "11 plans in the seller's price list", ok: true }]);
    expect(sourceLines([{ name: "Test seller", ok: false, count: 0, note: null }], "Test seller")).toEqual([{ text: "The seller's price list could not be read", ok: false }]);
  });
  it("Solscan links carry the devnet cluster on the test market only", () => {
    const sig = "DPJTAv4S3EufsQkAhXpPZwZB76NUUrkypxpJnMXcL6KUXXqBAs3Cm6m4SbqiC9DoPVe85EkG9PLjFZCyyVdhZj9";
    expect(solscanUrl(sig, "test")).toBe(`https://solscan.io/tx/${sig}?cluster=devnet`);
    expect(solscanUrl(sig, "real")).toBe(`https://solscan.io/tx/${sig}`);
  });
  it("only a base58 signature of the expected length becomes a link", () => {
    for (const bad of ["..", "", "abcdefghijkmnopqrstu", `${"A".repeat(40)}/${"B".repeat(40)}`, `${"A".repeat(40)}?${"B".repeat(40)}`, `0x${"ab".repeat(32)}`]) {
      expect(solscanUrl(bad, "test")).toBeNull();
    }
  });
});

describe("endState", () => {
  it("is null while the run is going", () => {
    expect(endState(run({ phase: "ready" }))).toBeNull();
  });
  it("words each refusal plainly", () => {
    const r = (code: string) => endState(run({ phase: "refused", refusal: { code, detail: "d" } }))!.sentence;
    expect(r("CANCELLED")).toBe("You cancelled before paying. Nothing was spent.");
    expect(r("STOPPED")).toBe("Stopped before paying. Nothing was spent.");
    expect(r("OVER_QUOTE")).toBe("The seller raised the price after quoting. Nothing was paid.");
    expect(r("NOTHING_FITS")).toMatch(/^No plan fits\. /);
    for (const code of ["WRONG_ASSET", "WRONG_NETWORK", "OVER_BUDGET", "OVER_RATE", "ALREADY_PAID"]) expect(r(code)).toMatch(/Nothing (more )?was paid\.$/);
  });
  it("adds the left-out summary to nothing fits", () => {
    const e = endState(run({ phase: "refused", refusal: { code: "NOTHING_FITS", detail: "d" }, leftOut: [{ reason: "TOO_SMALL", count: 3 }] }))!;
    expect(e.next).toContain("3 plans left out: 3 too small");
  });
  it("nothing-fits advice follows the actual reasons", () => {
    const next = (leftOut: { reason: string; count: number }[]) => endState(run({ phase: "refused", refusal: { code: "NOTHING_FITS", detail: "d" }, leftOut }))!.next!;
    const small = next([{ reason: "TOO_SMALL", count: 8 }, { reason: "WRONG_KIND", count: 3 }]);
    expect(small).toBe("11 plans left out: 8 too small, 3 GPU plans (you asked for CPU). Ask for a smaller machine, then try again.");
    expect(small).not.toMatch(/budget|hourly limit/);
    const rate = next([{ reason: "OVER_RATE", count: 8 }, { reason: "WRONG_KIND", count: 3 }]);
    expect(rate).toMatch(/Raise the hourly limit, then try again\.$/);
    expect(rate).not.toMatch(/smaller|budget/);
    expect(next([{ reason: "OVER_BUDGET", count: 2 }, { reason: "TOO_SMALL", count: 1 }])).toMatch(/Raise the budget, or ask for a smaller machine, then try again\.$/);
    expect(next([{ reason: "WRONG_KIND", count: 3 }])).toMatch(/Change what you ask for, then try again\.$/);
  });
  it("a failure before paying says nothing was spent", () => {
    const e = endState(run({ phase: "failed", error: "No usable quote: x" }))!;
    expect(e.tone).toBe("bad");
    expect(e.sentence).toBe("No usable quote: x.");
    expect(e.next).toMatch(/Nothing was spent/);
  });
  const kept = { usd: 0.010382, atomic: "10382", tx: "4uwC", at: 1, payer: "p", status: "confirmed" as const };
  const said = (e: ReturnType<typeof endState>) => `${e?.title} ${e?.sentence} ${e?.next ?? ""}`;
  it("B1: a payment the seller kept, with no machine, is said as spent with the exact amount, never nothing spent", () => {
    const e = endState(run({ phase: "failed", spent: "paid", payment: kept, error: "The seller took one payment of $0.010382 and did not deliver a machine." }))!;
    expect(e.sentence).toBe("The seller took one payment of $0.010382 and did not deliver a machine.");
    expect(e.next).toBe("It stays listed under open purchases until you dismiss it.");
    expect(said(e)).not.toMatch(/nothing/i);
  });
  it("B1: a paid failure whose error does not name the amount adds it", () => {
    const e = endState(run({ phase: "failed", spent: "paid", payment: kept, error: "the run stopped on an unexpected error" }))!;
    expect(e.next).toBe("$0.010382 was paid. It stays listed under open purchases until you dismiss it.");
  });
  it("B1: an unconfirmed payment says it was sent and is not confirmed, never nothing spent", () => {
    const e = endState(run({ phase: "failed", spent: "maybe", payment: { ...kept, status: "unconfirmed" }, error: null }))!;
    expect(e.sentence).toBe("The run failed.");
    expect(e.next).toBe("A payment of $0.010382 was sent and is not confirmed. It stays listed under open purchases until you dismiss it.");
    expect(said(e)).not.toMatch(/nothing/i);
    const backend = endState(run({ phase: "failed", spent: "maybe", payment: { ...kept, status: "unconfirmed" }, error: "A payment of $0.010382 was signed and sent. The seller did not confirm it." }))!;
    expect(backend.sentence).toBe("A payment of $0.010382 was signed and sent. The seller did not confirm it.");
    expect(said(backend)).not.toMatch(/nothing/i);
  });
  it("B1: nothing was spent only when spent is nothing, even for a refusal after a payment", () => {
    const e = endState(run({ phase: "refused", spent: "maybe", payment: { ...kept, status: "unconfirmed" }, refusal: { code: "CANCELLED", detail: "x" } }))!;
    expect(said(e)).not.toMatch(/nothing/i);
    expect(e.next).toMatch(/A payment of \$0\.010382 was sent and is not confirmed/);
  });
  it("a failure after paying with the machine up points at Destroy now", () => {
    const e = endState(
      run({
        phase: "failed", spent: "paid", error: "the machine did not become active", payment: { usd: 0.01, atomic: "10000", tx: null, at: 1, payer: "p", status: "confirmed" },
        machine: { id: "m", ip: null, status: "pending", expiresAt: null, destroyAt: null, ssh: null, port22: "not checked", plan: "p", region: "ewr" },
      }),
    )!;
    expect(e.next).toMatch(/Destroy now/);
  });
});

describe("marketStage", () => {
  it("maps phases to Scan, Choose, Pay, Machine", () => {
    expect(marketStage(run({ phase: "scanning" }))).toBe(0);
    expect(marketStage(run({ phase: "quoting" }))).toBe(1);
    expect(marketStage(run({ phase: "approval", approval }))).toBe(2);
    expect(marketStage(run({ phase: "provisioning" }))).toBe(3);
    expect(marketStage(run({ phase: "released" }))).toBe(4);
  });
  it("a refused or failed run stays on the stage it reached", () => {
    expect(marketStage(run({ phase: "refused", refusal: { code: "STOPPED", detail: "" } }))).toBe(0);
    const row = { seller: "s", id: "a", provider: "p", kind: "cpu" as const, vcpus: 1, ramGb: 1, vramGb: 0, gpu: null, region: null, hours: null, listHourlyUsd: null, hourlyUsd: 1, estimateUsd: null, quoteUsd: null, quoteExact: null, state: "left out" as const, note: "TOO_SMALL", code: "TOO_SMALL" };
    expect(marketStage(run({ phase: "refused", rows: [row], refusal: { code: "NOTHING_FITS", detail: "" } }))).toBe(1);
    expect(marketStage(run({ phase: "refused", approval, refusal: { code: "CANCELLED", detail: "" } }))).toBe(2);
    expect(marketStage(run({ phase: "failed", payment: { usd: 0.01, atomic: "10000", tx: null, at: 1, payer: "p", status: "confirmed" } }))).toBe(3);
  });
});
