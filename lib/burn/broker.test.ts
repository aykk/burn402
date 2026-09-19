import { exportJWK, generateKeyPair, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kidFor, MandateRegistry, signMandate, type Mandate, type SigningKey, type VerifiedMandate } from "../mandate";
import { Broker, FakeResource, type BurnEvent } from "./index";

const HUMAN = "did:web:alice.burn402.xyz";
const OPS = "ans://v1.0.0.ops.burn402.xyz";
const BROKER = "ans://v1.0.0.broker.burn402.xyz";
const SUB = "ans://v1.0.0.sub.burn402.xyz";
const T0 = 1789800000;
const EXP = T0 + 86400;
const HOUR = 3600;

const PRICES = {
  "plan-136": 1.36,
  "plan-204": 2.04,
  "plan-068": 0.68,
  "plan-034": 0.34,
};

type Actor = { signing: SigningKey; publicJwk: JWK };

async function actor(): Promise<Actor> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), use: "sig" };
  return { signing: { privateKey, kid: await kidFor(publicJwk) }, publicJwk };
}

const human = await actor();
const ops = await actor();
const broker = await actor();
const signers: Record<string, Actor> = { [HUMAN]: human, [OPS]: ops, [BROKER]: broker };
const agentKeys: Record<string, JWK[]> = { [OPS]: [ops.publicJwk], [BROKER]: [broker.publicJwk] };

let clock: number;
let events: BurnEvent[];
let registry: MandateRegistry;
let resource: FakeResource;
let b: Broker;
let counter = 0;

function base(overrides: Partial<Mandate>): Mandate {
  return {
    jti: `m_${++counter}`,
    iss: HUMAN,
    sub: OPS,
    aud: OPS,
    parent: null,
    depth: 0,
    max_depth: 3,
    scope: ["compute:provision"],
    limit_usd: 20,
    rate_usd_hr: 1.36,
    nbf: T0,
    exp: EXP,
    ...overrides,
  };
}

async function root(overrides: Partial<Mandate> = {}): Promise<VerifiedMandate> {
  const m = base(overrides);
  const r = await registry.admitRoot(await signMandate(m, signers[m.iss].signing));
  if (!r.ok) throw new Error(r.refusal.detail);
  return r.mandate;
}

async function child(parent: VerifiedMandate, overrides: Partial<Mandate> = {}): Promise<VerifiedMandate> {
  const m = base({
    iss: parent.mandate.sub,
    sub: parent.mandate.sub === OPS ? BROKER : SUB,
    aud: parent.mandate.sub === OPS ? BROKER : SUB,
    parent: parent.hash,
    depth: parent.mandate.depth + 1,
    limit_usd: parent.mandate.limit_usd,
    rate_usd_hr: parent.mandate.rate_usd_hr,
    exp: parent.mandate.exp,
    ...overrides,
  });
  const r = await registry.admit(await signMandate(m, signers[m.iss].signing));
  if (!r.ok) throw new Error(r.refusal.detail);
  return r.mandate;
}

const spec = (plan: string) => ({ plan, region: "ewr" });

beforeEach(() => {
  clock = T0;
  events = [];
  registry = new MandateRegistry({
    resolveAgentKeys: async (iss) => agentKeys[iss] ?? [],
    resolveRootKeys: async (iss) => (iss === HUMAN ? [human.publicJwk] : []),
    isAnchored: async () => true,
    now: () => clock,
  });
  resource = new FakeResource(PRICES, () => clock);
  b = new Broker({ registry, resource, now: () => clock, onEvent: (e) => events.push(e) });
});

afterEach(() => {
  b.stopReaper();
  vi.useRealTimers();
});

describe("burn accounting", () => {
  it("a $20 mandate at 1.36/hr grants 14.7 hours", async () => {
    const m = await root();
    const s = b.status(m.hash);
    expect(s.runtime_left_hr).toBeCloseTo(20 / 1.36);
    expect(s.runtime_left_hr).toBeCloseTo(14.7, 1);
  });

  it("consumption accrues with time and reduces remaining", async () => {
    const m = await root();
    await b.provision(m.hash, spec("plan-136"));
    clock += 5 * HOUR;
    const s = b.status(m.hash);
    expect(s.consumed_usd).toBeCloseTo(6.8);
    expect(s.remaining_usd).toBeCloseTo(13.2);
    expect(s.effective_exp).toBeCloseTo(T0 + (20 / 1.36) * HOUR);
  });

  it("effective_exp is capped by exp", async () => {
    const m = await root({ exp: T0 + 2 * HOUR });
    await b.provision(m.hash, spec("plan-136"));
    expect(b.effectiveExp(m.hash)).toBe(T0 + 2 * HOUR);
  });

  it("charges consumption upward through the chain", async () => {
    const r = await root();
    const toBroker = await child(r, { limit_usd: 12 });
    await b.provision(toBroker.hash, spec("plan-136"));
    clock += 2 * HOUR;
    expect(b.status(toBroker.hash).consumed_usd).toBeCloseTo(2.72);
    expect(b.status(r.hash).consumed_with_descendants_usd).toBeCloseTo(2.72);
    expect(b.status(r.hash).consumed_usd).toBeCloseTo(0);
    expect(b.status(r.hash).remaining_usd).toBeCloseTo(8);
  });

  it("delegation after spending sees accrued spend (rule 2 with live burn)", async () => {
    const r = await root();
    await b.provision(r.hash, spec("plan-136"));
    clock += 10 * HOUR;
    const m = base({ iss: OPS, sub: BROKER, aud: BROKER, parent: r.hash, depth: 1, limit_usd: 8 });
    const result = await registry.admit(await signMandate(m, ops.signing));
    expect(result).toMatchObject({ ok: false, refusal: { rule: 2, code: "BUDGET_EXCEEDED" } });
  });
});

describe("provision refusals", () => {
  it("reject_rate_above_parent at the broker: plan 2.04/hr against 1.36/hr", async () => {
    const m = await root();
    const r = await b.provision(m.hash, spec("plan-204"));
    expect(r).toMatchObject({ ok: false, refusal: { code: "RATE_CEILING_EXCEEDED", detail: "plan 2.04/hr > mandate rate 1.36/hr" } });
    expect(resource.running()).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "PROVISION_REFUSED", code: "RATE_CEILING_EXCEEDED" });
  });

  it("refuses stacking plans past the rate ceiling", async () => {
    const m = await root();
    expect((await b.provision(m.hash, spec("plan-068"))).ok).toBe(true);
    expect((await b.provision(m.hash, spec("plan-068"))).ok).toBe(true);
    const third = await b.provision(m.hash, spec("plan-034"));
    expect(third).toMatchObject({ ok: false, refusal: { code: "RATE_CEILING_EXCEEDED" } });
    expect(resource.running()).toHaveLength(2);
  });

  it("refuses when the budget is spent", async () => {
    const m = await root({ limit_usd: 1.36 });
    await b.provision(m.hash, spec("plan-136"));
    clock += HOUR;
    await b.reap();
    const r = await b.provision(m.hash, spec("plan-034"));
    expect(r).toMatchObject({ ok: false, refusal: { code: "BUDGET_EXCEEDED" } });
  });

  it("refuses after exp", async () => {
    const m = await root({ exp: T0 + HOUR });
    clock = T0 + HOUR;
    const r = await b.provision(m.hash, spec("plan-034"));
    expect(r).toMatchObject({ ok: false, refusal: { code: "WINDOW_EXPIRED" } });
  });

  it("refuses before nbf", async () => {
    const m = await root({ nbf: T0 + HOUR });
    const r = await b.provision(m.hash, spec("plan-034"));
    expect(r).toMatchObject({ ok: false, refusal: { code: "WINDOW_EXPIRED" } });
  });

  it("refuses without compute:provision scope", async () => {
    const m = await root({ scope: ["compute:read"] });
    const r = await b.provision(m.hash, spec("plan-034"));
    expect(r).toMatchObject({ ok: false, refusal: { code: "SCOPE_ESCALATION" } });
  });

  it("refuses an unknown mandate", async () => {
    const r = await b.provision(`sha256:${"0".repeat(64)}`, spec("plan-034"));
    expect(r).toMatchObject({ ok: false, refusal: { code: "CHAIN_BROKEN" } });
  });
});

describe("reaper", () => {
  it("reaper_destroys_at_effective_exp", async () => {
    const m = await root();
    const { lease } = (await b.provision(m.hash, spec("plan-136"))) as { ok: true; lease: { handle: string } };
    const deadline = T0 + (20 / 1.36) * HOUR;

    clock = deadline - 1;
    expect(await b.reap()).toHaveLength(0);
    expect(resource.isRunning(lease.handle)).toBe(true);

    clock = deadline + 30;
    const reaped = await b.reap();
    expect(reaped).toHaveLength(1);
    expect(reaped[0]).toMatchObject({ type: "RESOURCE_REAPED", reason: "BUDGET_EXHAUSTED", handle: lease.handle });
    expect(reaped[0].at).toBeCloseTo(deadline);
    expect((reaped[0] as { charged_usd: number }).charged_usd).toBeCloseTo(20);
    expect(resource.isRunning(lease.handle)).toBe(false);
    expect(registry.remaining(m.hash)).toBeCloseTo(0);
  });

  it("reaps at exp when exp comes first", async () => {
    const m = await root({ exp: T0 + 2 * HOUR });
    await b.provision(m.hash, spec("plan-136"));
    clock = T0 + 3 * HOUR;
    const [event] = await b.reap();
    expect(event).toMatchObject({ reason: "MANDATE_EXPIRED", at: T0 + 2 * HOUR });
    expect((event as { charged_usd: number }).charged_usd).toBeCloseTo(2.72);
  });

  it("reaps every lease of an exhausted mandate", async () => {
    const m = await root({ limit_usd: 1.36 });
    await b.provision(m.hash, spec("plan-068"));
    await b.provision(m.hash, spec("plan-068"));
    clock += HOUR;
    expect(await b.reap()).toHaveLength(2);
    expect(resource.running()).toHaveLength(0);
    expect(registry.remaining(m.hash)).toBeCloseTo(0);
  });

  it("computes the deadline correctly for staggered leases and never overcharges when reaped late", async () => {
    const m = await root({ limit_usd: 2.04 });
    await b.provision(m.hash, spec("plan-068"));
    clock += HOUR;
    await b.provision(m.hash, spec("plan-068"));
    const deadline = T0 + 2 * HOUR;
    expect(b.effectiveExp(m.hash)).toBeCloseTo(deadline);
    clock = deadline + 10 * HOUR;
    const reaped = await b.reap();
    const total = reaped.reduce((sum, e) => sum + (e as { charged_usd: number }).charged_usd, 0);
    expect(total).toBeCloseTo(2.04);
    expect(reaped.every((e) => Math.abs(e.at - deadline) < 1e-6)).toBe(true);
  });

  it("leaves other mandates running", async () => {
    const r = await root();
    const small = await child(r, { limit_usd: 0.68 });
    const big = await child(r, { limit_usd: 10 });
    await b.provision(small.hash, spec("plan-068"));
    await b.provision(big.hash, spec("plan-068"));
    clock += HOUR;
    const reaped = await b.reap();
    expect(reaped.map((e) => e.mandate)).toEqual([small.hash]);
    expect(resource.running()).toHaveLength(1);
  });

  it("released leases settle and stop burning", async () => {
    const m = await root();
    const { lease } = (await b.provision(m.hash, spec("plan-136"))) as { ok: true; lease: { handle: string } };
    clock += HOUR;
    expect(await b.release(lease.handle)).toBeCloseTo(1.36);
    clock += 10 * HOUR;
    expect(b.status(m.hash).remaining_usd).toBeCloseTo(18.64);
  });

  it("the scheduled reaper fires on its own at effective_exp", async () => {
    vi.useFakeTimers();
    const m = await root({ limit_usd: 0.34 });
    b.startReaper();
    await b.provision(m.hash, spec("plan-136"));
    const deadlineSec = (0.34 / 1.36) * HOUR;
    clock += deadlineSec - 1;
    await vi.advanceTimersByTimeAsync((deadlineSec - 1) * 1000);
    expect(resource.running()).toHaveLength(1);
    clock += 1;
    await vi.advanceTimersByTimeAsync(1000);
    expect(resource.running()).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "RESOURCE_REAPED", reason: "BUDGET_EXHAUSTED" });
  });
});
