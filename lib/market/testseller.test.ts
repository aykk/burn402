import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeaders } from "./auth";
import type { Candidate } from "./choose";
import type { Accepts } from "./guard";
import type { PaymentRequired } from "./pay";
import { QuoteError, SELLERS, SellerClient } from "./seller";
import { FakeProcessor, fakePayer, inProcess } from "./testing";
import { getTestSeller, NO_FAULTS, TestSeller } from "./testseller";

const BASE = SELLERS.test.baseUrl;
const T0 = 1_700_000_000_000;
const opts = { sshPublicKey: "ssh-ed25519 AAAAtest", maxTotalUsd: 1 };

function setup(activeAfterSec?: number) {
  let t = T0;
  const now = () => t;
  const processor = new FakeProcessor();
  const seller = new TestSeller({ processor, resourceUrl: `${BASE}/compute/provision`, now, activeAfterSec });
  const payer = fakePayer();
  const fetch = inProcess(seller);
  const client = new SellerClient(SELLERS.test, { fetch, signer: payer.signer, now, sleep: async () => {} });
  const pay = vi.fn((required: PaymentRequired, accepts: Accepts) => {
    void accepts;
    return payer.payHeaders(required);
  });
  return { seller, processor, payer, client, pay, fetch, advance: (ms: number) => (t += ms), now };
}

async function candidate(client: SellerClient, id = "vc2-1c-1gb"): Promise<Candidate> {
  const { offers } = await client.catalog();
  const offer = offers.find((o) => o.id === id)!;
  return { offer, regions: offer.regions, hours: 1, estimateUsd: offer.hourlyUsd * 1.15 };
}

const provisionBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ plan: "vc2-1c-1gb", region: "ewr", os_id: 2284, label: "agent-rental", prepaid_hours: 1, ssh_public_key: "k", network: "solana", max_total_usd: 1, ...over });
const post = (body: string, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/compute/provision`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

describe("TestSeller catalog", () => {
  it("serves the plans feed that SellerClient parses, plus regions and os", async () => {
    const { client, seller } = setup();
    const { offers, rules, skipped } = await client.catalog();
    expect(offers.length).toBeGreaterThan(5);
    expect(skipped).toBe(0);
    expect(offers.find((o) => o.id === "vc2-1c-1gb")).toMatchObject({ seller: "testseller", hourlyUsd: 0.009027 });
    expect(rules.surchargePct).toEqual({ machine: 15, gpu: 20 });
    const regions = await (await seller.handle(new Request(`${BASE}/compute/regions`))).json();
    expect(regions.regions.length).toBeGreaterThan(0);
    const os = await (await seller.handle(new Request(`${BASE}/compute/os`))).json();
    expect(os.os.map((o: { id: unknown }) => o.id)).toEqual(expect.arrayContaining([2284, "ubuntu-24-04-x64"]));
  });
});

describe("TestSeller provisioning", () => {
  it("quotes hourly x hours x surcharge, provisions, and turns active after polling", async () => {
    const { client, pay, processor, advance, seller, payer } = setup();
    const q = await client.quote(await candidate(client), "ewr", opts);
    expect(q.atomic).toBe(String(Math.ceil(0.009027 * 1.15 * 1e6)));
    expect(q.accepts.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");

    const out = await client.provision(q, pay);
    expect(out.kind).toBe("pending");
    if (out.kind !== "pending") throw new Error("unreachable");
    expect(out.tx).toBe("tx-1");
    expect(out.instance.ip).toBeNull();
    expect(processor.settled).toBe(1);
    expect(seller.machines.get(out.instance.id)?.owner).toBe(payer.address);

    advance(3000);
    const live = await client.instance(out.instance.id);
    expect(live).toMatchObject({ id: out.instance.id, status: "active", plan: "vc2-1c-1gb", region: "ewr" });
    expect(live?.ip).toMatch(/^203\.0\.113\.\d+$/);
    expect(live?.expiresAt).toBe((T0 + 3600_000) / 1000);
  });

  it("is active straight away when activeAfterSec is 0", async () => {
    const { client, pay } = setup(0);
    const out = await client.provision(await client.quote(await candidate(client), "ewr", opts), pay);
    expect(out.kind).toBe("active");
  });

  it("applies the gpu surcharge and rejects unknown plans and regions", async () => {
    const { seller } = setup();
    const gpu = await seller.handle(post(provisionBody({ plan: "runpod-rtx-3090-24g", region: "runpod", prepaid_hours: 2, os_id: undefined, max_total_usd: 5 })));
    expect(gpu.status).toBe(402);
    const required = JSON.parse(Buffer.from(gpu.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
    expect(required.accepts[0].amount).toBe(String(Math.round(0.65 * 2 * 1.2 * 1e6)));
    expect((await seller.handle(post(provisionBody({ plan: "runpod-rtx-3090-24g", region: "runpod", prepaid_hours: 1, max_total_usd: 5 })))).status).toBe(400);
    expect((await seller.handle(post(provisionBody({ plan: "nope" })))).status).toBe(400);
    expect((await seller.handle(post(provisionBody({ region: "mars" })))).status).toBe(400);
    expect((await seller.handle(post("not json"))).status).toBe(400);
  });

  it("answers 409 with quote_usd above max_total_usd", async () => {
    const { client } = setup();
    const err = await client.quote(await candidate(client), "ewr", { ...opts, maxTotalUsd: 0.001 }).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteError);
    expect(err.code).toBe("PRICE_CAP");
  });

  it("rejects a payment that fails verification with 402 and does not settle", async () => {
    const { seller, processor } = setup();
    const header = Buffer.from(JSON.stringify({ bad: true, payer: "x" })).toString("base64");
    const r = await seller.handle(post(provisionBody(), { "PAYMENT-SIGNATURE": header }));
    expect(r.status).toBe(402);
    expect(processor.settled).toBe(0);
  });

  it("replaying the same PAYMENT-SIGNATURE returns the same order and settles once", async () => {
    const { seller, processor, payer } = setup();
    const unpaid = await seller.handle(post(provisionBody()));
    const required = JSON.parse(Buffer.from(unpaid.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
    const headers = await payer.payHeaders(required);
    const a = await (await seller.handle(post(provisionBody(), headers))).json();
    const b = await (await seller.handle(post(provisionBody(), headers))).json();
    expect(a.success).toBe(true);
    expect(b.order.id).toBe(a.order.id);
    expect(b.tx_hash).toBe(a.tx_hash);
    expect(processor.settled).toBe(1);
    expect(seller.machines.size).toBe(1);
  });

  async function paidHeaders(s: ReturnType<typeof setup>) {
    const unpaid = await s.seller.handle(post(provisionBody()));
    return s.payer.payHeaders(JSON.parse(Buffer.from(unpaid.headers.get("PAYMENT-REQUIRED")!, "base64").toString()));
  }

  it("two concurrent paid requests with the same signature settle once and return the same order", async () => {
    const s = setup();
    const headers = await paidHeaders(s);
    const [a, b] = await Promise.all([s.seller.handle(post(provisionBody(), headers)), s.seller.handle(post(provisionBody(), headers))]);
    const [ja, jb] = [await a.json(), await b.json()];
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(jb.order.id).toBe(ja.order.id);
    expect(s.processor.settled).toBe(1);
    expect(s.seller.machines.size).toBe(1);
  });

  it("a concurrent duplicate of a 503-once attempt is retried, still one settle", async () => {
    const s = setup();
    s.seller.faults = { ...NO_FAULTS, fail5xxOnce: true };
    const headers = await paidHeaders(s);
    const [a, b] = await Promise.all([s.seller.handle(post(provisionBody(), headers)), s.seller.handle(post(provisionBody(), headers))]);
    expect([a.status, b.status]).toEqual([503, 200]);
    expect(s.processor.settled).toBe(1);
  });

  it("the same signature with a different body is refused with 402 and not settled", async () => {
    const s = setup();
    const headers = await paidHeaders(s);
    expect((await s.seller.handle(post(provisionBody(), headers))).status).toBe(200);
    const other = await s.seller.handle(post(provisionBody({ region: "ord" }), headers));
    expect(other.status).toBe(402);
    expect(s.processor.settled).toBe(1);
    expect(s.seller.machines.size).toBe(1);
  });
});

describe("TestSeller faults", () => {
  it("out-of-stock region gives OUT_OF_STOCK", async () => {
    const { client, seller } = setup();
    seller.faults = { ...NO_FAULTS, outOfStockRegions: ["ewr"] };
    const err = await client.quote(await candidate(client), "ewr", opts).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteError);
    expect(err.code).toBe("OUT_OF_STOCK");
    await expect(client.quote(await candidate(client), "ord", opts)).resolves.toMatchObject({ region: "ord" });
  });

  it("quote bump makes the fresh 402 higher than the quote", async () => {
    const { client, seller } = setup();
    seller.faults = { ...NO_FAULTS, quoteBumpPct: 20 };
    const q = await client.quote(await candidate(client), "ewr", opts);
    const pay = vi.fn(async (required: PaymentRequired, accepts: Accepts) => {
      void required;
      void accepts;
      return { refused: "OVER_QUOTE" };
    });
    const out = await client.provision(q, pay);
    expect(out).toMatchObject({ kind: "not_charged", code: "REFUSED_BY_GUARD" });
    const fresh = pay.mock.calls[0][1];
    expect(BigInt(fresh.amount) > BigInt(q.atomic)).toBe(true);
  });

  it("wrong asset is visible in the quote", async () => {
    const { client, seller } = setup();
    seller.faults = { ...NO_FAULTS, wrongAsset: true };
    const q = await client.quote(await candidate(client), "ewr", opts);
    expect(q.accepts.asset).toBe("So11111111111111111111111111111111111111112");
  });

  it("first paid call answers 503, the resend succeeds, one payment and one settle", async () => {
    const { client, seller, pay, processor, payer } = setup(0);
    seller.faults = { ...NO_FAULTS, fail5xxOnce: true };
    const out = await client.provision(await client.quote(await candidate(client), "ewr", opts), pay);
    expect(out.kind).toBe("active");
    expect(processor.settled).toBe(1);
    expect(payer.calls).toBe(1);
    expect(seller.faults.fail5xxOnce).toBe(false);
  });

  it("202 gives pending", async () => {
    const { client, seller, pay, processor } = setup(0);
    seller.faults = { ...NO_FAULTS, pending202: true };
    const out = await client.provision(await client.quote(await candidate(client), "ewr", opts), pay);
    expect(out.kind).toBe("pending");
    expect(processor.settled).toBe(1);
  });

  it("409 settlement_pending gives unknown and the machine shows in instances()", async () => {
    const { client, seller, pay, processor } = setup();
    seller.faults = { ...NO_FAULTS, settlementPending409: true };
    const out = await client.provision(await client.quote(await candidate(client), "ewr", opts), pay);
    expect(out.kind).toBe("unknown");
    expect(processor.settled).toBe(1);
    const list = await client.instances();
    expect(list).toHaveLength(1);
    expect(list[0].plan).toBe("vc2-1c-1gb");
  });

  it("settleThenReject keeps the money, builds nothing and answers 402 with a fresh requirement", async () => {
    const { client, seller, pay, processor, payer } = setup(0);
    seller.faults = { ...NO_FAULTS, settleThenReject: true };
    const q = await client.quote(await candidate(client), "ewr", opts);
    const out = await client.provision(q, pay);
    expect(out).toMatchObject({ kind: "not_charged", code: "PAYMENT_REJECTED" });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(processor.settled).toBe(1);
    expect(seller.machines.size).toBe(0);
    expect(seller.settlements).toEqual([{ at: T0, usd: Number(q.atomic) / 1e6, payer: payer.address, plan: "vc2-1c-1gb", region: "ewr" }]);
    // the raw answer carries a new PAYMENT-REQUIRED header, as a real rejection would
    const signed = (await pay.mock.results[0].value) as Record<string, string>;
    const raw = await seller.handle(post(q.body, signed));
    expect(raw.status).toBe(402);
    expect(raw.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(seller.settlements).toHaveLength(2);
  });

  it("records every settle in the ledger, whatever the answer", async () => {
    const { client, seller, pay } = setup();
    seller.faults = { ...NO_FAULTS, settlementPending409: true };
    await client.provision(await client.quote(await candidate(client), "ewr", opts), pay);
    expect(seller.settlements).toHaveLength(1);
    expect(seller.machines.size).toBe(1);
  });
});

describe("TestSeller machine management", () => {
  async function rented() {
    const s = setup();
    const out = await s.client.provision(await s.client.quote(await candidate(s.client), "ewr", opts), s.pay);
    if (out.kind !== "pending") throw new Error(`expected pending, got ${out.kind}`);
    return { ...s, id: out.instance.id };
  }

  it("another wallet cannot see or delete the machine", async () => {
    const { fetch, now, id, seller, client } = await rented();
    const other = new SellerClient(SELLERS.test, { fetch, signer: fakePayer().signer, now });
    expect(await other.instance(id)).toBeNull();
    expect(await other.instances()).toEqual([]);
    await other.destroy(id); // 404 counts as done for the client
    expect(seller.machines.get(id)?.destroyed).toBe(false);
    expect(await client.instance(id)).not.toBeNull();
  });

  it("destroy hides the machine", async () => {
    const { client, id, seller } = await rented();
    await client.destroy(id);
    expect(seller.machines.get(id)?.destroyed).toBe(true);
    expect(await client.instance(id)).toBeNull();
    expect(await client.instances()).toEqual([]);
  });

  it("rejects bad auth and reused nonces with 401", async () => {
    const { seller, payer, now } = await rented();
    const path = "/compute/instances";
    expect((await seller.handle(new Request(`${BASE}${path}`))).status).toBe(401);
    const headers = await authHeaders(payer.signer, { method: "GET", path, body: "", now, nonce: () => "ab".repeat(16) });
    expect((await seller.handle(new Request(`${BASE}${path}`, { headers }))).status).toBe(200);
    expect((await seller.handle(new Request(`${BASE}${path}`, { headers }))).status).toBe(401);
    const wrongPath = await authHeaders(payer.signer, { method: "GET", path: "/api/testseller/compute/instances", body: "", now });
    expect((await seller.handle(new Request(`${BASE}${path}`, { headers: wrongPath }))).status).toBe(401);
  });
});

describe("TestSeller fault control", () => {
  afterEach(() => vi.unstubAllEnvs());
  const faultsReq = (url: string, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
  const URL_ = `${BASE}/compute/_faults`;

  it("accepts a partial Faults from a local host and returns the current ones", async () => {
    const { seller } = setup();
    const r = await seller.handle(faultsReq(`${BASE}/compute/_faults`, { pending202: true, outOfStockRegions: ["ewr"] }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ...NO_FAULTS, pending202: true, outOfStockRegions: ["ewr"] });
    expect(seller.faults.pending202).toBe(true);
    expect((await seller.handle(faultsReq(`${BASE}/compute/_faults`, { pending202: "yes" }))).status).toBe(400);
  });

  it("refuses a non-local Host with 403", async () => {
    const { seller } = setup();
    const r = await seller.handle(faultsReq("http://evil.example/api/testseller/compute/_faults", { pending202: true }));
    expect(r.status).toBe(403);
    expect(seller.faults.pending202).toBe(false);
  });

  it("refuses a spoofed localhost Host with a foreign Origin (403) and a non-JSON content type (415)", async () => {
    const { seller } = setup();
    const evil = await seller.handle(faultsReq(URL_, { pending202: true }, { "Content-Type": "application/json", Origin: "http://evil.example" }));
    expect(evil.status).toBe(403);
    const wrongPort = await seller.handle(faultsReq(URL_, { pending202: true }, { "Content-Type": "application/json", Origin: "http://localhost:4000" }));
    expect(wrongPort.status).toBe(403);
    expect((await seller.handle(faultsReq(URL_, { pending202: true }, { "Content-Type": "text/plain" }))).status).toBe(415);
    expect((await seller.handle(faultsReq(URL_, { pending202: true }, {}))).status).toBe(415);
    expect(seller.faults.pending202).toBe(false);
    const ok = await seller.handle(faultsReq(URL_, { pending202: true }, { "Content-Type": "application/json; charset=utf-8", Origin: "http://localhost:3000" }));
    expect(ok.status).toBe(200);
  });

  it("is 404 in production", async () => {
    const { seller } = setup();
    vi.stubEnv("NODE_ENV", "production");
    expect((await seller.handle(faultsReq(URL_, { pending202: true }))).status).toBe(404);
    expect(seller.faults.pending202).toBe(false);
  });

  it("rejects quoteBumpPct outside 0..100", async () => {
    const { seller } = setup();
    expect((await seller.handle(faultsReq(URL_, { quoteBumpPct: -1 }))).status).toBe(400);
    expect((await seller.handle(faultsReq(URL_, { quoteBumpPct: 101 }))).status).toBe(400);
    expect((await seller.handle(faultsReq(URL_, { quoteBumpPct: 100 }))).status).toBe(200);
  });

  it("a successful update resets the quote-bump counters", async () => {
    const { seller } = setup();
    const amount = async () => JSON.parse(Buffer.from((await seller.handle(post(provisionBody()))).headers.get("PAYMENT-REQUIRED")!, "base64").toString()).accepts[0].amount;
    const base = await amount();
    expect((await seller.handle(faultsReq(URL_, { quoteBumpPct: 20 }))).status).toBe(200);
    expect(await amount()).toBe(base); // first unpaid call after the reset is fresh
    expect(Number(await amount())).toBeGreaterThan(Number(base));
  });
});

describe("getTestSeller", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is null without SOLANA_RECEIVER_ADDRESS and a singleton with it", () => {
    vi.stubEnv("SOLANA_RECEIVER_ADDRESS", "");
    expect(getTestSeller()).toBeNull();
    vi.stubEnv("SOLANA_RECEIVER_ADDRESS", "Receiver11111111111111111111111111111111111");
    const a = getTestSeller();
    expect(a).toBeInstanceOf(TestSeller);
    expect(getTestSeller()).toBe(a);
  });
});
