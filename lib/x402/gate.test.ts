import { exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { audit } from "../auditor";
import { Broker, FakeResource } from "../burn";
import { kidFor, mandateHash, MandateRegistry, signMandate, toCompact, type Mandate, type SigningKey } from "../mandate";
import { ProvisionGate, receiptVerifier, signProvisionRequest, type GateEvent, type PaymentProcessor, type Settlement } from "./index";

const HUMAN = "did:web:alice.burn402.xyz";
const OPS = "ans://v1.0.0.ops.burn402.xyz";
const AGENT = "ans://v1.0.0.worker.burn402.xyz";
const OTHER = "ans://v1.0.0.other.burn402.xyz";
const BROKER = "ans://v1.0.0.broker.burn402.xyz";
const PAY_TO = "HZ79Dka8mEmwggtUYCj5rjVzstfwyCzT2tyFeS7FhDAm";
const NOW = 1789800000;

type Actor = { signing: SigningKey; publicJwk: JWK };

async function actor(): Promise<Actor> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), use: "sig" };
  return { signing: { privateKey, kid: await kidFor(publicJwk) }, publicJwk };
}

const human = await actor();
const ops = await actor();
const agent = await actor();
const other = await actor();
const broker = await actor();
const agentKeys: Record<string, JWK[]> = { [OPS]: [ops.publicJwk], [AGENT]: [agent.publicJwk], [OTHER]: [other.publicJwk], [BROKER]: [broker.publicJwk] };
const resolve = async (iss: string) => agentKeys[iss] ?? [];

class FakeProcessor implements PaymentProcessor {
  requirementsCalls = 0;
  settleCalls = 0;
  verifyOk = true;
  settleOk = true;

  async requirements(usd: number): Promise<PaymentRequirements> {
    this.requirementsCalls++;
    return { scheme: "exact", network: "solana:devnet", amount: String(Math.round(usd * 1e6)), asset: "USDC", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: {} } as PaymentRequirements;
  }
  async paymentRequiredHeader(r: PaymentRequirements) {
    return Buffer.from(JSON.stringify({ accepts: [r] })).toString("base64");
  }
  decode(header: string): PaymentPayload {
    return JSON.parse(Buffer.from(header, "base64").toString()) as PaymentPayload;
  }
  async verify(payload: PaymentPayload, r: PaymentRequirements) {
    const p = payload as unknown as { amount: string };
    if (!this.verifyOk || p.amount !== r.amount) return { ok: false as const, reason: "amount mismatch" };
    return { ok: true as const };
  }
  async settle(): Promise<Settlement> {
    this.settleCalls++;
    return this.settleOk ? { ok: true, tx: "5TxSig".padEnd(88, "x"), payer: "2AQwhUNFFJ2saGkEy1m2Mw7yeDqi9jnpqyJ7ShduZgxF", network: "solana:devnet" } : { ok: false, reason: "blockhash expired" };
  }
  responseHeader(s: Settlement) {
    return Buffer.from(JSON.stringify(s)).toString("base64");
  }
}

let registry: MandateRegistry;
let resource: FakeResource;
let processor: FakeProcessor;
let gate: ProvisionGate;
let events: GateEvent[];
let chain: string[];
let leafHash: string;
let counter = 0;

function mandate(overrides: Partial<Mandate>): Mandate {
  return {
    jti: `m_${++counter}`,
    iss: HUMAN,
    sub: OPS,
    aud: OPS,
    parent: null,
    depth: 0,
    max_depth: 3,
    scope: ["compute:provision"],
    limit_usd: 1,
    rate_usd_hr: 0.06,
    nbf: NOW - 60,
    exp: NOW + 86400,
    ...overrides,
  };
}

async function buildChain(leafOverrides: Partial<Mandate> = {}): Promise<string[]> {
  const root = toCompact(await signMandate(mandate({}), human.signing));
  const leaf = toCompact(
    await signMandate(mandate({ iss: OPS, sub: AGENT, aud: AGENT, parent: mandateHash(root), depth: 1, ...leafOverrides }), ops.signing),
  );
  return [root, leaf];
}

async function post(options: { plan?: string; signer?: Actor; iss?: string; mandate?: string; iat?: number; jti?: string; payment?: unknown; body?: unknown } = {}) {
  const request = await signProvisionRequest(
    { iss: options.iss ?? AGENT, mandate: options.mandate ?? leafHash, plan: options.plan ?? "vcg-a16-2c-8g-2vram", region: "ewr", iat: options.iat ?? NOW, jti: options.jti },
    (options.signer ?? agent).signing,
  );
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.payment !== undefined) headers["PAYMENT-SIGNATURE"] = Buffer.from(JSON.stringify(options.payment)).toString("base64");
  return gate.handle(new Request("http://broker.local/provision", { method: "POST", headers, body: JSON.stringify(options.body ?? { chain, request }) }));
}

beforeEach(async () => {
  events = [];
  registry = new MandateRegistry({
    resolveAgentKeys: resolve,
    resolveRootKeys: async (iss) => (iss === HUMAN ? [human.publicJwk] : []),
    isAnchored: async () => true,
    now: () => NOW,
  });
  resource = new FakeResource({ "vcg-a16-2c-8g-2vram": 0.059, "vcg-a16-2c-16g-4vram": 0.118 }, () => NOW);
  processor = new FakeProcessor();
  const b = new Broker({ registry, resource, now: () => NOW });
  gate = new ProvisionGate({
    registry,
    broker: b,
    processor,
    resolveAgentKeys: resolve,
    brokerName: BROKER,
    brokerKey: broker.signing,
    payTo: PAY_TO,
    resourceUrl: "http://broker.local/provision",
    now: () => NOW,
    onEvent: (e) => events.push(e),
  });
  chain = await buildChain();
  leafHash = mandateHash(chain[1]);
});

describe("x402 provision gate", () => {
  it("asks for payment priced at plan rate x prepaid hours, without provisioning", async () => {
    const res = await post();
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(await res.json()).toMatchObject({ plan: "vcg-a16-2c-8g-2vram", hourly_usd: 0.059, prepay_hours: 1, usd: 0.059 });
    expect(resource.running()).toHaveLength(0);
  });

  it("prices a longer prepay window proportionally", async () => {
    gate = new ProvisionGate({
      registry,
      broker: new Broker({ registry, resource, now: () => NOW }),
      processor,
      resolveAgentKeys: resolve,
      brokerName: BROKER,
      brokerKey: broker.signing,
      payTo: PAY_TO,
      resourceUrl: "http://broker.local/provision",
      prepayHours: 3,
      now: () => NOW,
    });
    const body = await (await post()).json();
    expect(body.prepay_hours).toBe(3);
    expect(body.usd).toBeCloseTo(0.177);
  });

  it("refuses a mandate violation with 403 and never asks for payment", async () => {
    const res = await post({ plan: "vcg-a16-2c-16g-4vram" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ refused: true, stage: "provision", code: "RATE_CEILING_EXCEEDED" });
    expect(processor.requirementsCalls).toBe(0);
  });

  it("refuses a bad delegation in the presented chain with 403", async () => {
    chain = await buildChain({ limit_usd: 25 });
    leafHash = mandateHash(chain[1]);
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ stage: "delegation", code: "BUDGET_EXCEEDED" });
    expect(processor.requirementsCalls).toBe(0);
  });

  it("provisions after verification, settles, and returns a signed receipt the auditor accepts", async () => {
    const res = await post({ payment: { amount: "59000" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lease).toMatchObject({ plan: "vcg-a16-2c-8g-2vram", hourly_usd: 0.059 });
    expect(body.receipt).toMatchObject({ iss: BROKER, mandate: leafHash, usd: 0.059, pay_to: PAY_TO });
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(resource.running()).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "PAYMENT_SETTLED" });

    const verify = receiptVerifier(resolve, [BROKER]);
    expect(await verify(gate.receipts[0])).toBe(true);
    const result = await audit(
      {
        subject: AGENT,
        chain,
        delegations: [],
        usage: [{ mandate_jti: body.receipt.mandate_jti, handle: body.lease.handle, plan: body.lease.plan, hourly_usd: 0.059, started_at: NOW, ended_at: NOW + 1800 }],
        receipts: gate.receipts,
        observed_at: NOW + 3600,
      },
      { resolveAgentKeys: resolve, resolveRootKeys: async () => [human.publicJwk], isAnchored: async () => true, verifyReceipt: verify },
    );
    expect(result.checks.find((c) => c.id === "receipt_settled")?.result).toBe("PASS");
  });

  it("rejects a payment that does not verify, without provisioning", async () => {
    const res = await post({ payment: { amount: "1" } });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "payment rejected" });
    expect(resource.running()).toHaveLength(0);
    expect(processor.settleCalls).toBe(0);
  });

  it("destroys the instance when settlement fails after provisioning", async () => {
    processor.settleOk = false;
    const res = await post({ payment: { amount: "59000" } });
    expect(res.status).toBe(402);
    expect(resource.running()).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "SETTLEMENT_FAILED", reason: "blockhash expired" });
    expect(gate.receipts).toHaveLength(0);
  });

  it("does not settle when the provider fails after the payment verified", async () => {
    const failing = new FakeResource({ "vcg-a16-2c-8g-2vram": 0.059 }, () => NOW);
    failing.provision = async () => {
      throw new Error("ACCESS_BLOCKED: Vultr has not enabled this product");
    };
    gate = new ProvisionGate({
      registry,
      broker: new Broker({ registry, resource: failing, now: () => NOW }),
      processor,
      resolveAgentKeys: resolve,
      brokerName: BROKER,
      brokerKey: broker.signing,
      payTo: PAY_TO,
      resourceUrl: "http://broker.local/provision",
      now: () => NOW,
    });
    const res = await post({ payment: { amount: "59000" } });
    expect(res.status).toBe(502);
    expect(processor.settleCalls).toBe(0);
  });

  it("rejects a request not signed by the mandate's subject", async () => {
    const res = await post({ signer: other, iss: OTHER, payment: { amount: "59000" } });
    expect(res.status).toBe(401);
    expect(resource.running()).toHaveLength(0);
  });

  it("rejects a request whose signature does not match its claimed issuer", async () => {
    const res = await post({ signer: other, payment: { amount: "59000" } });
    expect(res.status).toBe(401);
  });

  it("rejects a request bound to a different mandate", async () => {
    const res = await post({ mandate: `sha256:${"0".repeat(64)}` });
    expect(res.status).toBe(401);
  });

  it("rejects a stale request", async () => {
    expect((await post({ iat: NOW - 600 })).status).toBe(401);
  });

  it("rejects a replayed paid request", async () => {
    const first = await post({ jti: "pr_fixed", payment: { amount: "59000" } });
    expect(first.status).toBe(200);
    const replay = await post({ jti: "pr_fixed", payment: { amount: "59000" } });
    expect(replay.status).toBe(401);
    expect(resource.running()).toHaveLength(1);
  });

  it("rejects malformed bodies", async () => {
    expect((await post({ body: { chain: [] } })).status).toBe(400);
    const res = await gate.handle(new Request("http://broker.local/provision", { method: "POST", body: "nope" }));
    expect(res.status).toBe(400);
  });
});

describe("receipt verification", () => {
  it("rejects a receipt with an edited amount or from an untrusted broker", async () => {
    await post({ payment: { amount: "59000" } });
    const r = gate.receipts[0];
    expect(await receiptVerifier(resolve, [BROKER])({ ...r, usd: 50 })).toBe(false);
    expect(await receiptVerifier(resolve, [OPS])(r)).toBe(false);
    expect(await receiptVerifier(resolve, [BROKER])({ ...r, sig: "garbage" })).toBe(false);
  });
});
