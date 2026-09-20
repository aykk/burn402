import { exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { anchorVerdict, type AnchorPolicy, type ArweaveGateway, type ArweaveItem, type ArweaveTag, type History, type VerdictRecord } from "../anchor";
import { verdictJti, VERDICT_TYP, type Verdict } from "../auditor";
import { kidFor, signJws } from "../mandate";
import { behaviorObservation, behaviorScore, riskCode, syncBehavior, TrustIndexClient, TrustIndexError } from "./index";

const AUDITOR = "ans://v1.0.0.auditor.burn402.xyz";
const ROGUE = "ans://v1.0.0.rogue.burn402.xyz";
const OPS = "ans://v1.0.0.ops.burn402.xyz";
const GATEWAY = "https://ar-io.dev";
const RISK_CODE = /^[A-Z0-9_]+$/;

function history(fqdn: string, modes: (Verdict["failure_mode"])[]): History {
  return {
    fqdn,
    rejected: [],
    entries: modes.map((m, i) => ({
      id: `tx_${i + 1}`,
      auditorKey: "k",
      record: {} as VerdictRecord,
      verdict: { failure_mode: m, verdict: "BREACH", iss: AUDITOR, issued_at: 1789800000 + i } as Verdict,
    })),
  };
}

describe("behavior score", () => {
  it("is 100 with a clean record and halves per breach", () => {
    expect([0, 1, 2, 3].map(behaviorScore)).toEqual([100, 50, 25, 13]);
  });

  it("one breach drops below the default threshold of 70", () => {
    expect(behaviorScore(1)).toBeLessThan(70);
  });

  it("builds risk codes the Trust Index accepts for every failure mode", () => {
    for (const mode of ["SIGNATURE_INVALID", "CHAIN_BROKEN", "DEPTH_EXCEEDED", "SCOPE_ESCALATION", "RATE_CEILING_EXCEEDED", "BUDGET_EXCEEDED", "WINDOW_EXPIRED", "UNSETTLED_USAGE"]) {
      const code = riskCode(mode);
      expect(code).toMatch(RISK_CODE);
      expect(code.startsWith("BEHAVIOR_")).toBe(true);
    }
  });
});

describe("behavior observation", () => {
  const at = new Date("2026-09-19T13:00:00.123Z");

  it("reports a clean record without provenance", () => {
    const o = behaviorObservation("agent-ops", history("ops.burn402.xyz", []), GATEWAY, at);
    expect(o).toEqual({
      agentId: "agent-ops",
      signalId: "burn402.behavior.score",
      observedAt: "2026-09-19T13:00:00Z",
      value: { score: 100, riskCodes: [], explanation: "no anchored breaches for ops.burn402.xyz" },
    });
  });

  it("links the latest anchored breach as evidence and lists distinct failure modes", () => {
    const o = behaviorObservation("agent-rogue", history("rogue.burn402.xyz", ["RATE_CEILING_EXCEEDED", "RATE_CEILING_EXCEEDED", "BUDGET_EXCEEDED"]), GATEWAY, at);
    expect(o.value.score).toBe(13);
    expect(o.value.riskCodes).toEqual(["BEHAVIOR_BURN402_RATE_CEILING_EXCEEDED", "BEHAVIOR_BURN402_BUDGET_EXCEEDED"]);
    expect(o.value.explanation).toBe(`3 anchored breaches for rogue.burn402.xyz; latest BUDGET_EXCEEDED by ${AUDITOR} (ar://tx_3)`);
    expect(o.provenance).toEqual({ aimId: "burn402", evidenceUrl: "https://ar-io.dev/tx_3" });
  });

  it("stays within the Trust Index value limits", () => {
    const many = Array.from({ length: 40 }, (_, i) => `MODE_${i}` as Verdict["failure_mode"]);
    const o = behaviorObservation("a", history("x.burn402.xyz", many), GATEWAY, at);
    expect(Number.isInteger(o.value.score)).toBe(true);
    expect(o.value.score).toBeGreaterThanOrEqual(0);
    expect(o.value.riskCodes.length).toBeLessThanOrEqual(16);
  });
});

class MemoryGateway implements ArweaveGateway {
  readonly items: (ArweaveItem & { data: Uint8Array })[] = [];
  ownerKey: string | null;
  constructor(ownerKey: string) {
    this.ownerKey = ownerKey;
  }
  async upload(data: Uint8Array, tags: ArweaveTag[]) {
    const id = `tx_${this.items.length + 1}`;
    this.items.push({ id, ownerKey: this.ownerKey!, tags, data, blockAt: null });
    return { id, ownerKey: this.ownerKey! };
  }
  async query(tags: ArweaveTag[]) {
    return this.items.filter((i) => tags.every((t) => i.tags.some((x) => x.name === t.name && x.value === t.value)));
  }
  async item(id: string) {
    const found = this.items.find((i) => i.id === id);
    return found ? { id: found.id, ownerKey: found.ownerKey, tags: found.tags, blockAt: found.blockAt } : null;
  }

  async fetchData(id: string) {
    return this.items.find((i) => i.id === id)!.data;
  }
}

function fakeTrustIndex(failWith?: number) {
  const calls: { path: string; body: unknown }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (failWith) return new Response(JSON.stringify({ code: "INVALID_SIGNAL_VALUE" }), { status: failWith });
    return new Response(JSON.stringify({ imported: 1 }), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

describe("syncBehavior", async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const auditorJwk: JWK = { ...(await exportJWK(publicKey)), use: "sig" };
  const auditorKey = { privateKey, kid: await kidFor(auditorJwk) };

  async function policyWithBreach(): Promise<AnchorPolicy> {
    const policy: AnchorPolicy = {
      gateway: new MemoryGateway(auditorJwk.x!),
      resolveAuditorKeys: async (iss) => (iss === AUDITOR ? [auditorJwk] : []),
      trustedAuditors: [AUDITOR],
    };
    const evidence = `sha256:${"e".repeat(64)}`;
    const v: Verdict = {
      jti: verdictJti(AUDITOR, evidence),
      iss: AUDITOR,
      subject: ROGUE,
      fqdn: "rogue.burn402.xyz",
      chain: [],
      evidence,
      verdict: "BREACH",
      checks: [],
      failure_mode: "RATE_CEILING_EXCEEDED",
      issued_at: 1789801234,
    };
    await anchorVerdict(policy, await signJws(v, auditorKey, VERDICT_TYP));
    return policy;
  }

  it("imports agents before observations and scores each from its verified history", async () => {
    const ti = fakeTrustIndex();
    const results = await syncBehavior({
      trustIndex: new TrustIndexClient({ baseUrl: "http://ti.local", fetch: ti.f }),
      anchor: await policyWithBreach(),
      gatewayUrl: GATEWAY,
      agents: [
        { agentId: "id-ops", ansName: OPS },
        { agentId: "id-rogue", ansName: ROGUE },
      ],
      now: () => new Date("2026-09-19T13:00:00Z"),
    });
    expect(ti.calls.map((c) => c.path)).toEqual(["/v1/internal/agents/import", "/v1/internal/observations/import"]);
    expect((ti.calls[0].body as { agents: { dnsName: string; status: string }[] }).agents).toMatchObject([
      { dnsName: "ops.burn402.xyz", status: "ACTIVE" },
      { dnsName: "rogue.burn402.xyz", status: "ACTIVE" },
    ]);
    expect(results.map((r) => [r.fqdn, r.breaches, r.observation.value.score])).toEqual([
      ["ops.burn402.xyz", 0, 100],
      ["rogue.burn402.xyz", 1, 50],
    ]);
  });

  it("surfaces an import rejection instead of retrying", async () => {
    const ti = fakeTrustIndex(422);
    const error = await syncBehavior({
      trustIndex: new TrustIndexClient({ baseUrl: "http://ti.local", fetch: ti.f }),
      anchor: await policyWithBreach(),
      gatewayUrl: GATEWAY,
      agents: [{ agentId: "id-rogue", ansName: ROGUE }],
    }).catch((e) => e);
    expect(error).toBeInstanceOf(TrustIndexError);
    expect(error.status).toBe(422);
    expect(ti.calls).toHaveLength(1);
  });

  it("sends the admin key when one is configured", async () => {
    let auth: string | null = null;
    const f = (async (_: unknown, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("Authorization");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await new TrustIndexClient({ baseUrl: "http://ti.local", adminKey: "k1", fetch: f }).importAgents([]);
    expect(auth).toBe("Bearer k1");
  });
});
