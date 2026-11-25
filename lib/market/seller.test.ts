import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyAuth, base58Encode, signerFromSecret } from "./auth";
import type { Candidate } from "./choose";
import type { Accepts } from "./guard";
import { readPaymentRequired, type PaymentRequired } from "./pay";
import { QuoteError, SELLERS, SellerClient, type Quote, type SellerConfig } from "./seller";
import type { Offer } from "./types";

const config: SellerConfig = { id: "x402layer", label: "x402layer", baseUrl: "https://seller.example", market: "real" };
const REAL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Step = Response | Error | ((call: Call) => Response);

function fakeFetch(steps: Step[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call = { url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : "" };
    calls.push(call);
    const step = steps.shift();
    if (!step) throw new Error(`unexpected request ${call.method} ${call.url}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(call) : step;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const solanaAccepts = (amount = "10000") => ({
  scheme: "exact",
  network: REAL_NET,
  asset: USDC,
  amount,
  payTo: "PayTo1111111111111111111111111111111111111",
  maxTimeoutSeconds: 60,
  extra: { feePayer: "Fee11111111111111111111111111111111111111" },
});

function required402(accepts: object[] = [solanaAccepts()]): Response {
  const pr = { x402Version: 2, resource: { url: "https://seller.example/compute/provision" }, accepts };
  const v1Body = { x402Version: 1, accepts: [{ scheme: "exact", network: "solana", maxAmountRequired: "99999999" }] };
  return new Response(JSON.stringify(v1Body), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64"), "Content-Type": "application/json" },
  });
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const offer = (provider: string, id = "vc2-1c-1gb"): Offer => ({
  seller: "x402layer", id, provider, kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, gpu: null, regions: ["ewr"],
  hourlyUsd: 0.009, listHourlyUsd: 0.007, inStock: true, spot: false, rentable: true,
});
const candidate = (provider = "vultr", id?: string): Candidate => ({ offer: offer(provider, id), regions: ["ewr"], hours: 1, estimateUsd: 0.0104 });
const opts = { sshPublicKey: "ssh-ed25519 AAAAtest", maxTotalUsd: 0.05 };
const order = { id: "ord-1", plan: "vc2-1c-1gb", region: "ewr", status: "active", ip_address: "198.51.100.7", expires_at: "2026-11-24T12:00:00Z" };

async function quoteWith(): Promise<Quote> {
  const { fetch } = fakeFetch([required402()]);
  return new SellerClient(config, { fetch }).quote(candidate(), "ewr", opts);
}

function testSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return signerFromSecret(base58Encode(new Uint8Array([...seed, ...pub])));
}

const PAID = { "PAYMENT-SIGNATURE": "c2lnbmVk" };

describe("SELLERS", () => {
  it("points at the real and test sellers", () => {
    expect(SELLERS.real).toMatchObject({ id: "x402layer", baseUrl: "https://compute.x402layer.cc", market: "real" });
    expect(SELLERS.test).toMatchObject({ id: "testseller", baseUrl: "http://127.0.0.1:3000/api/testseller", market: "test" });
  });
});

describe("readPaymentRequired", () => {
  it("reads the v2 header and ignores the v1 body", () => {
    const pr = readPaymentRequired(required402(), "");
    expect(pr?.accepts[0].amount).toBe("10000");
    expect(pr?.accepts[0].network).toBe(REAL_NET);
  });
  it("returns null without a header or with garbage", () => {
    expect(readPaymentRequired(json(402, { x402Version: 1, accepts: [] }), '{"x402Version":1,"accepts":[]}')).toBeNull();
    expect(readPaymentRequired(new Response("", { status: 402, headers: { "PAYMENT-REQUIRED": "!!!" } }), "")).toBeNull();
    const notPr = Buffer.from(JSON.stringify({ hello: 1 })).toString("base64");
    expect(readPaymentRequired(new Response("", { status: 402, headers: { "PAYMENT-REQUIRED": notPr } }), "")).toBeNull();
  });
});

describe("catalog", () => {
  it("GETs /compute/plans and parses it", async () => {
    const { fetch, calls } = fakeFetch([json(200, { plans: [{ id: "vc2-1c-1gb", provider: "vultr", our_hourly: 0.009, ram: 1024, vcpu_count: 1, locations: ["ewr"] }, { id: "bad" }] })]);
    const r = await new SellerClient(config, { fetch }).catalog();
    expect(calls[0]).toMatchObject({ url: "https://seller.example/compute/plans", method: "GET" });
    expect(r.offers.map((o) => o.id)).toEqual(["vc2-1c-1gb"]);
    expect(r.offers[0].seller).toBe("x402layer");
    expect(r.skipped).toBe(1);
  });
  it("throws when the feed answers non-2xx", async () => {
    const { fetch } = fakeFetch([json(500, {})]);
    await expect(new SellerClient(config, { fetch }).catalog()).rejects.toThrow(/500/);
  });
});

describe("quote", () => {
  it("POSTs the exact body with no auth or payment headers and returns the quote", async () => {
    const { fetch, calls } = fakeFetch([required402([{ ...solanaAccepts(), network: "eip155:8453" }, solanaAccepts("12345")])]);
    const q = await new SellerClient(config, { fetch, signer: await testSigner() }).quote(candidate(), "ewr", opts);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://seller.example/compute/provision");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBe(
      JSON.stringify({ plan: "vc2-1c-1gb", region: "ewr", os_id: 2284, label: "agent-rental", prepaid_hours: 1, ssh_public_key: "ssh-ed25519 AAAAtest", network: "solana", max_total_usd: 0.05 }),
    );
    expect(Object.keys(calls[0].headers).filter((k) => k.startsWith("x-auth") || k.includes("payment"))).toEqual([]);
    expect(q).toMatchObject({ seller: "x402layer", market: "real", region: "ewr", hours: 1, amountUsd: 0.012345, atomic: "12345", body: calls[0].body });
    expect(q.accepts).toEqual({ scheme: "exact", network: REAL_NET, asset: USDC, amount: "12345", payTo: solanaAccepts().payTo });
  });

  it("uses the digitalocean slug and omits os_id for runpod", async () => {
    const a = fakeFetch([required402()]);
    await new SellerClient(config, { fetch: a.fetch }).quote(candidate("digitalocean", "s-1vcpu-1gb"), "nyc1", opts);
    expect(JSON.parse(a.calls[0].body).os_id).toBe("ubuntu-24-04-x64");
    const b = fakeFetch([required402()]);
    await new SellerClient(config, { fetch: b.fetch }).quote({ ...candidate("runpod", "runpod-a4000"), hours: 2 }, "runpod", opts);
    const body = JSON.parse(b.calls[0].body);
    expect("os_id" in body).toBe(false);
    expect(body.prepaid_hours).toBe(2);
  });

  const code = async (step: Step) => {
    const { fetch } = fakeFetch([step]);
    try {
      await new SellerClient(config, { fetch }).quote(candidate(), "ewr", opts);
    } catch (e) {
      expect(e).toBeInstanceOf(QuoteError);
      return (e as QuoteError).code;
    }
    throw new Error("expected a QuoteError");
  };

  it("409 with quote_usd is PRICE_CAP", async () => expect(await code(json(409, { error: "too much", quote_usd: 0.2 }))).toBe("PRICE_CAP"));
  it("stock messages are OUT_OF_STOCK", async () => {
    expect(await code(json(400, { error: "Plan is Out Of Stock in ewr" }))).toBe("OUT_OF_STOCK");
    expect(await code(json(503, { error: "Region unavailable" }))).toBe("OUT_OF_STOCK");
    expect(await code(json(500, { error: "no capacity" }))).toBe("OUT_OF_STOCK");
  });
  it("other statuses are SELLER_ERROR", async () => expect(await code(json(400, { error: "bad ssh key" }))).toBe("SELLER_ERROR"));
  it("a thrown fetch is UNREACHABLE", async () => expect(await code(new TypeError("fetch failed"))).toBe("UNREACHABLE"));
  it("402 without a readable requirement is NO_402", async () => {
    expect(await code(json(402, { x402Version: 1, accepts: [] }))).toBe("NO_402");
    expect(await code(required402([{ ...solanaAccepts(), network: "eip155:8453" }]))).toBe("NO_402");
  });
});

describe("quote validation", () => {
  it.each([
    ["abc", {}],
    ["1e9", {}],
    ["", {}],
    [12345, {}],
    ["10000", { payTo: undefined }],
    ["10000", { asset: "" }],
    ["10000", { network: undefined }],
  ])("amount %j with %j is NO_402", async (amount, patch) => {
    const { fetch } = fakeFetch([required402([{ ...solanaAccepts(), amount, ...patch }])]);
    // network undefined also removes the solana entry, which is NO_402 as well
    const err = await new SellerClient(config, { fetch }).quote(candidate(), "ewr", opts).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteError);
    expect((err as QuoteError).code).toBe("NO_402");
  });
});

describe("timeouts", () => {
  const hang = (first?: Response) => {
    const signals: (AbortSignal | undefined)[] = [];
    let n = 0;
    const fn = vi.fn(
      (_i: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          signals.push(init?.signal ?? undefined);
          if (first && n++ === 0) return resolve(first);
          const sig = init?.signal;
          if (!sig) return; // never settles: the test would time out
          const abort = () => reject(sig.reason ?? new Error("aborted"));
          if (sig.aborted) abort();
          else sig.addEventListener("abort", abort);
        }),
    );
    return { fetch: fn as unknown as typeof fetch, fn, signals };
  };
  const tiny = { read: 20, paid: 20 };

  it("a hanging quote is UNREACHABLE", async () => {
    const { fetch } = hang();
    const err = await new SellerClient(config, { fetch, timeouts: tiny }).quote(candidate(), "ewr", opts).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteError);
    expect((err as QuoteError).code).toBe("UNREACHABLE");
  });

  it("a hanging catalog GET rejects", async () => {
    const { fetch } = hang();
    await expect(new SellerClient(config, { fetch, timeouts: tiny }).catalog()).rejects.toBeDefined();
  });

  it("a paid request that hangs three times is unknown and pay runs once", async () => {
    const q = await quoteWith();
    const { fetch, fn } = hang(required402());
    const pay = vi.fn(async () => ({ ...PAID }));
    const out = await new SellerClient(config, { fetch, timeouts: tiny, sleep: async () => {} }).provision(q, pay);
    expect(out.kind).toBe("unknown");
    expect(pay).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("every request carries a signal, defaults 30 s read and 60 s paid", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const signer = await testSigner();
    const { fetch, calls } = fakeFetch([json(200, { plans: [] }), required402(), required402(), json(201, { order }), json(200, []), json(200, {})]);
    const seen: (AbortSignal | null | undefined)[] = [];
    const wrapped = ((i: RequestInfo | URL, init?: RequestInit) => (seen.push(init?.signal), fetch(i, init))) as typeof fetch;
    const client = new SellerClient(config, { fetch: wrapped, signer });
    await client.catalog();
    const q = await client.quote(candidate(), "ewr", opts);
    await client.provision(q, async () => ({ ...PAID }));
    await client.instances();
    await client.destroy("ord-1");
    expect(calls).toHaveLength(6);
    expect(seen.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([30000, 30000, 30000, 60000, 30000, 60000]);
    spy.mockRestore();
  });
});

describe("provision", () => {
  const okPay = () => vi.fn<(r: PaymentRequired, a: Accepts) => Promise<Record<string, string>>>(async () => ({ ...PAID }));

  it("quote body is reused byte-for-byte", async () => {
    const q = await quoteWith();
    const { fetch, calls } = fakeFetch([required402(), json(201, { success: true, order, tx_hash: "tx1" })]);
    await new SellerClient(config, { fetch }).provision(q, okPay());
    expect(calls.map((c) => c.body)).toEqual([q.body, q.body]);
    expect(calls.every((c) => c.url === "https://seller.example/compute/provision" && c.method === "POST")).toBe(true);
  });

  it("gets a fresh 402, pays once for the solana entry, sends the payment headers, and is active", async () => {
    const q = await quoteWith();
    const fresh = [{ ...solanaAccepts(), network: "eip155:8453" }, solanaAccepts("9000")];
    const { fetch, calls } = fakeFetch([required402(fresh), json(200, { success: true, order, tx_hash: "tx1" })]);
    const pay = okPay();
    const out = await new SellerClient(config, { fetch }).provision(q, pay);
    expect(pay).toHaveBeenCalledTimes(1);
    const [req, acc] = pay.mock.calls[0];
    expect(acc.amount).toBe("9000");
    expect(req.accepts).toEqual([solanaAccepts("9000")]);
    expect(calls[0].headers["payment-signature"]).toBeUndefined();
    expect(calls[1].headers["payment-signature"]).toBe("c2lnbmVk");
    expect(Object.keys(calls[1].headers).some((k) => k.startsWith("x-auth"))).toBe(false);
    expect(out).toEqual({
      kind: "active",
      tx: "tx1",
      instance: { id: "ord-1", status: "active", ip: "198.51.100.7", expiresAt: Date.parse("2026-11-24T12:00:00Z") / 1000, plan: "vc2-1c-1gb", region: "ewr" },
    });
  });

  it("is pending when the order is not active or has no IP", async () => {
    const q = await quoteWith();
    for (const o of [{ ...order, status: "pending" }, { ...order, ip_address: "0.0.0.0" }, { ...order, ip_address: "" }]) {
      const { fetch } = fakeFetch([required402(), json(201, { order: o })]);
      const out = await new SellerClient(config, { fetch }).provision(q, okPay());
      expect(out.kind).toBe("pending");
    }
  });

  it("202 is pending with the order", async () => {
    const q = await quoteWith();
    const { fetch } = fakeFetch([required402(), json(202, { order: { ...order, status: "pending", ip_address: null } })]);
    const out = await new SellerClient(config, { fetch }).provision(q, okPay());
    expect(out).toMatchObject({ kind: "pending", instance: { id: "ord-1", ip: null } });
  });

  it("409 settlement_pending gives unknown", async () => {
    const q = await quoteWith();
    const { fetch, calls } = fakeFetch([required402(), json(409, { error: "settlement_pending", code: "settlement_pending" })]);
    const pay = okPay();
    const out = await new SellerClient(config, { fetch }).provision(q, pay);
    expect(out.kind).toBe("unknown");
    expect(calls).toHaveLength(2);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it("402 on the paid request is PAYMENT_REJECTED", async () => {
    const q = await quoteWith();
    const { fetch } = fakeFetch([required402(), required402()]);
    expect(await new SellerClient(config, { fetch }).provision(q, okPay())).toMatchObject({ kind: "not_charged", code: "PAYMENT_REJECTED" });
  });

  it("409 with quote_usd on the paid request is PRICE_CAP", async () => {
    const q = await quoteWith();
    const { fetch } = fakeFetch([required402(), json(409, { quote_usd: 0.2 })]);
    expect(await new SellerClient(config, { fetch }).provision(q, okPay())).toMatchObject({ kind: "not_charged", code: "PRICE_CAP" });
  });

  it("guard refusal sends no paid request", async () => {
    const q = await quoteWith();
    const { fetch, calls } = fakeFetch([required402()]);
    const pay = vi.fn(async () => ({ refused: "OVER_QUOTE" }));
    const out = await new SellerClient(config, { fetch }).provision(q, pay);
    expect(out).toMatchObject({ kind: "not_charged", code: "REFUSED_BY_GUARD", detail: "OVER_QUOTE" });
    expect(calls).toHaveLength(1);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it("does not pay when the fresh request is not a 402", async () => {
    const q = await quoteWith();
    for (const [step, c] of [
      [json(409, { quote_usd: 0.2 }), "PRICE_CAP"],
      [json(400, { error: "out of stock" }), "OUT_OF_STOCK"],
      [json(500, { error: "boom" }), "SELLER_ERROR"],
      [new TypeError("fetch failed"), "SELLER_ERROR"],
      [json(402, {}), "SELLER_ERROR"],
    ] as const) {
      const { fetch, calls } = fakeFetch([step]);
      const pay = okPay();
      expect(await new SellerClient(config, { fetch }).provision(q, pay)).toMatchObject({ kind: "not_charged", code: c });
      expect(pay).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    }
  });

  it("pay is called once even when the paid request fails twice with 503 then succeeds", async () => {
    const q = await quoteWith();
    const sleep = vi.fn(async () => {});
    const { fetch, calls } = fakeFetch([required402(), json(503, {}), new TypeError("socket hang up"), json(201, { order, tx_hash: "tx9" })]);
    const pay = okPay();
    const out = await new SellerClient(config, { fetch, sleep }).provision(q, pay);
    expect(pay).toHaveBeenCalledTimes(1);
    const paid = calls.slice(1);
    expect(paid).toHaveLength(3);
    expect(paid.every((c) => JSON.stringify(c) === JSON.stringify(paid[0]))).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(out).toMatchObject({ kind: "active", tx: "tx9" });
  });

  it("three 503s give unknown, not a new payment", async () => {
    const q = await quoteWith();
    const { fetch, calls } = fakeFetch([required402(), json(503, {}), json(503, {}), json(503, {})]);
    const pay = okPay();
    const out = await new SellerClient(config, { fetch, sleep: async () => {} }).provision(q, pay);
    expect(out.kind).toBe("unknown");
    expect(pay).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(4);
  });

  it("refused with a non-string value is still a refusal, detail truncated", async () => {
    const q = await quoteWith();
    const { fetch, calls } = fakeFetch([required402()]);
    const pay = vi.fn(async () => ({ refused: 42 }));
    const out = await new SellerClient(config, { fetch }).provision(q, pay as never);
    expect(out).toMatchObject({ kind: "not_charged", code: "REFUSED_BY_GUARD", detail: "42" });
    expect(calls).toHaveLength(1);
    const long = vi.fn(async () => ({ refused: "x".repeat(500) }));
    const { fetch: f2 } = fakeFetch([required402()]);
    const out2 = await new SellerClient(config, { fetch: f2 }).provision(q, long);
    expect(out2).toMatchObject({ kind: "not_charged", code: "REFUSED_BY_GUARD", detail: "x".repeat(200) });
  });

  it("a paid 400 is unknown", async () => {
    const q = await quoteWith();
    const { fetch } = fakeFetch([required402(), json(400, { error: "bad" })]);
    expect(await new SellerClient(config, { fetch }).provision(q, okPay())).toMatchObject({ kind: "unknown" });
  });

  it("a paid 409 without settlement_pending or quote_usd is unknown", async () => {
    const q = await quoteWith();
    const { fetch } = fakeFetch([required402(), json(409, { error: "conflict" })]);
    expect(await new SellerClient(config, { fetch }).provision(q, okPay())).toMatchObject({ kind: "unknown" });
  });

  it("a paid 200 without an order is unknown", async () => {
    const q = await quoteWith();
    const { fetch } = fakeFetch([required402(), json(200, { success: true })]);
    expect(await new SellerClient(config, { fetch }).provision(q, okPay())).toMatchObject({ kind: "unknown" });
  });

  it("a signing failure is not charged and sends nothing paid", async () => {
    const q = await quoteWith();
    const { fetch, calls } = fakeFetch([required402()]);
    const pay = vi.fn(async () => {
      throw new Error("no funds");
    });
    expect(await new SellerClient(config, { fetch }).provision(q, pay)).toMatchObject({ kind: "not_charged", code: "SELLER_ERROR" });
    expect(calls).toHaveLength(1);
  });
});

describe("managing machines", () => {
  const now = () => 1700000000000;

  it("lists with signed headers for the exact path and accepts all list shapes", async () => {
    const signer = await testSigner();
    for (const body of [[order], { instances: [order] }, { orders: [order] }]) {
      const { fetch, calls } = fakeFetch([json(200, body)]);
      const list = await new SellerClient(config, { fetch, signer, now }).instances();
      expect(list.map((i) => i.id)).toEqual(["ord-1"]);
      expect(calls[0]).toMatchObject({ url: "https://seller.example/compute/instances", method: "GET", body: "" });
      expect(verifyAuth(new Headers(calls[0].headers), { method: "GET", path: "/compute/instances", body: "", nowMs: now() })).toEqual({ ok: true, address: signer.address });
    }
  });

  it("instance(id) maps the fields and returns null on 404", async () => {
    const signer = await testSigner();
    const { fetch, calls } = fakeFetch([json(200, { ...order, ip_address: "0.0.0.0", expires_at: null }), json(404, { error: "not found" })]);
    const client = new SellerClient(config, { fetch, signer, now });
    expect(await client.instance("ord-1")).toEqual({ id: "ord-1", status: "active", ip: null, expiresAt: null, plan: "vc2-1c-1gb", region: "ewr" });
    expect(verifyAuth(new Headers(calls[0].headers), { method: "GET", path: "/compute/instances/ord-1", body: "", nowMs: now() }).ok).toBe(true);
    expect(await client.instance("gone")).toBeNull();
  });

  it("instance(id) unwraps { instance } and { order }", async () => {
    const signer = await testSigner();
    const { fetch } = fakeFetch([json(200, { instance: order }), json(200, { order })]);
    const client = new SellerClient(config, { fetch, signer, now });
    expect((await client.instance("ord-1"))?.id).toBe("ord-1");
    expect((await client.instance("ord-1"))?.id).toBe("ord-1");
  });

  it("instances() throws a plain Error on an unexpected shape", async () => {
    const signer = await testSigner();
    for (const body of [{ nope: 1 }, { instances: "x" }, "text", null]) {
      const { fetch } = fakeFetch([json(200, body)]);
      const err = await new SellerClient(config, { fetch, signer, now }).instances().catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TypeError);
      expect((err as Error).message).toMatch(/unexpected shape/);
    }
  });

  it("destroy signs a DELETE, treats 404 as success and throws on other errors", async () => {
    const signer = await testSigner();
    const { fetch, calls } = fakeFetch([json(200, { ok: true }), json(404, {}), json(500, { error: "x" })]);
    const client = new SellerClient(config, { fetch, signer, now });
    await client.destroy("ord-1");
    expect(calls[0]).toMatchObject({ url: "https://seller.example/compute/instances/ord-1", method: "DELETE" });
    expect(verifyAuth(new Headers(calls[0].headers), { method: "DELETE", path: "/compute/instances/ord-1", body: "", nowMs: now() }).ok).toBe(true);
    await client.destroy("ord-1");
    await expect(client.destroy("ord-1")).rejects.toThrow(/500/);
  });

  it("needs a wallet", async () => {
    const { fetch, calls } = fakeFetch([]);
    const client = new SellerClient(config, { fetch });
    await expect(client.instances()).rejects.toThrow("a wallet is needed to manage machines");
    await expect(client.instance("a")).rejects.toThrow("a wallet is needed to manage machines");
    await expect(client.destroy("a")).rejects.toThrow("a wallet is needed to manage machines");
    expect(calls).toHaveLength(0);
  });
});

describe("seller text is plain", () => {
  const okPay = () => vi.fn<(r: PaymentRequired, a: Accepts) => Promise<Record<string, string>>>(async () => ({ ...PAID }));
  const noRaw = (s: string) => {
    expect(s).not.toMatch(/[{}[\]]|<html|quote_usd|atomic/);
  };

  it("402 on the paid request names the seller's short reason, never the body", async () => {
    const q = await quoteWith();
    const rejected = new Response(JSON.stringify({ error: "payment rejected, pay again", quote_usd: 0.010382 }), { status: 402 });
    const { fetch } = fakeFetch([required402(), rejected]);
    const out = await new SellerClient(config, { fetch }).provision(q, okPay());
    expect(out).toMatchObject({ kind: "not_charged", code: "PAYMENT_REJECTED" });
    if (out.kind === "not_charged") {
      expect(out.detail).toBe("x402layer said the payment was not accepted: payment rejected, pay again.");
      noRaw(out.detail);
    }
  });

  it("402 after payment is PAYMENT_REJECTED even when the body carries quote_usd", async () => {
    const q = await quoteWith();
    const { fetch } = fakeFetch([required402(), json(402, { quote_usd: 0.5 })]);
    const out = await new SellerClient(config, { fetch }).provision(q, okPay());
    expect(out).toMatchObject({ kind: "not_charged", code: "PAYMENT_REJECTED", detail: "x402layer said the payment was not accepted: the seller gave no reason." });
  });

  it("a price cap names dollars", async () => {
    const q = await quoteWith();
    const { fetch } = fakeFetch([required402(), json(409, { error: "too much", quote_usd: 0.2 })]);
    const out = await new SellerClient(config, { fetch }).provision(q, okPay());
    expect(out).toMatchObject({ kind: "not_charged", code: "PRICE_CAP", detail: "x402layer now asks $0.20, more than your budget allows." });
  });

  it("unknown outcomes and errors carry no raw body", async () => {
    const q = await quoteWith();
    const html = new Response("<html><body>502 Bad Gateway {stuff}</body></html>", { status: 502 });
    const { fetch } = fakeFetch([required402(), html, new Response("<html>", { status: 502 }), new Response("<html>", { status: 502 })]);
    const out = await new SellerClient(config, { fetch, sleep: async () => {} }).provision(q, okPay());
    expect(out.kind).toBe("unknown");
    if (out.kind === "unknown") {
      expect(out.detail).toBe("x402layer did not give a clear answer to the paid request after 3 tries (last: error 502, the seller gave no reason).");
      noRaw(out.detail);
    }
  });

  it("an out-of-stock refusal is short", async () => {
    const { fetch } = fakeFetch([json(503, { error: "plan is out of stock in ewr", extra: { a: 1 } })]);
    const err = await new SellerClient(config, { fetch }).quote(candidate(), "ewr", opts).catch((e) => e);
    expect(err.code).toBe("OUT_OF_STOCK");
    expect(err.message).toBe("x402layer could not sell it (error 503): plan is out of stock in ewr.");
  });

  it("the plans feed error carries no body", async () => {
    const { fetch } = fakeFetch([new Response("<html>oops</html>", { status: 500 })]);
    const err = await new SellerClient(config, { fetch }).catalog().catch((e) => e);
    expect(err.message).toBe("x402layer's price list could not be read (error 500): the seller gave no reason.");
  });
});
