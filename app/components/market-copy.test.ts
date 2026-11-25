import { describe, expect, it } from "vitest";
import type { MarketRunView } from "@/lib/market/run";
import type { PriceComparison } from "@/lib/market/prices/compare";
import type { MarketPrice } from "@/lib/market/prices/types";
import { approvalSentence, billedHoursLine, buyableMachine, buyableWord, cheapestMarks, panelBody, priceRows, endState, listJoin, priceMachine, priceSourceLines, pricesAllFailed, pricesLead, safeLink, fallbackLine, machineSize, hoursText, leftOutPhrase, leftOutSummary, paymentLine, prepaidLine, quoteNote, shortAddress, solscanUrl, solscanUrlForCluster, sourceLines, surchargeLine, timeLeft } from "./market-copy";
import { marketStage } from "./stages";

const need = { kind: "cpu" as const, vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false };

function run(over: Partial<MarketRunView>): MarketRunView {
  return {
    id: "mkt_1", market: "test", marketLabel: "Test seller", phase: "scanning", need, limits: { budgetUsd: 1, rateUsdHr: 0.05 },
    askBeforePaying: true, agent: { name: "your agent", ansName: "ans://x" }, sources: [], rows: [], leftOut: [], approval: null,
    payment: null, machine: null, attempts: [], startedAt: 0, paidAt: null, readyAt: null, releasedAt: null, error: null, refusal: null,
    spent: "nothing", fallbacks: [], overspendTest: false, prices: null,
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
    // NN4: a prepaid span a few seconds short of an hour still reads as 1 hour, not "60 minutes"
    expect(hoursText(3598 / 3600)).toBe("1 hour");
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
    expect(prepaidLine({ atomic: "10382", status: "confirmed" }, 1, 51)).toBe("Paid $0.010382 for 1 hour. Destroyed after 51 s. Unused time is not refunded by this app. Whether the seller refunds it depends on the seller.");
    expect(prepaidLine({ atomic: "10382", status: "unconfirmed" }, 2, 125)).toBe("Sent $0.010382 for 2 hours, not confirmed yet. Destroyed after 2 min 5 s. Unused time is not refunded by this app. Whether the seller refunds it depends on the seller.");
    expect(prepaidLine({ atomic: "10382", status: "confirmed" }, 1, null)).toBe("Paid $0.010382 for 1 hour. Unused time is not refunded by this app. Whether the seller refunds it depends on the seller.");
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
  it("NN1: once the kept payment is dismissed, the line no longer says it stays listed", () => {
    const e = endState(run({ phase: "failed", spent: "paid", payment: kept, error: "The seller took one payment of $0.010382 and did not deliver a machine." }), { listed: false })!;
    expect(e.next).toBe("It is no longer listed under open purchases.");
    const other = endState(run({ phase: "failed", spent: "paid", payment: kept, error: "x" }), { listed: false })!;
    expect(other.next).toBe("$0.010382 was paid. It is no longer listed under open purchases.");
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

describe("solscanUrlForCluster (the records page)", () => {
  const sig = "5".repeat(88);
  it("links by cluster, devnet with ?cluster=devnet", () => {
    expect(solscanUrlForCluster(sig, "devnet")).toBe(`https://solscan.io/tx/${sig}?cluster=devnet`);
    expect(solscanUrlForCluster(sig, "mainnet")).toBe(`https://solscan.io/tx/${sig}`);
  });
  it("no link when the cluster is unknown (older records) or the signature is malformed", () => {
    expect(solscanUrlForCluster(sig, null)).toBeNull();
    expect(solscanUrlForCluster(sig, undefined)).toBeNull();
    expect(solscanUrlForCluster("not a signature", "devnet")).toBeNull();
  });
});

describe("NN6: plain names", () => {
  it("no capital letter after a colon inside a backend sentence", () => {
    const e = endState(run({ phase: "failed", error: "No seller gave a usable quote. The last problem: The seller asked to be paid in SOL instead of USDC on Solana devnet." }))!;
    expect(e.sentence).toBe("No seller gave a usable quote. The last problem: the seller asked to be paid in SOL instead of USDC on Solana devnet.");
  });
  it("GPU names never show an underscore", () => {
    expect(machineSize({ kind: "gpu", vcpus: 6, ramGb: 16, vramGb: 16, gpu: "NVIDIA_A16" })).toBe("NVIDIA A16, 16 GB GPU, 6 vCPUs, 16 GB");
  });
  it("region codes in a fallback note are named by city", () => {
    expect(fallbackLine("ewr was out of stock, so the agent used ord.")).toBe("New Jersey (ewr) was out of stock, so the agent used Chicago (ord).");
    expect(fallbackLine("ams3 was out of stock, so the agent used fra1.")).toBe("Ams3 was out of stock, so the agent used fra1.");
  });
});

describe("market prices", () => {
  const asOf = Date.UTC(2026, 10, 25, 19, 42, 10);
  const src = (source: "vultr" | "vast" | "runpod" | "akash", ok = true, note: string | null = null) => ({ source, label: source, ok, count: ok ? 5 : 0, note });
  const price = (over: Partial<MarketPrice>): MarketPrice => ({
    source: "vast", sourceLabel: "Vast.ai marketplace", name: "RTX A4000", kind: "gpu", vcpus: 8, ramGb: 15.5, gpu: "RTX A4000", vramGb: 16,
    hourlyUsd: 0.089, spotHourlyUsd: 0.08, region: "Quebec, CA", note: null, url: "https://cloud.vast.ai/create/", ...over,
  });
  const comparison = (over: Partial<PriceComparison>): PriceComparison => ({
    asOf, sources: [src("vultr"), src("vast"), src("runpod"), src("akash")], best: [], cheapestAnywhere: null, buyable: null, premiumPct: null, sameMachine: null, sellerUnreadable: false, buyingSpot: false, sentence: "s", basis: "b", ...over,
  });
  const buyable = (over: Partial<NonNullable<PriceComparison["buyable"]>> = {}): NonNullable<PriceComparison["buyable"]> => ({
    seller: "Test seller", plan: "vc2-1c-1gb", hourlyUsd: 0.0104, billedHourlyUsd: 0.0104, totalUsd: 0.0104, hours: 1, firm: false, paid: false, surchargePct: null, surchargeUnderHours: null,
    minHours: null, askedHours: 1, billedHours: 1, provider: "vultr", kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, gpu: null, ...over,
  });

  it("joins names as people write them", () => {
    expect(listJoin(["Vultr"])).toBe("Vultr");
    expect(listJoin(["Vultr", "Akash"])).toBe("Vultr and Akash");
    expect(listJoin(["Vultr", "Vast.ai", "RunPod", "Akash"])).toBe("Vultr, Vast.ai, RunPod and Akash");
    expect(listJoin(["Vultr", "Vast.ai", "Akash"], "or")).toBe("Vultr, Vast.ai or Akash");
  });

  it("names the sources read and the time, and each failed source plainly", () => {
    expect(priceSourceLines(comparison({}))).toEqual([{ text: "Live prices from Vultr, Vast.ai, RunPod and Akash, read at 19:42 UTC.", ok: true }]);
    expect(priceSourceLines(comparison({ sources: [src("vultr"), src("vast"), src("runpod", false, "did not answer in time"), src("akash")] }))).toEqual([
      { text: "Live prices from Vultr, Vast.ai and Akash, read at 19:42 UTC.", ok: true },
      { text: "RunPod did not answer in time.", ok: false },
    ]);
    expect(priceSourceLines(comparison({ sources: [src("vultr"), src("vast", false, null)] }))[1]).toEqual({ text: "Vast.ai could not be read.", ok: false });
  });

  it("says when no source could be read, and that the rental is unaffected", () => {
    const all = comparison({ sources: [src("vultr", false, "x"), src("vast", false, "x"), src("runpod", false, "x"), src("akash", false, "x")] });
    expect(pricesAllFailed(all)).toBe(true);
    expect(priceSourceLines(all)).toEqual([{ text: "No live prices could be read from Vultr, Vast.ai, RunPod or Akash. The rental itself is unaffected.", ok: false }]);
    expect(priceSourceLines(comparison({ sources: [] }))).toEqual([{ text: "No live prices could be read. The rental itself is unaffected.", ok: false }]);
    expect(pricesAllFailed(comparison({}))).toBe(false);
  });

  it("leads with the backend's sentence, never a 'no provider lists' claim when none could be read", () => {
    expect(pricesLead(comparison({ sentence: "The cheapest fit anywhere is $0.0890 an hour." }))).toBe("The cheapest fit anywhere is $0.0890 an hour.");
    const failed = { sources: [src("vultr", false, "x")], sentence: "No other provider lists a machine that fits. The cheapest your agent can buy is $0.0104 an hour through Test seller." };
    expect(pricesLead(comparison({ ...failed, buyable: buyable() }))).toBe("The cheapest your agent can buy is an estimated $0.0104 an hour through Test seller.");
    expect(pricesLead(comparison({ ...failed, buyable: buyable({ firm: true }) }))).toBe("The cheapest your agent can buy is a quoted $0.0104 an hour through Test seller.");
    expect(pricesLead(comparison({ ...failed, buyable: buyable({ firm: true, paid: true }) }))).toBe("Your agent paid $0.0104 an hour through Test seller.");
    expect(pricesLead(comparison({ ...failed, sentence: "No provider lists a machine that fits." }))).toBeNull();
    expect(pricesLead(comparison({ ...failed, sellerUnreadable: true }))).toBe("The seller's price list could not be read either.");
    expect(pricesLead(comparison({ ...failed, buyable: buyable(), buyingSpot: true }))).toBe(
      "The cheapest your agent can buy is an estimated $0.0104 an hour through Test seller. Your agent is buying an interruptible machine; its rate is not compared with list prices.",
    );
  });

  it("describes the agent's machine like a provider's", () => {
    expect(buyableMachine(buyable())).toBe("1 vCPU, 1 GB RAM");
    expect(buyableMachine(buyable({ plan: "vcg-a16-6c-60g-16vram", kind: "gpu", gpu: "NVIDIA_A16", vramGb: 16, vcpus: 6, ramGb: 60 }))).toBe("NVIDIA A16, 16 GB GPU memory, 6 vCPUs, 60 GB RAM");
  });

  it("rows: each source's cheapest fit, the same machine marked, and added when it is not its source's cheapest", () => {
    const vultr = price({ source: "vultr", sourceLabel: "Vultr (direct)", name: "vc2-1c-1gb", kind: "cpu", gpu: null, vramGb: 0, vcpus: 1, ramGb: 1, hourlyUsd: 0.007, spotHourlyUsd: null, region: "ewr", url: "https://www.vultr.com/pricing/" });
    const same = { source: "vultr" as const, sourceLabel: "Vultr (direct)", name: "vc2-1c-1gb", hourlyUsd: 0.007, premiumPct: 49 };
    const rows = priceRows(comparison({ best: [vultr], buyable: buyable(), sameMachine: same }));
    expect(rows.map((r) => [r.name, r.same, r.cheapest, r.region, r.detail])).toEqual([["vc2-1c-1gb", true, true, null, "1 vCPU, 1 GB RAM"]]);

    const a16 = { source: "vultr" as const, sourceLabel: "Vultr (direct)", name: "vcg-a16-6c-60g-16vram", hourlyUsd: 0.471, premiumPct: 58 };
    const gpuBuy = buyable({ plan: "vcg-a16-6c-60g-16vram", kind: "gpu", gpu: "NVIDIA A16", vramGb: 16, vcpus: 6, ramGb: 60, hourlyUsd: 0.7453 });
    const cheaperVultr = price({ source: "vultr", sourceLabel: "Vultr (direct)", name: "vcg-x", region: "ewr", hourlyUsd: 0.3 });
    const vast = price({ outsideRegions: true });
    const two = priceRows(comparison({ best: [vast, cheaperVultr], buyable: gpuBuy, sameMachine: a16 }));
    expect(two.map((r) => [r.name, r.same, r.cheapest, r.region, r.outsideRegions])).toEqual([
      ["RTX A4000", false, true, "Quebec, CA", true],
      ["vcg-x", false, false, null, false],
      ["vcg-a16-6c-60g-16vram", true, false, null, false],
    ]);
    expect(two[2].detail).toBe("NVIDIA A16, 16 GB GPU memory, 6 vCPUs, 60 GB RAM");
    expect(two[2].url).toBe("https://www.vultr.com/pricing/");
  });

  it("the right panel: a comparison over an ended run or no run; never over a run in flight", () => {
    expect(panelBody(null, false)).toBe("intro");
    expect(panelBody(null, true)).toBe("compare");
    const clean = { spent: "nothing" as const, machine: null };
    for (const phase of ["scanning", "choosing", "quoting", "approval", "paying", "provisioning", "ready"] as const) {
      expect(panelBody({ phase, ...clean }, true)).toBe("run");
      expect(panelBody({ phase, ...clean }, false)).toBe("run");
    }
    for (const phase of ["released", "failed", "refused"] as const) {
      expect(panelBody({ phase, ...clean }, true)).toBe("compare");
      expect(panelBody({ phase, ...clean }, false)).toBe("run");
    }
  });

  it("an ended run that still needs the owner keeps its body; the comparison goes under it", () => {
    const machine = (status: "running" | "destroyed" | "pending") => ({ id: "m", ip: null, status, expiresAt: null, destroyAt: null, ssh: null, port22: "not checked" as const, plan: "p", region: "ewr" });
    // released: the machine is gone and the money settled; the comparison may take the body
    expect(panelBody({ phase: "released", spent: "paid", machine: machine("destroyed") }, true)).toBe("compare");
    // a failed run with a machine it still knows about (Destroy now, "Destroy failed" must stay in view)
    expect(panelBody({ phase: "failed", spent: "paid", machine: machine("running") }, true)).toBe("run+compare");
    expect(panelBody({ phase: "failed", spent: "nothing", machine: machine("pending") }, true)).toBe("run+compare");
    expect(panelBody({ phase: "failed", spent: "maybe", machine: machine("destroyed") }, true)).toBe("run+compare");
    // a failed run that paid, or may have, with no machine: the money message stays
    expect(panelBody({ phase: "failed", spent: "paid", machine: null }, true)).toBe("run+compare");
    expect(panelBody({ phase: "failed", spent: "maybe", machine: null }, true)).toBe("run+compare");
    // a refusal after a signed payment says what happened to the money: it stays too
    expect(panelBody({ phase: "refused", spent: "paid", machine: null }, true)).toBe("run+compare");
    // without Compare open, always just the run
    expect(panelBody({ phase: "failed", spent: "paid", machine: machine("running") }, false)).toBe("run");
  });

  it("says when the seller bills more hours than were asked for", () => {
    expect(billedHoursLine(1, 2)).toBe("The seller bills a 2-hour minimum; you asked for 1 hour.");
    expect(billedHoursLine(1.5, 2)).toBe("The seller bills whole hours: 2 hours; you asked for 1.5 hours.");
    expect(billedHoursLine(2, 2)).toBeNull();
    expect(billedHoursLine(3, 2)).toBeNull();
  });

  it("describes a machine without repeating its name", () => {
    expect(priceMachine(price({}))).toBe("16 GB GPU memory, 8 vCPUs, 15.5 GB RAM");
    expect(priceMachine(price({ name: "RTX A5000", gpu: "NVIDIA RTX A5000", vramGb: 24, vcpus: 0, ramGb: 0 }))).toBe("24 GB GPU memory");
    expect(priceMachine(price({ name: "rtx3090 24Gi PCIe", gpu: "nvidia rtx3090", vramGb: 24, vcpus: 0, ramGb: 0 }))).toBe("24 GB GPU memory");
    expect(priceMachine(price({ name: "vcg-a16-6c-60g-16vram", gpu: "NVIDIA A16", vcpus: 6, ramGb: 60 }))).toBe("NVIDIA A16, 16 GB GPU memory, 6 vCPUs, 60 GB RAM");
    expect(priceMachine(price({ name: "vc2-1c-1gb", kind: "cpu", gpu: null, vramGb: 0, vcpus: 1, ramGb: 1 }))).toBe("1 vCPU, 1 GB RAM");
    expect(priceMachine(price({ kind: "cpu", gpu: null, vramGb: 0, vcpus: 0, ramGb: 0 }))).toBe("");
  });

  it("marks the cheapest row anywhere, the buyable one too when it is as cheap", () => {
    const best = [price({ hourlyUsd: 0.089 }), price({ source: "runpod", hourlyUsd: 0.16 })];
    expect(cheapestMarks(comparison({ best, buyable: buyable({ hourlyUsd: 0.7453 }) }))).toEqual({ rows: [true, false], buyable: false });
    expect(cheapestMarks(comparison({ best, buyable: buyable({ hourlyUsd: 0.05 }) }))).toEqual({ rows: [false, false], buyable: true });
    expect(cheapestMarks(comparison({ best, buyable: buyable({ hourlyUsd: 0.089 }) }))).toEqual({ rows: [true, false], buyable: true });
    expect(cheapestMarks(comparison({ best: [], buyable: buyable() }))).toEqual({ rows: [], buyable: true });
    expect(cheapestMarks(comparison({ best: [] }))).toEqual({ rows: [], buyable: false });
  });

  it("marks cheapest by the 4-decimal figures shown, so a printed tie marks every tied row", () => {
    // both print as $0.0890
    const best = [price({ hourlyUsd: 0.08904 }), price({ source: "runpod", hourlyUsd: 0.08896 })];
    expect(cheapestMarks(comparison({ best }))).toEqual({ rows: [true, true], buyable: false });
    expect(cheapestMarks(comparison({ best, buyable: buyable({ hourlyUsd: 0.08899 }) }))).toEqual({ rows: [true, true], buyable: true });
    const same = { source: "vultr" as const, sourceLabel: "Vultr (direct)", name: "vcg-a16", hourlyUsd: 0.08901, premiumPct: 0 };
    const rows = priceRows(comparison({ best, buyable: buyable({ plan: "vcg-a16", hourlyUsd: 0.5 }), sameMachine: same }));
    expect(rows.map((r) => r.cheapest)).toEqual([true, true, true]);
  });

  it("an interruptible price that is not lower than the on-demand price is not shown", () => {
    const rows = priceRows(comparison({ best: [price({ hourlyUsd: 0.0896, spotHourlyUsd: 0.0933 }), price({ source: "runpod", hourlyUsd: 0.1, spotHourlyUsd: 0.05 })] }));
    expect(rows.map((r) => r.spotHourlyUsd)).toEqual([null, 0.05]);
  });

  it("a source that answered with nothing in stock says so, and is not shown as a failure", () => {
    const empty = { source: "runpod" as const, label: "RunPod (direct)", ok: true, count: 0, note: "has nothing in stock right now" };
    expect(priceSourceLines(comparison({ sources: [src("vultr"), src("vast"), empty, src("akash")] }))).toEqual([
      { text: "Live prices from Vultr, Vast.ai, RunPod and Akash, read at 19:42 UTC.", ok: true },
      { text: "RunPod has nothing in stock right now.", ok: true },
    ]);
  });

  it("says whether the buyable price is a firm quote or an estimate", () => {
    expect(buyableWord(buyable({ firm: true }))).toBe("Yes, firm quote");
    expect(buyableWord(buyable({ firm: false }))).toBe("Yes, estimate");
    expect(buyableWord(buyable({ firm: true, paid: true }))).toBe("Yes, paid");
  });

  it("links only to https pages", () => {
    expect(safeLink("https://cloud.vast.ai/create/")).toBe("https://cloud.vast.ai/create/");
    expect(safeLink("http://example.com")).toBeNull();
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink(" https://x")).toBeNull();
  });
});
