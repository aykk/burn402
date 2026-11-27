import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { BASE_SEPOLIA, X402Processor, type PaymentProcessor } from "../x402/processor";
import { verifyAuth } from "./auth";
import { isEvmAddress, verifyWalletAuth } from "./evm";
import plansFeed from "./fixtures/plans.sample.json";
import { defaultJournal } from "./journal";

/**
 * A local stand-in for compute.x402layer.cc. Same paths, same 402 header, same X-Auth-* checks;
 * payments settle through the given processor (devnet in the app), machines are simulated.
 */

export type Faults = { outOfStockRegions: string[]; quoteBumpPct: number; wrongAsset: boolean; fail5xxOnce: boolean; pending202: boolean; settlementPending409: boolean; settleThenReject: boolean };

export const NO_FAULTS: Faults = { outOfStockRegions: [], quoteBumpPct: 0, wrongAsset: false, fail5xxOnce: false, pending202: false, settlementPending409: false, settleThenReject: false };

export type Machine = { id: string; owner: string; plan: string; region: string; ip: string; createdAt: number; expiresAt: number; destroyed: boolean };

/** One payment the seller settled, whatever it answered afterwards. */
export type Settlement = { at: number; usd: number; payer: string | null; plan: string; region: string };

type Obj = Record<string, unknown>;
type Settled = { machineId: string; tx: string };
type Plan = { id: string; provider: string; our_hourly: number; locations?: string[] | null; is_gpu?: boolean; gpu_type?: string | null; gpu_vram_gb?: number | null };

const WRONG_ASSET = "So11111111111111111111111111111111111111112";
const MAX_SKEW_MS = 300_000;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const LOCAL_ORIGINS = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);

const PLANS = plansFeed.plans as Plan[];
const RULES = plansFeed.hourly;

const REGIONS = [...new Set(PLANS.flatMap((p) => (p.locations ?? []).map((l) => `${p.provider}:${l}`)))].map((key) => {
  const [provider, id] = key.split(":");
  return { id, city: id, provider };
});
const OS = [
  { id: 2284, name: "Ubuntu 24.04 LTS x64", family: "ubuntu", provider: "vultr" },
  { id: "ubuntu-24-04-x64", name: "Ubuntu 24.04 (LTS) x64", family: "ubuntu", provider: "digitalocean" },
];

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const isGpu = (p: Plan) => p.is_gpu === true || !!p.gpu_type || (p.gpu_vram_gb ?? 0) > 0;
const regionsOf = (p: Plan) => p.locations ?? (p.provider === "runpod" ? ["runpod"] : []);

function parseFaults(raw: unknown): Partial<Faults> | null {
  if (!isObj(raw)) return null;
  const out: Partial<Faults> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "outOfStockRegions") {
      if (!Array.isArray(v) || !v.every((r) => typeof r === "string")) return null;
      out.outOfStockRegions = v;
    } else if (k === "quoteBumpPct") {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) return null;
      out.quoteBumpPct = v;
    } else if (k === "wrongAsset" || k === "fail5xxOnce" || k === "pending202" || k === "settlementPending409" || k === "settleThenReject") {
      if (typeof v !== "boolean") return null;
      out[k] = v;
    } else {
      return null;
    }
  }
  return out;
}

export class TestSeller {
  faults: Faults = { ...NO_FAULTS };
  readonly machines = new Map<string, Machine>();
  /** Every successful settle, appended before the response is chosen. */
  readonly settlements: Settlement[] = [];

  private readonly processor: PaymentProcessor;
  /** takes USDC on Base's test network from Ethereum wallets; absent when no receiver is set for it */
  private readonly baseProcessor: PaymentProcessor | null;
  private readonly resourceUrl: string;
  private readonly now: () => number;
  private readonly activeAfterMs: number;
  /** unpaid 402s answered per request body */
  private readonly quotes = new Map<string, number>();
  /** the requirement last advertised per request body; the paid request is checked against it */
  private readonly advertised = new Map<string, PaymentRequirements>();
  /**
   * Paid requests by PAYMENT-SIGNATURE header, registered before any await so a concurrent
   * duplicate waits for the first instead of settling again. `result` is null when the first
   * attempt did not settle (the entry is then removed so a resend can try again).
   */
  private readonly paid = new Map<string, { body: string; result: Promise<Settled | null> }>();
  private readonly nonces = new Map<string, number>();
  private counter = 0;

  constructor(o: { processor: PaymentProcessor; baseProcessor?: PaymentProcessor | null; resourceUrl: string; now?: () => number; activeAfterSec?: number }) {
    this.processor = o.processor;
    this.baseProcessor = o.baseProcessor ?? null;
    this.resourceUrl = o.resourceUrl;
    this.now = o.now ?? Date.now;
    this.activeAfterMs = (o.activeAfterSec ?? 3) * 1000;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const at = url.pathname.indexOf("/compute");
    if (at < 0) return json(404, { error: "not found" });
    const path = url.pathname.slice(at); // the path the wallet signs
    const method = request.method.toUpperCase();
    const instance = /^\/compute\/instances\/([^/]+)$/.exec(path);

    if (path === "/compute/plans" && method === "GET") return json(200, plansFeed);
    if (path === "/compute/regions" && method === "GET") return json(200, { regions: REGIONS });
    if (path === "/compute/os" && method === "GET") return json(200, { os: OS });
    if (path === "/compute/provision" && method === "POST") return this.provision(request);
    if (path === "/compute/_faults" && method === "POST") return this.setFaults(request, url);
    if (path === "/compute/instances" && method === "GET") {
      const auth = await this.auth(request, path);
      if (!auth.ok) return json(401, { error: auth.reason });
      return json(200, { instances: [...this.machines.values()].filter((m) => !m.destroyed && m.owner === auth.address).map((m) => this.view(m)) });
    }
    if (instance && (method === "GET" || method === "DELETE")) {
      const auth = await this.auth(request, path);
      if (!auth.ok) return json(401, { error: auth.reason });
      let id: string;
      try {
        id = decodeURIComponent(instance[1]);
      } catch {
        return json(404, { error: "instance not found" });
      }
      const m = this.machines.get(id);
      if (!m || m.destroyed || m.owner !== auth.address) return json(404, { error: "instance not found" });
      if (method === "GET") return json(200, { instance: this.view(m) });
      m.destroyed = true;
      return json(200, { success: true, id: m.id });
    }
    return json(404, { error: "not found" });
  }

  private async auth(request: Request, path: string): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
    const body = await request.text();
    const nowMs = this.now();
    const check = { method: request.method.toUpperCase(), path, body, nowMs, maxSkewMs: MAX_SKEW_MS };
    // like the real seller: a Solana wallet signs in with its key, an Ethereum wallet ("base") with a signed message
    const result = request.headers.get("X-Auth-Chain") === "base" ? await verifyWalletAuth(request.headers, check) : verifyAuth(request.headers, check);
    if (!result.ok) return result;
    for (const [n, ts] of this.nonces) if (nowMs - ts > 2 * MAX_SKEW_MS) this.nonces.delete(n);
    const nonce = request.headers.get("X-Auth-Nonce")!;
    if (this.nonces.has(nonce)) return { ok: false, reason: "nonce already used" };
    this.nonces.set(nonce, nowMs);
    return result;
  }

  private async setFaults(request: Request, url: URL): Promise<Response> {
    if (process.env.NODE_ENV === "production") return json(404, { error: "not found" });
    const host = request.headers.get("host") ?? url.host;
    if (!LOCAL_HOST.test(host)) return json(403, { error: "fault control is local only" });
    // a web page can send a simple cross-site POST; it always carries Origin and cannot send JSON without a preflight
    const origin = request.headers.get("origin");
    if (origin !== null && !LOCAL_ORIGINS.has(origin)) return json(403, { error: "fault control is local only" });
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return json(415, { error: "Content-Type must be application/json" });
    }
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json(400, { error: "body must be JSON" });
    }
    const partial = parseFaults(raw);
    if (!partial) return json(400, { error: "body must be a partial Faults object" });
    this.faults = { ...this.faults, ...partial };
    this.quotes.clear();
    return json(200, this.faults);
  }

  private async provision(request: Request): Promise<Response> {
    return this.provisionText(await request.text(), request.headers.get("PAYMENT-SIGNATURE"));
  }

  /** No await may sit between the replay check and registering the paid request below. */
  private async provisionText(text: string, signature: string | null): Promise<Response> {
    const prior = signature ? this.paid.get(signature) : undefined;
    if (prior && signature) {
      if (prior.body !== text) return json(402, { error: "payment was already used for a different request" });
      const done = await prior.result;
      if (done) return this.orderResponse(200, done.machineId, done.tx);
      return this.provisionText(text, signature);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "body must be JSON" });
    }
    if (!isObj(body)) return json(400, { error: "body must be a JSON object" });
    const plan = PLANS.find((p) => p.id === body.plan);
    if (!plan) return json(400, { error: `unknown plan ${String(body.plan)}` });
    const region = typeof body.region === "string" ? body.region : "";
    if (!regionsOf(plan).includes(region)) return json(400, { error: `plan ${plan.id} is not offered in ${region || "that region"}` });
    const kind = isGpu(plan) ? "gpu" : "machine";
    const hours = body.prepaid_hours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < RULES.min_hours_by_kind[kind]) {
      return json(400, { error: `prepaid_hours must be a whole number of at least ${RULES.min_hours_by_kind[kind]}` });
    }
    if (this.faults.outOfStockRegions.includes(region)) return json(503, { error: `plan is out of stock in ${region}` });
    // the order names the network it will be paid on, as with the real seller: "base" is USDC from an Ethereum wallet
    const processor = body.network === "base" ? this.baseProcessor : this.processor;
    if (!processor) return json(400, { error: "this seller is not set up to be paid on base" });

    if (!signature) return this.quote(text, body, plan, region, hours, kind, processor);

    let finish!: (s: Settled | null) => void;
    this.paid.set(signature, { body: text, result: new Promise((resolve) => (finish = resolve)) });
    let settled: Settled | null = null;
    try {
      const out = await this.settlePaid(text, signature, plan, region, hours, kind, processor);
      settled = out.settled;
      return out.response;
    } finally {
      if (!settled) this.paid.delete(signature);
      finish(settled);
    }
  }

  private priceUsd(plan: Plan, hours: number, kind: "gpu" | "machine"): number {
    const surcharge = hours < RULES.surcharge_below_hours ? 1 + RULES.surcharge_pct[kind] / 100 : 1;
    return plan.our_hourly * hours * surcharge;
  }

  private async quote(text: string, body: Obj, plan: Plan, region: string, hours: number, kind: "gpu" | "machine", processor: PaymentProcessor): Promise<Response> {
    const seen = (this.quotes.get(text) ?? 0) + 1;
    this.quotes.set(text, seen);
    let usd = this.priceUsd(plan, hours, kind);
    if (seen >= 2 && this.faults.quoteBumpPct) usd *= 1 + this.faults.quoteBumpPct / 100;

    const requirements = await processor.requirements(usd);
    const quoteUsd = Number(requirements.amount) / 1e6;
    if (typeof body.max_total_usd === "number" && quoteUsd > body.max_total_usd) {
      return json(409, { error: `quote $${quoteUsd} is above max_total_usd $${body.max_total_usd}`, quote_usd: quoteUsd });
    }
    const advertised = this.faults.wrongAsset ? { ...requirements, asset: WRONG_ASSET } : requirements;
    this.advertised.set(text, advertised);
    const header = await processor.paymentRequiredHeader(advertised, this.resourceUrl, `${plan.id} in ${region}, ${hours}h prepaid`);
    return json(402, { error: "payment required", quote_usd: quoteUsd }, { "PAYMENT-REQUIRED": header });
  }

  private async settlePaid(
    text: string,
    signature: string,
    plan: Plan,
    region: string,
    hours: number,
    kind: "gpu" | "machine",
    processor: PaymentProcessor,
  ): Promise<{ response: Response; settled: Settled | null }> {
    const fail = (response: Response) => ({ response, settled: null });
    const requirements = this.advertised.get(text) ?? (await processor.requirements(this.priceUsd(plan, hours, kind)));
    let payload: PaymentPayload;
    try {
      payload = processor.decode(signature);
    } catch {
      return fail(json(402, { error: "payment header could not be decoded" }));
    }
    const verified = await processor.verify(payload, requirements);
    if (!verified.ok) return fail(json(402, { error: "payment rejected", reason: verified.reason }));

    if (this.faults.fail5xxOnce) {
      this.faults = { ...this.faults, fail5xxOnce: false };
      return fail(json(503, { error: "temporary failure, nothing was charged" }));
    }

    const settlement = await processor.settle(payload, requirements);
    if (!settlement.ok) return fail(json(402, { error: "settlement failed", reason: settlement.reason }));
    this.settlements.push({ at: this.now(), usd: Number(requirements.amount) / 1e6, payer: settlement.payer, plan: plan.id, region });

    if (this.faults.settleThenReject) {
      // dishonest: keep the money, build nothing, and ask to be paid again as if the payment had been rejected
      const again = await processor.requirements(this.priceUsd(plan, hours, kind));
      const header = await processor.paymentRequiredHeader(again, this.resourceUrl, `${plan.id} in ${region}, ${hours}h prepaid`);
      return fail(json(402, { error: "payment rejected" }, { "PAYMENT-REQUIRED": header }));
    }

    const n = ++this.counter;
    const createdAt = this.now();
    const machine: Machine = {
      id: `tsm-${n}`,
      // an Ethereum address is the same in any letter case; its owner signs in with it in lower case
      owner: isEvmAddress(settlement.payer) ? settlement.payer.toLowerCase() : (settlement.payer ?? ""),
      plan: plan.id,
      region,
      ip: `203.0.113.${((n - 1) % 254) + 1}`,
      createdAt,
      expiresAt: createdAt + hours * 3600_000,
      destroyed: false,
    };
    this.machines.set(machine.id, machine);
    const settled = { machineId: machine.id, tx: settlement.tx };

    if (this.faults.settlementPending409) return { response: json(409, { error: "settlement_pending", code: "settlement_pending" }), settled };
    if (this.faults.pending202) return { response: json(202, { pending: true, order: this.view(machine) }), settled };
    return { response: this.orderResponse(200, machine.id, settlement.tx), settled };
  }

  private orderResponse(status: number, machineId: string, tx: string): Response {
    return json(status, { success: true, order: this.view(this.machines.get(machineId)!), tx_hash: tx });
  }

  private view(m: Machine) {
    const active = this.now() - m.createdAt >= this.activeAfterMs;
    return {
      id: m.id,
      plan: m.plan,
      region: m.region,
      status: m.destroyed ? "destroyed" : active ? "active" : "pending",
      ip_address: active && !m.destroyed ? m.ip : "",
      expires_at: new Date(m.expiresAt).toISOString(),
    };
  }
}

type Holder = { seller: TestSeller | null };
const holder = ((globalThis as unknown as { __burn402TestSeller?: Holder }).__burn402TestSeller ??= { seller: null });

/** The app's test seller, paid at SOLANA_RECEIVER_ADDRESS on devnet. Null when that is unset. */
/**
 * The test seller's machines live in this process's memory. When a new one starts, every test-market
 * purchase the journal still lists as open belongs to a seller that is gone, machine and all, so it is
 * closed here instead of sitting on the open purchases list for ever.
 */
function releaseStalePurchases(): void {
  try {
    const journal = defaultJournal();
    for (const o of journal.open()) {
      if (o.market !== "test") continue;
      journal.append({ at: Date.now(), run: o.run, market: o.market, seller: o.seller, event: "released", plan: o.plan, region: o.region, usd: o.usd, tx: o.tx, instance: o.instance, detail: "the test seller restarted; its simulated machine is gone" });
    }
  } catch {
    // the journal is checked again by the open purchases list; a failure here must not stop the seller
  }
}

export function getTestSeller(): TestSeller | null {
  // a stand-in for testing: a production build has no test seller unless it is switched on (the public demo runs on it)
  if (process.env.NODE_ENV === "production" && process.env.BURN402_TEST_SELLER !== "1") return null;
  const payTo = process.env.SOLANA_RECEIVER_ADDRESS;
  if (!payTo) return null;
  if (!holder.seller) {
    // with a receiver set for Base's test network, the test seller also takes USDC from Ethereum wallets there
    const basePayTo = process.env.BASE_RECEIVER_ADDRESS;
    holder.seller = new TestSeller({
      processor: new X402Processor({ payTo }),
      baseProcessor: isEvmAddress(basePayTo) ? new X402Processor({ payTo: basePayTo, network: BASE_SEPOLIA }) : null,
      resourceUrl: "http://127.0.0.1:3000/api/testseller/compute/provision",
    });
    releaseStalePurchases();
  }
  return holder.seller;
}
