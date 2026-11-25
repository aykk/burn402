import { describe, expect, it } from "vitest";
import type { MarketRunView } from "@/lib/market/run";
import { approvalSentence, endState, hoursText, leftOutSummary, quoteNote, shortAddress, solscanUrl, sourceLines, timeLeft } from "./market-copy";
import { marketStage } from "./stages";

const need = { kind: "cpu" as const, vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false };

function run(over: Partial<MarketRunView>): MarketRunView {
  return {
    id: "mkt_1", market: "test", marketLabel: "Test seller", phase: "scanning", need, limits: { budgetUsd: 1, rateUsdHr: 0.05 },
    askBeforePaying: true, agent: { name: "your agent", ansName: "ans://x" }, sources: [], rows: [], leftOut: [], approval: null,
    payment: null, machine: null, attempts: [], startedAt: 0, paidAt: null, readyAt: null, releasedAt: null, error: null, refusal: null,
    ...over,
  };
}

const approval = {
  code: "c", usd: 0.01, atomic: "10000", token: "USDC" as const, network: "Solana mainnet",
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
    expect(approvalSentence(approval)).toBe("Pay $0.0100 USDC to ELT2…d5Ux on Solana mainnet for vc2-1c-1gb in ewr, 1 hour.");
  });
  it("left-out reasons in plain words, with the total", () => {
    expect(leftOutSummary([{ reason: "TOO_SMALL", count: 22 }, { reason: "OVER_RATE", count: 9 }], need)).toBe("31 plans left out: 22 too small, 9 over your hourly limit");
    expect(leftOutSummary([{ reason: "WRONG_KIND", count: 1 }], need)).toBe("1 plan left out: 1 with a GPU");
    expect(leftOutSummary([], need)).toBeNull();
  });
  it("a failed quote becomes a short note", () => {
    expect(quoteNote("OUT_OF_STOCK: seller answered 409")).toBe("out of stock");
    expect(quoteNote("WRONG_ASSET: Seller asked for X")).toBe("asked for a different token");
    expect(quoteNote(null)).toBe("quote failed");
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
  it("Solscan links carry the devnet cluster on the test market only", () => {
    expect(solscanUrl("abc", "test")).toBe("https://solscan.io/tx/abc?cluster=devnet");
    expect(solscanUrl("abc", "real")).toBe("https://solscan.io/tx/abc");
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
  it("a failure before paying says nothing was spent", () => {
    const e = endState(run({ phase: "failed", error: "No usable quote: x" }))!;
    expect(e.tone).toBe("bad");
    expect(e.sentence).toBe("No usable quote: x.");
    expect(e.next).toMatch(/Nothing was spent/);
  });
  it("a failure after paying with the machine up points at Destroy now", () => {
    const e = endState(
      run({
        phase: "failed", error: "the machine did not become active", payment: { usd: 0.01, tx: null, at: 1, payer: "p" },
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
    const row = { seller: "s", id: "a", provider: "p", kind: "cpu" as const, vcpus: 1, ramGb: 1, vramGb: 0, gpu: null, region: null, hours: null, listHourlyUsd: null, hourlyUsd: 1, estimateUsd: null, quoteUsd: null, state: "left out" as const, note: "TOO_SMALL" };
    expect(marketStage(run({ phase: "refused", rows: [row], refusal: { code: "NOTHING_FITS", detail: "" } }))).toBe(1);
    expect(marketStage(run({ phase: "refused", approval, refusal: { code: "CANCELLED", detail: "" } }))).toBe(2);
    expect(marketStage(run({ phase: "failed", payment: { usd: 0.01, tx: null, at: 1, payer: "p" } }))).toBe(3);
  });
});
