import { exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { kidFor, mandateHash, signJws, signMandate, toCompact, type Mandate, type SigningKey } from "../mandate";
import {
  audit,
  canonicalJson,
  issueVerdict,
  reproduce,
  sha256Of,
  verifyVerdict,
  VerdictError,
  type AuditDeps,
  type Auditor,
  type EvidenceBundle,
  type UsageRecord,
} from "./index";

const HUMAN = "did:web:alice.burn402.xyz";
const OPS = "ans://v1.0.0.ops.burn402.xyz";
const BROKER = "ans://v1.0.0.broker.burn402.xyz";
const ROGUE = "ans://v1.0.0.rogue.burn402.xyz";
const SUB = "ans://v1.0.0.sub.burn402.xyz";
const AUDITOR = "ans://v1.0.0.auditor.burn402.xyz";
const IMPOSTOR = "ans://v1.0.0.impostor.burn402.xyz";
const T0 = 1789800000;
const HOUR = 3600;

type Actor = { signing: SigningKey; publicJwk: JWK };

async function actor(): Promise<Actor> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), use: "sig" };
  return { signing: { privateKey, kid: await kidFor(publicJwk) }, publicJwk };
}

const human = await actor();
const ops = await actor();
const broker = await actor();
const rogue = await actor();
const auditorKey = await actor();
const impostorKey = await actor();

const agentKeys: Record<string, JWK[]> = {
  [OPS]: [ops.publicJwk],
  [BROKER]: [broker.publicJwk],
  [ROGUE]: [rogue.publicJwk],
  [AUDITOR]: [auditorKey.publicJwk],
  [IMPOSTOR]: [impostorKey.publicJwk],
};
const signers: Record<string, Actor> = { [HUMAN]: human, [OPS]: ops, [BROKER]: broker, [ROGUE]: rogue };

function deps(anchored: string[] = [OPS, BROKER, ROGUE, SUB]): AuditDeps {
  return {
    resolveAgentKeys: async (iss) => agentKeys[iss] ?? [],
    resolveRootKeys: async (iss) => (iss === HUMAN ? [human.publicJwk] : []),
    isAnchored: async (iss) => anchored.includes(iss),
  };
}

const auditor: Auditor = { name: AUDITOR, key: auditorKey.signing, deps: deps() };

function m(overrides: Partial<Mandate>): Mandate {
  return {
    jti: "m_x",
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
    exp: T0 + 24 * HOUR,
    ...overrides,
  };
}

async function signed(mandate: Mandate, signer?: Actor): Promise<string> {
  return toCompact(await signMandate(mandate, (signer ?? signers[mandate.iss]).signing));
}

type Scenario = {
  chain: string[];
  leafJti: string;
  brokerHash: string;
};

async function scenario(leafOverrides: Partial<Mandate> = {}): Promise<Scenario> {
  const root = await signed(m({ jti: "m_root" }));
  const toBroker = await signed(m({ jti: "m_broker", iss: OPS, sub: BROKER, aud: BROKER, parent: mandateHash(root), depth: 1 }));
  const leaf = await signed(
    m({
      jti: "m_rogue",
      iss: BROKER,
      sub: ROGUE,
      aud: ROGUE,
      parent: mandateHash(toBroker),
      depth: 2,
      limit_usd: 8,
      ...leafOverrides,
    }),
  );
  return { chain: [root, toBroker, leaf], leafJti: "m_rogue", brokerHash: mandateHash(toBroker) };
}

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    mandate_jti: "m_rogue",
    handle: "fake-1",
    plan: "plan-136",
    hourly_usd: 1.36,
    started_at: T0 + HOUR,
    ended_at: T0 + 3 * HOUR,
    ...overrides,
  };
}

const receipt = { mandate_jti: "m_rogue", usd: 2.72, tx: "44RhQwUuyw1ePtuVZZ3RnCNmakhyeFvD1Q2J8cd19jac", sig: "sig" };

function bundle(s: Scenario, overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    subject: ROGUE,
    chain: s.chain,
    delegations: [],
    usage: [usage()],
    receipts: [receipt],
    observed_at: T0 + 4 * HOUR,
    ...overrides,
  };
}

function check(result: Awaited<ReturnType<typeof audit>>, id: string) {
  return result.checks.find((c) => c.id === id)!;
}

describe("audit", () => {
  it("returns COMPLIANT for a clean chain and settled usage", async () => {
    const result = await audit(bundle(await scenario()), deps());
    expect(result.verdict).toBe("COMPLIANT");
    expect(result.failure_mode).toBeNull();
    expect(result.checks.every((c) => c.result === "PASS")).toBe(true);
    expect(result.fqdn).toBe("rogue.burn402.xyz");
    expect(result.chain).toHaveLength(3);
  });

  it("demo breach: provisioned 2.04/hr against mandate rate 1.36/hr", async () => {
    const result = await audit(bundle(await scenario(), { usage: [usage({ plan: "plan-204", hourly_usd: 2.04 })] }), deps());
    expect(result.verdict).toBe("BREACH");
    expect(result.failure_mode).toBe("RATE_CEILING_EXCEEDED");
    expect(check(result, "rate_ceiling")).toMatchObject({ result: "FAIL", detail: "provisioned 2.04/hr against mandate rate 1.36/hr" });
    expect(check(result, "chain_signatures").result).toBe("PASS");
    expect(check(result, "budget_remaining").result).toBe("PASS");
  });

  it("detects stacked usage above the rate even when each plan is under it", async () => {
    const result = await audit(
      bundle(await scenario(), {
        usage: [usage({ hourly_usd: 0.9 }), usage({ handle: "fake-2", hourly_usd: 0.9, started_at: T0 + 2 * HOUR })],
      }),
      deps(),
    );
    expect(check(result, "rate_ceiling")).toMatchObject({ result: "FAIL", detail: "provisioned 1.80/hr against mandate rate 1.36/hr" });
  });

  it("does not count sequential usage as concurrent", async () => {
    const result = await audit(
      bundle(await scenario(), {
        usage: [usage({ ended_at: T0 + 2 * HOUR }), usage({ handle: "fake-2", started_at: T0 + 2 * HOUR, ended_at: T0 + 3 * HOUR })],
      }),
      deps(),
    );
    expect(check(result, "rate_ceiling").result).toBe("PASS");
  });

  it("SIGNATURE_INVALID when a chain link is forged, and skips the rest", async () => {
    const s = await scenario();
    const forged = await signed(
      m({ jti: "m_rogue", iss: BROKER, sub: ROGUE, aud: ROGUE, parent: s.brokerHash, depth: 2, limit_usd: 8 }),
      rogue,
    );
    const result = await audit(bundle({ ...s, chain: [s.chain[0], s.chain[1], forged] }), deps());
    expect(result.failure_mode).toBe("SIGNATURE_INVALID");
    expect(result.checks.filter((c) => c.result === "SKIP")).toHaveLength(7);
  });

  it("SIGNATURE_INVALID when the root is signed by an agent key", async () => {
    const s = await scenario();
    const agentRoot = await signed(m({ jti: "m_root", iss: OPS }), ops);
    const result = await audit(bundle({ ...s, chain: [agentRoot, ...s.chain.slice(1)] }), deps());
    expect(result.failure_mode).toBe("SIGNATURE_INVALID");
  });

  it("CHAIN_BROKEN when an issuer is not anchored", async () => {
    const result = await audit(bundle(await scenario()), deps([OPS, ROGUE]));
    expect(result.failure_mode).toBe("CHAIN_BROKEN");
    expect(check(result, "identity_anchored").detail).toContain(BROKER);
  });

  it("CHAIN_BROKEN when a link points at the wrong parent", async () => {
    const s = await scenario({ parent: `sha256:${"0".repeat(64)}` });
    const result = await audit(bundle(s), deps());
    expect(result.failure_mode).toBe("CHAIN_BROKEN");
    expect(check(result, "chain_structure").detail).toContain("rule 10");
  });

  it("CHAIN_BROKEN when the chain does not end at the subject", async () => {
    const result = await audit(bundle(await scenario(), { subject: SUB }), deps());
    expect(check(result, "chain_structure")).toMatchObject({ result: "FAIL", failure_mode: "CHAIN_BROKEN" });
  });

  it("CHAIN_BROKEN when usage is filed under a mandate outside the chain", async () => {
    const result = await audit(bundle(await scenario(), { usage: [usage({ mandate_jti: "m_other" })] }), deps());
    expect(check(result, "chain_structure").detail).toContain("m_other");
  });

  it("CHAIN_BROKEN when the whole chain is shifted off a real root", async () => {
    const shift = { max_depth: 4 };
    const root = await signed(m({ jti: "m_root", parent: `sha256:${"a".repeat(64)}`, depth: 1, ...shift }));
    const toBroker = await signed(m({ jti: "m_broker", iss: OPS, sub: BROKER, aud: BROKER, parent: mandateHash(root), depth: 2, ...shift }));
    const leaf = await signed(
      m({ jti: "m_rogue", iss: BROKER, sub: ROGUE, aud: ROGUE, parent: mandateHash(toBroker), depth: 3, limit_usd: 8, ...shift }),
    );
    const result = await audit(bundle({ chain: [root, toBroker, leaf], leafJti: "m_rogue", brokerHash: "" }), deps());
    expect(check(result, "chain_structure")).toMatchObject({ result: "FAIL", detail: "root must have parent null and depth 0" });
  });

  it("DEPTH_EXCEEDED when a link raises max_depth", async () => {
    const result = await audit(bundle(await scenario({ max_depth: 5 })), deps());
    expect(check(result, "chain_structure")).toMatchObject({ result: "FAIL", failure_mode: "DEPTH_EXCEEDED" });
  });

  it("SCOPE_ESCALATION when a link widens scope", async () => {
    const result = await audit(bundle(await scenario({ scope: ["compute:provision", "compute:admin"] })), deps());
    expect(result.failure_mode).toBe("SCOPE_ESCALATION");
  });

  it("SCOPE_ESCALATION when provisioning without the provision scope", async () => {
    const read = { scope: ["compute:read"] };
    const root = await signed(m({ jti: "m_root", ...read }));
    const toBroker = await signed(m({ jti: "m_broker", iss: OPS, sub: BROKER, aud: BROKER, parent: mandateHash(root), depth: 1, ...read }));
    const leaf = await signed(
      m({ jti: "m_rogue", iss: BROKER, sub: ROGUE, aud: ROGUE, parent: mandateHash(toBroker), depth: 2, limit_usd: 8, ...read }),
    );
    const result = await audit(bundle({ chain: [root, toBroker, leaf], leafJti: "m_rogue", brokerHash: "" }), deps());
    expect(check(result, "scope_subset")).toMatchObject({
      result: "FAIL",
      failure_mode: "SCOPE_ESCALATION",
      detail: "provisioned without compute:provision in scope",
    });
  });

  it("BUDGET_EXCEEDED when usage outspends the leaf", async () => {
    const result = await audit(bundle(await scenario(), { usage: [usage({ ended_at: T0 + 8 * HOUR })], observed_at: T0 + 9 * HOUR }), deps());
    expect(check(result, "budget_remaining")).toMatchObject({ result: "FAIL", detail: "consumed 9.52 + delegated 0.00 > limit 8.00" });
  });

  it("BUDGET_EXCEEDED from public sibling delegations", async () => {
    const s = await scenario({ limit_usd: 15 });
    const sibling = await signed(m({ jti: "m_sib", iss: BROKER, sub: SUB, aud: SUB, parent: s.brokerHash, depth: 2, limit_usd: 15 }));
    const result = await audit(bundle(s, { delegations: [sibling] }), deps());
    expect(check(result, "budget_remaining")).toMatchObject({ result: "FAIL", failure_mode: "BUDGET_EXCEEDED" });
    expect(check(result, "budget_remaining").detail).toContain("delegated 30.00 across 2 children > limit 20.00");
  });

  it("ignores unverifiable sibling delegations", async () => {
    const s = await scenario({ limit_usd: 15 });
    const forgedSibling = await signed(
      m({ jti: "m_sib", iss: BROKER, sub: SUB, aud: SUB, parent: s.brokerHash, depth: 2, limit_usd: 15 }),
      rogue,
    );
    const result = await audit(bundle(s, { delegations: [forgedSibling] }), deps());
    expect(check(result, "budget_remaining").result).toBe("PASS");
  });

  it("WINDOW_EXPIRED when usage runs past exp", async () => {
    const s = await scenario({ exp: T0 + 2 * HOUR });
    const result = await audit(bundle(s), deps());
    expect(check(result, "time_window")).toMatchObject({ result: "FAIL", failure_mode: "WINDOW_EXPIRED" });
  });

  it("WINDOW_EXPIRED when usage starts before nbf", async () => {
    const result = await audit(bundle(await scenario(), { usage: [usage({ started_at: T0 - HOUR })] }), deps());
    expect(check(result, "time_window")).toMatchObject({ result: "FAIL", failure_mode: "WINDOW_EXPIRED" });
  });

  it("UNSETTLED_USAGE when nothing was paid", async () => {
    const result = await audit(bundle(await scenario(), { receipts: [] }), deps());
    expect(result.failure_mode).toBe("UNSETTLED_USAGE");
  });

  it("uses the receipt verifier when provided", async () => {
    const strict = { ...deps(), verifyReceipt: async () => false };
    const result = await audit(bundle(await scenario()), strict);
    expect(check(result, "receipt_settled").result).toBe("FAIL");
  });

  it("reports the first failing check as the failure mode", async () => {
    const result = await audit(bundle(await scenario(), { usage: [usage({ hourly_usd: 2.04 })], receipts: [] }), deps());
    expect(result.failure_mode).toBe("RATE_CEILING_EXCEEDED");
    expect(check(result, "receipt_settled").result).toBe("FAIL");
  });
});

describe("evidence hashing", () => {
  it("is independent of key order and sensitive to content", async () => {
    const b = bundle(await scenario());
    const reordered = JSON.parse(canonicalJson(b));
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
    expect(sha256Of(shuffled)).toBe(sha256Of(b));
    expect(sha256Of({ ...b, observed_at: b.observed_at + 1 })).not.toBe(sha256Of(b));
  });
});

describe("signed verdicts", () => {
  const trusted = [AUDITOR];
  const resolve = async (iss: string) => agentKeys[iss] ?? [];

  it("signs and verifies a verdict", async () => {
    const b = bundle(await scenario(), { usage: [usage({ hourly_usd: 2.04 })] });
    const { verdict, jws } = await issueVerdict(auditor, b, T0 + 5 * HOUR);
    const verified = await verifyVerdict(jws, resolve, trusted);
    expect(verified.verdict).toEqual(verdict);
    expect(verdict).toMatchObject({ iss: AUDITOR, subject: ROGUE, verdict: "BREACH", issued_at: T0 + 5 * HOUR });
  });

  it("reject_verdict_from_untrusted_auditor", async () => {
    const impostor: Auditor = { name: IMPOSTOR, key: impostorKey.signing, deps: deps() };
    const { jws } = await issueVerdict(impostor, bundle(await scenario()), T0);
    const error = await verifyVerdict(jws, resolve, trusted).catch((e) => e);
    expect(error).toBeInstanceOf(VerdictError);
    expect(error.code).toBe("UNTRUSTED_AUDITOR");
  });

  it("rejects a verdict signed with a key the auditor never published", async () => {
    const forger: Auditor = { name: AUDITOR, key: impostorKey.signing, deps: deps() };
    const { jws } = await issueVerdict(forger, bundle(await scenario()), T0);
    const error = await verifyVerdict(jws, resolve, trusted).catch((e) => e);
    expect(error).toMatchObject({ code: "INVALID_SIGNATURE" });
  });

  it("rejects a verdict whose body was edited after signing", async () => {
    const { verdict, jws } = await issueVerdict(auditor, bundle(await scenario()), T0);
    const edited = { ...jws, payload: Buffer.from(JSON.stringify({ ...verdict, verdict: "BREACH" })).toString("base64url") };
    const error = await verifyVerdict(edited, resolve, trusted).catch((e) => e);
    expect(error).toMatchObject({ code: "INVALID_SIGNATURE" });
  });

  it("rejects a verdict whose jti is not bound to its auditor and evidence", async () => {
    const { verdict } = await issueVerdict(auditor, bundle(await scenario()), T0);
    const rebound = await signJws({ ...verdict, jti: "v_chosen_by_attacker" }, auditorKey.signing, "verdict+jws");
    const error = await verifyVerdict(rebound, resolve, trusted).catch((e) => e);
    expect(error).toMatchObject({ code: "MALFORMED_VERDICT" });
  });

  it("gives the same jti for the same auditor and evidence", async () => {
    const b = bundle(await scenario());
    const first = await issueVerdict(auditor, b, T0);
    const second = await issueVerdict(auditor, b, T0 + 60);
    expect(second.verdict.jti).toBe(first.verdict.jti);
  });
});

describe("reproducibility", () => {
  it("a third party re-running the audit reaches the same verdict", async () => {
    const b = bundle(await scenario(), { usage: [usage({ hourly_usd: 2.04 })] });
    const { verdict } = await issueVerdict(auditor, b, T0);
    const thirdParty = await reproduce(verdict, JSON.parse(JSON.stringify(b)), deps());
    expect(thirdParty).toMatchObject({ reproduced: true, mismatches: [] });
  });

  it("detects a verdict that does not follow from the evidence", async () => {
    const b = bundle(await scenario(), { usage: [usage({ hourly_usd: 2.04 })] });
    const { verdict } = await issueVerdict(auditor, b, T0);
    const cleaned = { ...b, usage: [usage()] };
    const result = await reproduce(verdict, cleaned, deps());
    expect(result.reproduced).toBe(false);
    expect(result.mismatches).toEqual(expect.arrayContaining(["evidence", "verdict", "checks"]));
  });

  it("still reproduces when only the wording of a check has changed", async () => {
    const b = bundle(await scenario(), { usage: [usage({ hourly_usd: 2.04 })] });
    const { verdict } = await issueVerdict(auditor, b, T0);
    const failing = verdict.checks.find((c) => c.result === "FAIL")!;
    const older = { ...verdict, checks: verdict.checks.map((c) => (c.id === failing.id ? { ...c, detail: "worded the way an older build worded it" } : c)) };

    const result = await reproduce(older, JSON.parse(JSON.stringify(b)), deps());
    expect(result.reproduced).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.reworded).toEqual([failing.id]);
  });

  it("does not reproduce when a check flips result, however it is worded", async () => {
    const b = bundle(await scenario(), { usage: [usage({ hourly_usd: 2.04 })] });
    const { verdict } = await issueVerdict(auditor, b, T0);
    const failing = verdict.checks.find((c) => c.result === "FAIL")!;
    const softened = {
      ...verdict,
      checks: verdict.checks.map((c) => (c.id === failing.id ? { id: c.id, result: "PASS" as const, detail: c.detail } : c)),
    };

    const result = await reproduce(softened, JSON.parse(JSON.stringify(b)), deps());
    expect(result.reproduced).toBe(false);
    expect(result.mismatches).toContain("checks");
  });
});
