import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "./journal";
import type { MarketPrices } from "./prices/fetch";
import type { MarketPrice } from "./prices/types";
import { MarketRun, type MarketRunDeps } from "./run";
import { SELLERS, SellerClient } from "./seller";
import { FakeProcessor, fakePayer, inProcess } from "./testing";
import { TestSeller } from "./testseller";
import type { Need, Offer } from "./types";

const T0 = 1_700_000_000_000;
const NEED: Need = { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false };
const SELLER = SELLERS.test.label;
/** vc2-1c-1gb for 1 hour: the chooser's estimate 0.009027 x 1.15; the firm quote rounds up to the atomic unit */
const ESTIMATE_USD = 0.009027 * 1.15;
const QUOTE_USD = 0.010382;

const VULTR: MarketPrice = {
  source: "vultr",
  sourceLabel: "Vultr (direct)",
  name: "vc2-1c-1gb",
  kind: "cpu",
  vcpus: 1,
  ramGb: 1,
  gpu: null,
  vramGb: 0,
  hourlyUsd: 0.007,
  spotHourlyUsd: null,
  region: "ewr",
  note: null,
  url: "https://www.vultr.com/pricing/",
};
const MARKET: MarketPrices = {
  prices: [VULTR],
  sources: [
    { source: "vultr", label: "Vultr (direct)", ok: true, count: 1, note: null },
    { source: "vast", label: "Vast.ai marketplace", ok: false, count: 0, note: "did not answer in time" },
  ],
  asOf: T0,
};

/** the test seller's rules for vc2-1c-1gb, 1 hour: 15% surcharge under 24 hours, 1-hour minimum */
const PLAIN = { seller: SELLER, plan: "vc2-1c-1gb", hours: 1, surchargePct: 15, surchargeUnderHours: 24, minHours: 1, askedHours: 1, billedHours: 1 };
const BASIS = "The agent's price includes the seller's 15% surcharge for rentals under 24 hours and is spread over 1 billed hour; other providers' figures are list prices per hour.";

const dirs: string[] = [];
const payers: { calls: number }[] = [];
afterEach(() => {
  for (const p of payers) expect(p.calls).toBe(0); // these runs stop at approval: nothing is ever signed
  payers.length = 0;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(marketPrices: MarketRunDeps["marketPrices"], wrap?: (f: typeof fetch) => typeof fetch, o: { need?: Partial<Need>; limits?: { budgetUsd: number; rateUsdHr: number }; spotFeed?: () => Promise<Offer[]> } = {}) {
  let t = T0;
  const now = () => t;
  const sleep = async (ms: number) => void (t += ms);
  const processor = new FakeProcessor();
  const seller = new TestSeller({ processor, resourceUrl: `${SELLERS.test.baseUrl}/compute/provision`, now });
  const payer = fakePayer();
  payers.push(payer);
  const base = inProcess(seller);
  const client = new SellerClient(SELLERS.test, { fetch: wrap ? wrap(base) : base, signer: payer.signer, now, sleep });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-prices-run-"));
  dirs.push(dir);
  const run = new MarketRun({
    id: "run-p",
    market: "test",
    seller: client,
    payer,
    journal: new Journal(path.join(dir, "purchases.jsonl")),
    need: { ...NEED, ...o.need },
    spotFeed: o.spotFeed,
    limits: o.limits ?? { budgetUsd: 1, rateUsdHr: 1 },
    askBeforePaying: true,
    agent: { name: "Buyer", ansName: "buyer.agents.test" },
    keyDir: path.join(dir, "keys"),
    now,
    sleep,
    newCode: () => "code-1",
    marketPrices,
  });
  return { run };
}

/** Holds the first unpaid quote request until `release()` is called. */
function gateQuote() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let waiting = false;
  const wrap = (f: typeof fetch) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/compute/provision")) {
        waiting = true;
        await gate;
      }
      return f(input, init);
    }) as typeof fetch;
  return { wrap, release: () => release(), waiting: () => waiting };
}

const waitPhase = (run: MarketRun, phase: string) => vi.waitFor(() => expect(run.view().phase).toBe(phase));

describe("MarketRun with market prices", () => {
  it("shows the comparison from the chooser's estimate, then from the firm quote", async () => {
    const g = gateQuote();
    const { run } = setup(async () => MARKET, g.wrap);
    void run.start();
    await vi.waitFor(() => expect(g.waiting()).toBe(true));
    const before = run.view();
    expect(before.phase).toBe("quoting");
    expect(before.prices).not.toBeNull();
    expect(before.prices!.buyable).toEqual({ ...PLAIN, hourlyUsd: ESTIMATE_USD, totalUsd: ESTIMATE_USD, firm: false });
    expect(before.prices!.sentence).toContain("The cheapest it can buy is an estimated $0.0104 an hour");
    expect(before.prices!.basis).toBe(BASIS);
    expect(before.prices!.cheapestAnywhere?.name).toBe("vc2-1c-1gb");
    expect(before.prices!.sources).toEqual(MARKET.sources);
    expect(before.prices!.asOf).toBe(T0);

    g.release();
    await waitPhase(run, "approval");
    const after = run.view();
    expect(after.prices!.buyable).toEqual({ ...PLAIN, hourlyUsd: QUOTE_USD, totalUsd: QUOTE_USD, firm: true });
    expect(after.prices!.basis).toBe(BASIS);
    expect(after.prices!.premiumPct).toBe(48);
    expect(after.prices!.sentence).toBe(
      `The cheapest fit anywhere is $0.0070 an hour at Vultr (direct), which your agent cannot buy from yet. The cheapest it can buy is a quoted $0.0104 an hour through ${SELLER}, 48% more.`,
    );
    // the comparison never changes what is approved
    expect(after.approval?.usd).toBe(QUOTE_USD);
    expect(after.approval?.plan).toBe("vc2-1c-1gb");
  });

  it("a cheaper market price does not change the plan chosen", async () => {
    const cheap = { ...MARKET, prices: [{ ...VULTR, name: "vc2-1c-2gb", ramGb: 2, hourlyUsd: 0.0001 }] };
    const { run } = setup(async () => cheap);
    await run.start();
    const v = run.view();
    expect(v.phase).toBe("approval");
    expect(v.approval?.plan).toBe("vc2-1c-1gb");
    expect(v.rows.some((r) => r.id === "vc2-1c-2gb" && r.seller !== "testseller")).toBe(false);
  });

  it("a spot offer ranked first is never the buyable figure: the best non-spot plan is", async () => {
    const spot: Offer = { seller: "nuza", id: "spot-cpu", provider: "nuza", kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, gpu: null, regions: ["ewr"], hourlyUsd: 0.001, listHourlyUsd: null, inStock: true, spot: true, rentable: true };
    const g = gateQuote();
    const { run } = setup(async () => MARKET, g.wrap, { need: { allowSpot: true }, spotFeed: async () => [spot] });
    void run.start();
    await vi.waitFor(() => expect(g.waiting()).toBe(true));
    const v = run.view();
    expect(v.rows[0].id).toBe("spot-cpu"); // the chooser still ranks it first
    expect(v.prices!.buyable?.plan).toBe("vc2-1c-1gb");
    expect(v.prices!.buyable?.firm).toBe(false);
    g.release();
    await vi.waitFor(() => expect(["approval", "failed"]).toContain(run.view().phase));
  });

  it("nothing inside the limits: no buyable, and the sentence says inside your limits", async () => {
    const { run } = setup(async () => MARKET, undefined, { limits: { budgetUsd: 1, rateUsdHr: 0.001 } });
    await run.start();
    await vi.waitFor(() => expect(run.view().prices).not.toBeNull());
    expect(run.view().phase).toBe("refused");
    expect(run.view().prices!.buyable).toBeNull();
    expect(run.view().prices!.sentence).toBe("The cheapest fit anywhere is $0.0070 an hour at Vultr (direct). Your agent has no seller it can buy this from inside your limits.");
  });

  it("regions asked for: the basis says other providers' prices are for any region", async () => {
    const { run } = setup(async () => MARKET, undefined, { need: { regions: ["ewr"] } });
    await run.start();
    expect(run.view().prices!.basis).toBe(`${BASIS} Other providers' prices are for any region.`);
  });

  it("without marketPrices there is no comparison", async () => {
    const { run } = setup(undefined);
    await run.start();
    expect(run.view().phase).toBe("approval");
    expect(run.view().prices).toBeNull();
  });

  it("a throwing marketPrices leaves prices null and the run still reaches approval", async () => {
    for (const get of [async () => Promise.reject(new Error("down")), () => { throw new Error("sync"); }, async () => null as unknown as MarketPrices]) {
      const { run } = setup(get as MarketRunDeps["marketPrices"]);
      await run.start();
      expect(run.view().phase).toBe("approval");
      expect(run.view().prices).toBeNull();
    }
  });

  it("a slow marketPrices never holds the run; the comparison appears when it lands", async () => {
    let land!: (r: MarketPrices) => void;
    const { run } = setup(() => new Promise<MarketPrices>((r) => (land = r)));
    await run.start();
    expect(run.view().phase).toBe("approval");
    expect(run.view().prices).toBeNull();
    land(MARKET);
    await vi.waitFor(() => expect(run.view().prices?.buyable?.firm).toBe(true));
    expect(run.view().prices!.buyable!.totalUsd).toBe(QUOTE_USD);
  });

  it("prices with failed sources still show, with those sources marked", async () => {
    const failed: MarketPrices = { prices: [], sources: MARKET.sources.map((s) => ({ ...s, ok: false, count: 0, note: "answered HTTP 503" })), asOf: T0 };
    const { run } = setup(async () => failed);
    await run.start();
    await vi.waitFor(() => expect(run.view().prices).not.toBeNull());
    const p = run.view().prices!;
    expect(p.sources.every((s) => !s.ok)).toBe(true);
    expect(p.sentence).toBe(`No other provider lists a machine that fits. The cheapest your agent can buy is a quoted $0.0104 an hour through ${SELLER}.`);
    expect(run.view().phase).toBe("approval");
  });
});
