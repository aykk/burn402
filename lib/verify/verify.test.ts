import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { collectAnsProof, TransparencyLogDirectory } from "../ans";
import { anchorVerdict, parseRecord, verdictTags, type AnchorPolicy } from "../anchor";
import { issueVerdict, type Auditor, type EvidenceBundle } from "../auditor";
import { mandateHash, signMandate, toCompact, type Mandate } from "../mandate";
import { namesForProof, publicAuditDeps, publishVerdict, verifyAnchoredVerdict } from "./index";
import { MemoryArweave, TestTransparencyLog, testAgent, type TestAgent } from "./testing";

const T = 1789800000;
const AUDITOR = "ans://v1.0.0.auditor.burn402.xyz";
const OPS = "ans://v1.0.0.ops.burn402.xyz";
const ROGUE = "ans://v1.0.0.rogue.burn402.xyz";
const BROKER = "ans://v1.0.0.broker.burn402.xyz";

const human = await testAgent("human", 0);
const ops = await testAgent(OPS, 1);
const rogue = await testAgent(ROGUE, 2);
const auditorAgent = await testAgent(AUDITOR, 3);
const broker = await testAgent(BROKER, 4);

let tl: TestTransparencyLog;
let directory: TransparencyLogDirectory;
let arweave: MemoryArweave;
let policy: AnchorPolicy;
let auditor: Auditor;
let bundle: EvidenceBundle;

function m(overrides: Partial<Mandate>): Mandate {
  return {
    jti: "m_root",
    iss: human.did,
    sub: OPS,
    aud: OPS,
    parent: null,
    depth: 0,
    max_depth: 3,
    scope: ["compute:provision"],
    limit_usd: 20,
    rate_usd_hr: 0.06,
    nbf: T - 3600,
    exp: T + 86400,
    ...overrides,
  };
}

async function chain(): Promise<string[]> {
  const root = toCompact(await signMandate(m({}), human.signing));
  const leaf = toCompact(await signMandate(m({ jti: "m_rogue", iss: OPS, sub: ROGUE, aud: ROGUE, parent: mandateHash(root), depth: 1, limit_usd: 8 }), ops.signing));
  return [root, leaf];
}

function directoryAt(log: TestTransparencyLog, now: number) {
  return new TransparencyLogDirectory({ source: log, rootKeys: log.rootKeys, entries: log.entries(), now: () => now });
}

async function publish(signer: TestAgent = auditorAgent) {
  return publishVerdict({ auditor: { ...auditor, key: signer.signing }, bundle, tl, entries: tl.entries(), anchor: policy, issuedAt: T });
}

async function verify(txid: string, options: { trustedAuditors?: string[]; rootKeys?: Map<string, never> } = {}) {
  return verifyAnchoredVerdict({ gateway: arweave, txid, tlRootKeys: options.rootKeys ?? tl.rootKeys, trustedAuditors: options.trustedAuditors });
}

function step(report: Awaited<ReturnType<typeof verify>>, name: string) {
  return report.steps.find((s) => s.name === name);
}

beforeEach(async () => {
  tl = new TestTransparencyLog(T - 10).add(ops).add(rogue).add(auditorAgent).add(broker);
  directory = directoryAt(tl, T);
  arweave = new MemoryArweave(auditorAgent.publicJwk.x!);
  policy = { gateway: arweave, resolveAuditorKeys: (iss) => directory.resolveKeys(iss), trustedAuditors: [AUDITOR] };
  auditor = { name: AUDITOR, key: auditorAgent.signing, deps: publicAuditDeps(directory) };
  bundle = {
    subject: ROGUE,
    chain: await chain(),
    delegations: [],
    usage: [{ mandate_jti: "m_rogue", handle: "inst-1", plan: "vcg-a16-2c-16g-4vram", hourly_usd: 0.118, started_at: T - 3600, ended_at: T - 60 }],
    receipts: [],
    observed_at: T,
  };
});

describe("namesForProof", () => {
  it("covers the auditor, the subject and every ANS name in the chain", async () => {
    expect(namesForProof(bundle, AUDITOR).sort()).toEqual([AUDITOR, OPS, ROGUE].sort());
  });
});

describe("publish then verify", () => {
  it("a third party reproduces the breach from the anchored record alone", async () => {
    const { verdict, anchored } = await publish();
    expect(verdict).toMatchObject({ verdict: "BREACH", failure_mode: "RATE_CEILING_EXCEEDED" });
    expect(anchored.status).toBe("ANCHORED");
    const report = await verify((anchored as { id: string }).id);
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual(["arweave item", "verdict record", "verdict signature", "arweave owner", "evidence hash", "re-audit"]);
    expect(report.chain.map((c) => [c.depth, c.jti])).toEqual([[0, "m_root"], [1, "m_rogue"]]);
    expect(report.verdict?.checks.find((c) => c.id === "rate_ceiling")?.detail).toBe("provisioned 0.118/hr against mandate rate 0.06/hr");
  });

  it("the record fits the free upload tier", async () => {
    await publish();
    expect(arweave.items[0].data.length).toBeLessThan(100 * 1024);
  });

  it("fails when the record carries no evidence", async () => {
    const { jws } = await issueVerdict(auditor, bundle, T);
    const anchored = await anchorVerdict(policy, jws);
    const report = await verify((anchored as { id: string }).id);
    expect(report.ok).toBe(false);
    expect(step(report, "reproducible")?.ok).toBe(false);
  });

  it("refuses to anchor evidence that does not match the verdict", async () => {
    const { jws } = await issueVerdict(auditor, bundle, T);
    const anchored = await anchorVerdict(policy, jws, { evidence: { ...bundle, observed_at: T + 1 } });
    expect(anchored.status).toBe("REFUSED");
  });

  it("detects evidence edited after anchoring", async () => {
    const { anchored } = await publish();
    const item = arweave.items[0];
    const record = parseRecord(item.data);
    record.evidence!.usage[0].hourly_usd = 0.05;
    item.data = new TextEncoder().encode(JSON.stringify(record));
    const report = await verify((anchored as { id: string }).id);
    expect(report.ok).toBe(false);
    expect(step(report, "evidence hash")?.ok).toBe(false);
  });

  it("catches a dishonest auditor whose verdict does not follow from its own evidence", async () => {
    const liar: Auditor = { ...auditor, deps: { ...auditor.deps, isAnchored: async () => false } };
    const { jws } = await issueVerdict(liar, bundle, T);
    const ans = await collectAnsProof(namesForProof(bundle, AUDITOR), tl, tl.entries());
    const anchored = await anchorVerdict(policy, jws, { evidence: bundle, ans });
    const report = await verify((anchored as { id: string }).id);
    expect(report.ok).toBe(false);
    expect(step(report, "re-audit")).toMatchObject({ ok: false });
    expect(report.mismatches).toContain("checks");
  });

  it("rejects a verdict from an auditor the verifier does not trust", async () => {
    const { anchored } = await publish();
    const report = await verify((anchored as { id: string }).id, { trustedAuditors: [OPS] });
    expect(step(report, "verdict signature")?.ok).toBe(false);
  });

  it("rejects a record uploaded by a key other than the auditor's", async () => {
    await publish();
    const original = arweave.items[0];
    const planted = arweave.put(original.data, verdictTags(parseRecordVerdictStub(original.data)), rogue.publicJwk.x!);
    const report = await verify(planted.id);
    expect(step(report, "arweave owner")?.ok).toBe(false);
  });

  it("rejects when the pinned TL root key is different", async () => {
    const { anchored } = await publish();
    const other = new Map([["7e57ab1e", generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey]]);
    const report = await verify((anchored as { id: string }).id, { rootKeys: other as never });
    expect(step(report, "verdict signature")?.ok).toBe(false);
  });

  it("rejects a record whose ANS proof binds the auditor to someone else's key", async () => {
    const { anchored } = await publish();
    const item = arweave.items[0];
    const record = parseRecord(item.data);
    record.ans![AUDITOR] = { ...record.ans![ROGUE] };
    item.data = new TextEncoder().encode(JSON.stringify(record));
    const report = await verify((anchored as { id: string }).id);
    expect(report.ok).toBe(false);
  });

  it("reports a missing transaction", async () => {
    const report = await verify("tx_missing");
    expect(report).toMatchObject({ ok: false, steps: [{ name: "arweave item", ok: false }] });
  });
});

function parseRecordVerdictStub(data: Uint8Array) {
  const record = parseRecord(data);
  return JSON.parse(Buffer.from(record.verdict.payload, "base64url").toString());
}
