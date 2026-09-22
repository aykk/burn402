import { exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { verdictJti, VERDICT_TYP, type Verdict } from "../auditor";
import { kidFor, signJws, type SignedMandate, type SigningKey } from "../mandate";
import { anchorVerdict, arweaveAddress, historyFor, ownedBy, verdictTags, type AnchorPolicy, type ArweaveGateway, type ArweaveItem, type ArweaveTag } from "./index";

const AUDITOR = "ans://v1.0.0.auditor.burn402.xyz";
const ROGUE_ANS = "ans://v1.0.0.rogue.burn402.xyz";
const ROGUE_BUMPED = "ans://v1.0.1.rogue.burn402.xyz";
const OPS = "ans://v1.0.0.ops.burn402.xyz";

type Actor = { signing: SigningKey; publicJwk: JWK };

async function actor(): Promise<Actor> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), use: "sig" };
  return { signing: { privateKey, kid: await kidFor(publicJwk) }, publicJwk };
}

const auditor = await actor();
const rogue = await actor();
const keys: Record<string, JWK[]> = { [AUDITOR]: [auditor.publicJwk], [ROGUE_ANS]: [rogue.publicJwk] };

class MemoryGateway implements ArweaveGateway {
  readonly items: (ArweaveItem & { data: Uint8Array })[] = [];
  uploads = 0;
  ownerKey: string | null;

  constructor(ownerKey: string | null) {
    this.ownerKey = ownerKey;
  }

  async upload(data: Uint8Array, tags: ArweaveTag[]) {
    this.uploads++;
    return this.put(data, tags, this.ownerKey!);
  }

  put(data: Uint8Array, tags: ArweaveTag[], ownerKey: string) {
    const id = `tx_${this.items.length + 1}`;
    this.items.push({ id, ownerKey, ownerAddress: arweaveAddress(ownerKey), tags, data, blockAt: null });
    return { id, ownerKey };
  }

  async query(tags: ArweaveTag[]) {
    return this.items
      .filter((item) => tags.every((t) => item.tags.some((x) => x.name === t.name && x.value === t.value)))
      .map(({ id, ownerKey, ownerAddress, tags: t, blockAt }) => ({ id, ownerKey, ownerAddress, tags: t, blockAt }));
  }

  async item(id: string) {
    const found = this.items.find((i) => i.id === id);
    return found ? { id: found.id, ownerKey: found.ownerKey, ownerAddress: found.ownerAddress, tags: found.tags, blockAt: found.blockAt } : null;
  }

  async fetchData(id: string) {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error("not found");
    return item.data;
  }
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  const iss = overrides.iss ?? AUDITOR;
  const evidence = overrides.evidence ?? `sha256:${"e".repeat(64)}`;
  return {
    iss,
    subject: ROGUE_ANS,
    fqdn: "rogue.burn402.xyz",
    chain: [`sha256:${"a".repeat(64)}`],
    evidence,
    verdict: "BREACH",
    checks: [{ id: "rate_ceiling", result: "FAIL", detail: "provisioned 2.04/hr against mandate rate 1.36/hr", failure_mode: "RATE_CEILING_EXCEEDED" }],
    failure_mode: "RATE_CEILING_EXCEEDED",
    issued_at: 1789801234,
    ...overrides,
    jti: overrides.jti ?? verdictJti(iss, evidence),
  };
}

function sign(v: Verdict, by: Actor = auditor): Promise<SignedMandate> {
  return signJws(v, by.signing, VERDICT_TYP);
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

let gateway: MemoryGateway;
let policy: AnchorPolicy;

beforeEach(() => {
  gateway = new MemoryGateway(auditor.publicJwk.x!);
  policy = { gateway, resolveAuditorKeys: async (iss) => keys[iss] ?? [], trustedAuditors: [AUDITOR] };
});

describe("anchoring", () => {
  it("anchors a BREACH verdict tagged by subject FQDN", async () => {
    const result = await anchorVerdict(policy, await sign(verdict()));
    expect(result.status).toBe("ANCHORED");
    if (result.status !== "ANCHORED") return;
    const tags = Object.fromEntries(result.tags.map((t) => [t.name, t.value]));
    expect(tags).toMatchObject({
      "App-Name": "burn402",
      Schema: "verdict-v1",
      "Subject-FQDN": "rogue.burn402.xyz",
      "Subject-ANS": ROGUE_ANS,
      "Auditor-FQDN": "auditor.burn402.xyz",
      "Failure-Mode": "RATE_CEILING_EXCEEDED",
      "Issued-At": "1789801234",
    });
  });

  it("does not anchor COMPLIANT verdicts", async () => {
    const result = await anchorVerdict(policy, await sign(verdict({ verdict: "COMPLIANT", failure_mode: null, checks: [] })));
    expect(result).toMatchObject({ status: "REFUSED", reason: "only BREACH verdicts are anchored" });
    expect(gateway.uploads).toBe(0);
  });

  it("reject_verdict_from_untrusted_auditor: retaliation by an agent is refused", async () => {
    const retaliation = verdict({ iss: ROGUE_ANS, subject: OPS, fqdn: "ops.burn402.xyz" });
    const result = await anchorVerdict(policy, await sign(retaliation, rogue));
    expect(result.status).toBe("REFUSED");
    expect(gateway.uploads).toBe(0);
  });

  it("refuses a verdict signed with a key the auditor never published", async () => {
    const result = await anchorVerdict(policy, await sign(verdict(), rogue));
    expect(result.status).toBe("REFUSED");
    expect(gateway.uploads).toBe(0);
  });

  it("refuses to upload when the anchoring key is not the auditor's ANS key", async () => {
    gateway.ownerKey = rogue.publicJwk.x!;
    const result = await anchorVerdict(policy, await sign(verdict()));
    expect(result).toMatchObject({ status: "REFUSED" });
    expect(gateway.uploads).toBe(0);
  });

  it("reject_replayed_verdict: anchoring the same verdict twice uploads once", async () => {
    const jws = await sign(verdict());
    const first = await anchorVerdict(policy, jws);
    const second = await anchorVerdict(policy, jws);
    expect(first.status).toBe("ANCHORED");
    expect(second).toMatchObject({ status: "DUPLICATE", id: (first as { id: string }).id });
    expect(gateway.uploads).toBe(1);
  });

  it("reject_replayed_verdict: re-issuing the same evidence later is still a duplicate", async () => {
    await anchorVerdict(policy, await sign(verdict()));
    const again = await anchorVerdict(policy, await sign(verdict({ issued_at: 1789809999 })));
    expect(again.status).toBe("DUPLICATE");
    expect(gateway.uploads).toBe(1);
  });

  it("a third party's upload with the same jti does not block the real record", async () => {
    const v = verdict();
    gateway.put(bytes(await sign(v)), [
      { name: "App-Name", value: "burn402" },
      { name: "Schema", value: "verdict-v1" },
      { name: "Verdict-Jti", value: v.jti },
    ], rogue.publicJwk.x!);
    const result = await anchorVerdict(policy, await sign(v));
    expect(result.status).toBe("ANCHORED");
  });
});

describe("history", () => {
  it("history_survives_version_bump: verdicts for v1.0.0 and v1.0.1 share one history", async () => {
    await anchorVerdict(policy, await sign(verdict()));
    await anchorVerdict(
      policy,
      await sign(verdict({ subject: ROGUE_BUMPED, evidence: `sha256:${"f".repeat(64)}`, issued_at: 1789900000 })),
    );
    const history = await historyFor(policy, "rogue.burn402.xyz");
    expect(history.entries.map((e) => e.verdict.subject)).toEqual([ROGUE_ANS, ROGUE_BUMPED]);
    expect(history.rejected).toEqual([]);
  });

  it("a fresh domain has zero history", async () => {
    await anchorVerdict(policy, await sign(verdict()));
    expect((await historyFor(policy, "rogue2.burn402.xyz")).entries).toEqual([]);
  });

  it("ignores records uploaded by anyone other than the auditor's ANS key", async () => {
    const v = verdict();
    gateway.put(bytes(await sign(v)), verdictTags(v), rogue.publicJwk.x!);
    const history = await historyFor(policy, "rogue.burn402.xyz");
    expect(history.entries).toEqual([]);
    expect(history.rejected[0].reason).toContain("not by");
  });

  it("ignores a forged verdict planted under the victim's FQDN", async () => {
    const forged = verdict({ iss: ROGUE_ANS, subject: OPS, fqdn: "ops.burn402.xyz" });
    gateway.put(bytes(await sign(forged, rogue)), verdictTags(forged), rogue.publicJwk.x!);
    const history = await historyFor(policy, "ops.burn402.xyz");
    expect(history.entries).toEqual([]);
    expect(history.rejected).toHaveLength(1);
  });

  it("ignores data that is not a valid signed verdict", async () => {
    const v = verdict();
    gateway.put(new TextEncoder().encode("not json"), verdictTags(v), auditor.publicJwk.x!);
    const jws = await sign(v);
    gateway.put(bytes({ ...jws, payload: Buffer.from(JSON.stringify({ ...v, failure_mode: "SCOPE_ESCALATION" })).toString("base64url") }), verdictTags(v), auditor.publicJwk.x!);
    const history = await historyFor(policy, "rogue.burn402.xyz");
    expect(history.entries).toEqual([]);
    expect(history.rejected).toHaveLength(2);
  });

  it("ignores a real verdict re-tagged under a different FQDN", async () => {
    const v = verdict();
    const tags = verdictTags(v).map((t) => (t.name === "Subject-FQDN" ? { ...t, value: "ops.burn402.xyz" } : t));
    gateway.put(bytes(await sign(v)), tags, auditor.publicJwk.x!);
    const history = await historyFor(policy, "ops.burn402.xyz");
    expect(history.entries).toEqual([]);
    expect(history.rejected[0].reason).toContain("tagged as");
  });

  it("ignores a Verdict-Jti tag that does not match the signed verdict", async () => {
    const v = verdict();
    const tags = verdictTags(v).map((t) => (t.name === "Verdict-Jti" ? { ...t, value: "v_other" } : t));
    gateway.put(bytes(await sign(v)), tags, auditor.publicJwk.x!);
    expect((await historyFor(policy, "rogue.burn402.xyz")).rejected[0].reason).toContain("Verdict-Jti");
  });

  it("counts a verdict once even if it was uploaded twice", async () => {
    const v = verdict();
    const data = bytes(await sign(v));
    gateway.put(data, verdictTags(v), auditor.publicJwk.x!);
    gateway.put(data, verdictTags(v), auditor.publicJwk.x!);
    expect((await historyFor(policy, "rogue.burn402.xyz")).entries).toHaveLength(1);
  });
});

describe("arweave ownership", () => {
  it("matches an item the gateway serves without an owner key", () => {
    const key = auditor.publicJwk.x!;
    const address = arweaveAddress(key);
    expect(ownedBy({ ownerKey: key, ownerAddress: address }, key)).toBe(true);
    // gateways answer "<not-found>" for owner.key on some bundled items
    expect(ownedBy({ ownerKey: "<not-found>", ownerAddress: address }, key)).toBe(true);
  });

  it("refuses an item owned by someone else", () => {
    const key = auditor.publicJwk.x!;
    expect(ownedBy({ ownerKey: "<not-found>", ownerAddress: arweaveAddress(rogue.publicJwk.x!) }, key)).toBe(false);
    expect(ownedBy({ ownerKey: "<not-found>", ownerAddress: null }, key)).toBe(false);
    expect(ownedBy({ ownerKey: key, ownerAddress: null }, undefined)).toBe(false);
  });
});
