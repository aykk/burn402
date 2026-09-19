import { exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkAttenuation,
  fromCompact,
  kidFor,
  MandateRegistry,
  signMandate,
  verifyMandate,
  type DelegationEvent,
  type Mandate,
  type SignedMandate,
  type SigningKey,
} from "./index";

const HUMAN = "did:web:alice.burn402.xyz";
const OPS = "ans://v1.0.0.ops.burn402.xyz";
const BROKER = "ans://v1.0.0.broker.burn402.xyz";
const SUB = "ans://v1.0.0.sub.burn402.xyz";
const ROGUE = "ans://v1.0.0.rogue.burn402.xyz";
const NBF = 1789800000;
const EXP = 1789886400;

type Actor = { signing: SigningKey; publicJwk: JWK };

async function actor(): Promise<Actor> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), use: "sig" };
  return { signing: { privateKey, kid: await kidFor(publicJwk) }, publicJwk };
}

const human = await actor();
const ops = await actor();
const broker = await actor();
const sub = await actor();
const rogue = await actor();

const agentKeys: Record<string, JWK[]> = {
  [OPS]: [ops.publicJwk],
  [BROKER]: [broker.publicJwk],
  [SUB]: [sub.publicJwk],
  [ROGUE]: [rogue.publicJwk],
};
const signerFor: Record<string, Actor> = { [HUMAN]: human, [OPS]: ops, [BROKER]: broker, [SUB]: sub, [ROGUE]: rogue };

let events: DelegationEvent[];
let anchored: Set<string>;
let registry: MandateRegistry;
let jtiCounter = 0;

function registryFor(): MandateRegistry {
  return new MandateRegistry({
    resolveAgentKeys: async (iss) => agentKeys[iss] ?? [],
    resolveRootKeys: async (iss) => (iss === HUMAN ? [human.publicJwk] : []),
    isAnchored: async (iss) => anchored.has(iss),
    onEvent: (e) => events.push(e),
    now: () => NBF + 1,
  });
}

function sign(m: Mandate, signer?: Actor): Promise<SignedMandate> {
  return signMandate(m, (signer ?? signerFor[m.iss]).signing);
}

function rootMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    jti: "m_root",
    iss: HUMAN,
    sub: OPS,
    aud: OPS,
    parent: null,
    depth: 0,
    max_depth: 3,
    scope: ["compute:provision", "compute:read"],
    limit_usd: 20,
    rate_usd_hr: 1.36,
    nbf: NBF,
    exp: EXP,
    ...overrides,
  };
}

function childOf(parentHash: string, parent: Mandate, to: string, overrides: Partial<Mandate> = {}): Mandate {
  return {
    jti: `m_${++jtiCounter}`,
    iss: parent.sub,
    sub: to,
    aud: to,
    parent: parentHash,
    depth: parent.depth + 1,
    max_depth: parent.max_depth,
    scope: ["compute:provision"],
    limit_usd: parent.limit_usd,
    rate_usd_hr: parent.rate_usd_hr,
    nbf: parent.nbf,
    exp: parent.exp,
    ...overrides,
  };
}

async function admitted(input: Promise<SignedMandate>) {
  const result = await registry.admit(await input);
  if (!result.ok) throw new Error(`expected admit, got ${result.refusal.code}: ${result.refusal.detail}`);
  return result.mandate;
}

async function refused(m: Mandate, signer?: Actor) {
  const result = await registry.admit(await sign(m, signer));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.refusal;
}

async function chain() {
  const rootResult = await registry.admitRoot(await sign(rootMandate()));
  if (!rootResult.ok) throw new Error(rootResult.refusal.detail);
  const root = rootResult.mandate;
  const opsToBroker = await admitted(sign(childOf(root.hash, root.mandate, BROKER)));
  return { root, opsToBroker };
}

beforeEach(() => {
  events = [];
  anchored = new Set([OPS, BROKER, SUB, ROGUE]);
  registry = registryFor();
});

describe("attenuation rules", () => {
  it("admits a valid chain human -> ops -> broker -> sub", async () => {
    const { opsToBroker } = await chain();
    const toSub = await admitted(sign(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { limit_usd: 8 })));
    expect(toSub.mandate.depth).toBe(2);
    expect(registry.remaining(opsToBroker.hash)).toBeCloseTo(12);
    expect(events.filter((e) => e.type === "DELEGATION_ACCEPTED")).toHaveLength(3);
  });

  it("reject_scope_escalation (rule 1)", async () => {
    const { opsToBroker } = await chain();
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { scope: ["compute:provision", "compute:read"] }));
    expect(r).toMatchObject({ rule: 1, code: "SCOPE_ESCALATION" });
  });

  it("reject_budget_above_parent_remaining (rule 2): demo refusal A, $25 against $20", async () => {
    const { opsToBroker } = await chain();
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { limit_usd: 25 }));
    expect(r).toMatchObject({ rule: 2, code: "BUDGET_EXCEEDED" });
    expect(r.detail).toBe("limit 25.00 > parent remaining 20.00");
  });

  it("reject_budget_above_parent_remaining (rule 2): counts consumption, not limit", async () => {
    const { opsToBroker } = await chain();
    registry.recordConsumption(opsToBroker.hash, 15);
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { limit_usd: 8 }));
    expect(r).toMatchObject({ rule: 2, code: "BUDGET_EXCEEDED" });
  });

  it("reject_sibling_sum_exceeding_parent (rule 2)", async () => {
    const { opsToBroker } = await chain();
    await admitted(sign(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { limit_usd: 15 })));
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, ROGUE, { limit_usd: 15 }));
    expect(r).toMatchObject({ rule: 2, code: "BUDGET_EXCEEDED" });
    expect(r.detail).toBe("limit 15.00 > parent remaining 5.00");
  });

  it("allows siblings that exactly exhaust the parent", async () => {
    const { opsToBroker } = await chain();
    await admitted(sign(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { limit_usd: 12.5 })));
    await admitted(sign(childOf(opsToBroker.hash, opsToBroker.mandate, ROGUE, { limit_usd: 7.5 })));
    expect(registry.remaining(opsToBroker.hash)).toBeCloseTo(0);
  });

  it("reject_rate_above_parent (rule 3): demo refusal B, 2.04/hr against 1.36/hr", async () => {
    const { opsToBroker } = await chain();
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { rate_usd_hr: 2.04 }));
    expect(r).toMatchObject({ rule: 3, code: "RATE_CEILING_EXCEEDED" });
    expect(r.detail).toBe("rate 2.04/hr > parent rate 1.36/hr");
  });

  it("reject_expiry_beyond_parent (rule 4)", async () => {
    const { opsToBroker } = await chain();
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { exp: EXP + 1 }));
    expect(r).toMatchObject({ rule: 4, code: "WINDOW_EXPIRED" });
  });

  it("rejects nbf before parent nbf (rule 5)", async () => {
    const { opsToBroker } = await chain();
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { nbf: NBF - 1 }));
    expect(r).toMatchObject({ rule: 5, code: "WINDOW_EXPIRED" });
  });

  it("rejects a skipped depth (rule 6)", async () => {
    const { opsToBroker } = await chain();
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { depth: 3 }));
    expect(r).toMatchObject({ rule: 6, code: "CHAIN_BROKEN" });
  });

  it("reject_depth_overflow (rule 7)", async () => {
    const rootResult = await registry.admitRoot(await sign(rootMandate({ max_depth: 2 })));
    if (!rootResult.ok) throw new Error(rootResult.refusal.detail);
    const root = rootResult.mandate;
    const d1 = await admitted(sign(childOf(root.hash, root.mandate, BROKER)));
    const r = await refused(childOf(d1.hash, d1.mandate, SUB));
    expect(r).toMatchObject({ rule: 7, code: "DEPTH_EXCEEDED" });
  });

  it("rejects max_depth raised above parent (rule 8)", async () => {
    const { opsToBroker } = await chain();
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { max_depth: 5 }));
    expect(r).toMatchObject({ rule: 8, code: "DEPTH_EXCEEDED" });
  });

  it("rejects an issuer that is not the parent's subject (rule 9)", async () => {
    const { opsToBroker } = await chain();
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { iss: ROGUE }));
    expect(r).toMatchObject({ rule: 9, code: "CHAIN_BROKEN" });
  });

  it("reject_broken_parent_hash (rule 10)", async () => {
    const { opsToBroker } = await chain();
    const tampered = `sha256:${"0".repeat(64)}`;
    const r = await refused(childOf(tampered, opsToBroker.mandate, SUB));
    expect(r).toMatchObject({ rule: 10, code: "CHAIN_BROKEN" });
  });

  it("reject_broken_parent_hash (rule 10): checkAttenuation on its own", async () => {
    const { root, opsToBroker } = await chain();
    const forged = await verifyMandate(
      await sign(childOf(root.hash, opsToBroker.mandate, SUB)),
      async (iss) => agentKeys[iss] ?? [],
    );
    expect(checkAttenuation(opsToBroker, forged, 20)).toMatchObject({ rule: 10, code: "CHAIN_BROKEN" });
  });

  it("rejects replaying an admitted mandate", async () => {
    const { opsToBroker } = await chain();
    const replay = await registry.admit(fromCompact(opsToBroker.compact));
    expect(replay).toMatchObject({ ok: false, refusal: { rule: 10, code: "CHAIN_BROKEN" } });
    expect(registry.remaining(opsToBroker.mandate.parent!)).toBeCloseTo(0);
  });

  it("reject_forged_signature (rule 11): demo refusal C", async () => {
    const { opsToBroker } = await chain();
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB), rogue);
    expect(r).toMatchObject({ rule: 11, code: "SIGNATURE_INVALID" });
  });

  it("rejects an issuer that does not chain to a trust anchor (rule 12)", async () => {
    const { opsToBroker } = await chain();
    anchored.delete(BROKER);
    const r = await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB));
    expect(r).toMatchObject({ rule: 12, code: "IDENTITY_UNANCHORED" });
  });

  it("rejects a child whose parent was never admitted", async () => {
    const orphanParent = rootMandate();
    const orphanHash = (await verifyMandate(await sign(orphanParent), async () => [human.publicJwk])).hash;
    const r = await refused(childOf(orphanHash, orphanParent, BROKER));
    expect(r).toMatchObject({ rule: 10, code: "CHAIN_BROKEN" });
  });
});

describe("root layer", () => {
  it("rejects a root signed by an agent key instead of the human key", async () => {
    const result = await registry.admitRoot(await sign(rootMandate({ iss: OPS })));
    expect(result).toMatchObject({ ok: false, refusal: { rule: 11, code: "SIGNATURE_INVALID" } });
  });

  it("rejects a human-signed mandate presented as an agent delegation", async () => {
    const { root } = await chain();
    const r = await refused(childOf(root.hash, root.mandate, BROKER, { iss: HUMAN }), human);
    expect(r).toMatchObject({ rule: 11, code: "SIGNATURE_INVALID" });
  });

  it("rejects a root that claims a parent", async () => {
    const result = await registry.admitRoot(await sign(rootMandate({ parent: `sha256:${"a".repeat(64)}`, depth: 1 })));
    expect(result).toMatchObject({ ok: false, refusal: { code: "CHAIN_BROKEN" } });
  });
});

describe("refusal events", () => {
  it("emits DELEGATION_REFUSED with rule, code and detail", async () => {
    const { opsToBroker } = await chain();
    await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { limit_usd: 25 }));
    const last = events.at(-1)!;
    expect(last).toMatchObject({
      type: "DELEGATION_REFUSED",
      at: NBF + 1,
      parent: opsToBroker.hash,
      rule: 2,
      code: "BUDGET_EXCEEDED",
      detail: "limit 25.00 > parent remaining 20.00",
    });
  });

  it("refusals do not allocate budget", async () => {
    const { opsToBroker } = await chain();
    await refused(childOf(opsToBroker.hash, opsToBroker.mandate, SUB, { rate_usd_hr: 9 }));
    expect(registry.remaining(opsToBroker.hash)).toBeCloseTo(20);
  });

  it("emits a refusal for unverifiable input without throwing", async () => {
    const result = await registry.admit({ protected: "x", payload: "y", signature: "z" });
    expect(result.ok).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "DELEGATION_REFUSED", child_jti: null });
  });
});

