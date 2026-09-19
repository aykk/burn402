import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Encoder, Tag } from "cbor-x";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { kidFor, MandateError, signMandate, verifyMandate } from "../mandate";
import {
  AnsError,
  didKeyToJwk,
  parseRootKeys,
  rfc9162RootFromProof,
  sigStructure,
  TransparencyLogDirectory,
  verifyReceipt,
  verifyStatusToken,
  type DirectoryEntry,
  type TlSource,
} from "./index";

const DIR = join(process.cwd(), "fixtures", "local", "ans-identity");
const read = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));

const rootKeys = parseRootKeys(readFileSync(join(DIR, "root-keys.txt"), "utf8"));
const identityReceipt = read("identity-receipt.cbor");
const statusToken = read("status-token.cbor");
const entries: Record<string, DirectoryEntry> = JSON.parse(readFileSync(join(DIR, "directory.json"), "utf8"));
const identityBadge = JSON.parse(readFileSync(join(DIR, "identity-badge.json"), "utf8"));

const ANS_NAME = Object.keys(entries)[0];
const ENTRY = entries[ANS_NAME];
const TOKEN_IAT = verifyStatusToken(statusToken, rootKeys).iat;

function source(overrides: Partial<{ token: Uint8Array; receipt: Uint8Array }> = {}): TlSource {
  return {
    statusToken: async () => overrides.token ?? statusToken,
    identityReceipt: async () => overrides.receipt ?? identityReceipt,
  };
}

function directory(options: { token?: Uint8Array; receipt?: Uint8Array; now?: number; entries?: Record<string, DirectoryEntry> } = {}) {
  return new TransparencyLogDirectory({
    source: source(options),
    rootKeys,
    entries: options.entries ?? entries,
    now: () => options.now ?? TOKEN_IAT + 60,
  });
}

function flip(data: Uint8Array, offsetFromEnd: number): Uint8Array {
  const copy = new Uint8Array(data);
  copy[copy.length - offsetFromEnd] ^= 0x01;
  return copy;
}

function flipInside(data: Uint8Array, needle: string): Uint8Array {
  const copy = Buffer.from(data);
  const at = copy.indexOf(needle);
  if (at < 0) throw new Error(`needle ${needle} not found`);
  copy[at] ^= 0x01;
  return new Uint8Array(copy);
}

async function expectAns(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AnsError);
  expect((error as AnsError).code).toBe(code);
}

describe("TL root keys", () => {
  it("parses the pinned sumdb-note key", () => {
    expect([...rootKeys.keys()]).toEqual(["382a5111"]);
  });

  it("skips malformed lines", () => {
    expect(parseRootKeys("garbage\nname+kid+notbase64!!\n").size).toBe(0);
  });
});

describe("SCITT receipts", () => {
  it("verifies a real identity receipt from the local TL", () => {
    const leaf = verifyReceipt(identityReceipt, rootKeys) as { payload: { producer: { event: { eventType: string } } } };
    expect(leaf.payload.producer.event.eventType).toBe("IDENTITY_LINKED");
  });

  it("rejects a flipped signature byte", () => {
    expect(() => verifyReceipt(flip(identityReceipt, 1), rootKeys)).toThrow(expect.objectContaining({ code: "BAD_TL_SIGNATURE" }));
  });

  it("rejects an edited payload (inclusion proof no longer matches)", () => {
    expect(() => verifyReceipt(flipInside(identityReceipt, "IDENTITY_LINKED"), rootKeys)).toThrow(
      expect.objectContaining({ code: "BAD_INCLUSION_PROOF" }),
    );
  });

  it("rejects a receipt signed by a key that is not pinned", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const other = new Map([["382a5111", publicKey]]);
    expect(() => verifyReceipt(identityReceipt, other)).toThrow(expect.objectContaining({ code: "BAD_TL_SIGNATURE" }));
    expect(() => verifyReceipt(identityReceipt, new Map())).toThrow(expect.objectContaining({ code: "UNKNOWN_TL_KEY" }));
  });

  it("rejects bytes that are not COSE", () => {
    expect(() => verifyReceipt(new Uint8Array([1, 2, 3]), rootKeys)).toThrow(expect.objectContaining({ code: "MALFORMED_COSE" }));
  });
});

describe("RFC 9162 inclusion proofs", () => {
  const leafHash = (d: Buffer) => createHash("sha256").update(Buffer.concat([Buffer.from([0]), d])).digest();
  const node = (l: Buffer, r: Buffer) => createHash("sha256").update(Buffer.concat([Buffer.from([1]), l, r])).digest();
  const split = (n: number) => 2 ** Math.floor(Math.log2(n - 1));

  function mth(leaves: Buffer[]): Buffer {
    if (leaves.length === 1) return leafHash(leaves[0]);
    const k = split(leaves.length);
    return node(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
  }

  function path(m: number, leaves: Buffer[]): Buffer[] {
    if (leaves.length === 1) return [];
    const k = split(leaves.length);
    return m < k ? [...path(m, leaves.slice(0, k)), mth(leaves.slice(k))] : [...path(m - k, leaves.slice(k)), mth(leaves.slice(0, k))];
  }

  it("recomputes the root for every leaf of trees of size 1 to 17", () => {
    for (let n = 1; n <= 17; n++) {
      const leaves = Array.from({ length: n }, (_, i) => Buffer.from(`leaf-${i}`));
      const root = mth(leaves);
      for (let m = 0; m < n; m++) {
        expect(rfc9162RootFromProof(leaves[m], m, n, path(m, leaves)).equals(root)).toBe(true);
      }
    }
  });

  it("rejects a proof for the wrong index", () => {
    const leaves = Array.from({ length: 7 }, (_, i) => Buffer.from(`leaf-${i}`));
    expect(rfc9162RootFromProof(leaves[2], 3, 7, path(2, leaves)).equals(mth(leaves))).toBe(false);
  });

  it("rejects out-of-range and short proofs", () => {
    expect(() => rfc9162RootFromProof(Buffer.from("x"), 5, 5, [])).toThrow(AnsError);
    expect(() => rfc9162RootFromProof(Buffer.from("x"), 3, 8, [])).toThrow(AnsError);
  });
});

describe("status tokens", () => {
  it("verifies a real status token", () => {
    const t = verifyStatusToken(statusToken, rootKeys);
    expect(t).toMatchObject({ agentId: ENTRY.agentId, status: "ACTIVE", ansName: ANS_NAME });
    expect(t.exp).toBeGreaterThan(t.iat);
  });

  it("rejects an edited status token", () => {
    expect(() => verifyStatusToken(flipInside(statusToken, "ACTIVE"), rootKeys)).toThrow(expect.objectContaining({ code: "BAD_TL_SIGNATURE" }));
  });
});

describe("did:key", () => {
  it("decodes the sealed Ed25519 did:key to the same key the TL badge quotes", async () => {
    const did = identityBadge.payload?.producer?.event?.value ?? identityBadge.value;
    const jwk = didKeyToJwk(did);
    expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519", use: "sig" });
    expect(Buffer.from(jwk.x!, "base64url")).toHaveLength(32);
  });

  it("round-trips a freshly generated Ed25519 key", async () => {
    const { publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const x = Buffer.from((await exportJWK(publicKey)).x!, "base64url");
    const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = BigInt(`0x${Buffer.concat([Buffer.from([0xed, 0x01]), x]).toString("hex")}`);
    let s = "";
    while (n > BigInt(0)) {
      s = A[Number(n % BigInt(58))] + s;
      n /= BigInt(58);
    }
    expect(didKeyToJwk(`did:key:z${s}`).x).toBe(x.toString("base64url"));
  });

  it("rejects non-Ed25519 and non-did:key values", () => {
    expect(() => didKeyToJwk("did:web:example.com")).toThrow(AnsError);
    expect(() => didKeyToJwk("did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169")).toThrow(AnsError);
    expect(() => didKeyToJwk("did:key:z0OIl")).toThrow(AnsError);
  });
});

describe("TransparencyLogDirectory", () => {
  it("resolves an active agent to its sealed Ed25519 key", async () => {
    const resolved = await directory().resolve(ANS_NAME);
    expect(resolved).toMatchObject({ ansName: ANS_NAME, agentId: ENTRY.agentId, status: "ACTIVE" });
    expect(resolved.identity).toMatch(/^did:key:z6Mk/);
    expect(resolved.keys).toHaveLength(1);
    expect(await directory().isAnchored(ANS_NAME)).toBe(true);
  });

  it("returns keys usable by the mandate verifier: a key it did not seal is rejected", async () => {
    const d = directory();
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const kid = await kidFor(await exportJWK(publicKey));
    const jws = await signMandate(
      {
        jti: "m_1",
        iss: ANS_NAME,
        sub: "ans://v1.0.0.broker.burn402.xyz",
        aud: "ans://v1.0.0.broker.burn402.xyz",
        parent: `sha256:${"0".repeat(64)}`,
        depth: 1,
        max_depth: 3,
        scope: ["compute:provision"],
        limit_usd: 1,
        rate_usd_hr: 1,
        nbf: 1,
        exp: 2,
      },
      { privateKey, kid },
    );
    const error = await verifyMandate(jws, (iss) => d.resolveKeys(iss)).catch((e) => e);
    expect(error).toBeInstanceOf(MandateError);
    expect(error.code).toBe("UNKNOWN_KEY");
  });

  it("the sealed key's kid follows the mandate kid convention", async () => {
    const [key] = await directory().resolveKeys(ANS_NAME);
    expect(await kidFor(key)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects an expired status token", async () => {
    const exp = verifyStatusToken(statusToken, rootKeys).exp;
    await expectAns(directory({ now: exp }).resolve(ANS_NAME), "STATUS_EXPIRED");
    expect(await directory({ now: exp }).isAnchored(ANS_NAME)).toBe(false);
    expect(await directory({ now: exp }).resolveKeys(ANS_NAME)).toEqual([]);
  });

  it("rejects a name that is not in the directory", async () => {
    await expectAns(directory().resolve("ans://v1.0.0.nobody.burn402.xyz"), "NOT_IN_DIRECTORY");
  });

  it("rejects a directory entry that points a name at someone else's agent", async () => {
    const spoofed = { "ans://v1.0.0.ops.burn402.xyz": ENTRY };
    await expectAns(directory({ entries: spoofed }).resolve("ans://v1.0.0.ops.burn402.xyz"), "NAME_MISMATCH");
  });

  it("rejects an identity that is linked to a different agent", async () => {
    const wrongAgent = { [ANS_NAME]: { ...ENTRY, identityId: "01a0b990-88c1-7a3d-a3ba-98cf93929a06" } };
    await expectAns(directory({ entries: wrongAgent }).resolve(ANS_NAME), "IDENTITY_NOT_LINKED");
  });

  it("rejects a status token for a different agent id", async () => {
    const other = { [ANS_NAME]: { ...ENTRY, agentId: "00000000-0000-0000-0000-000000000000" } };
    await expectAns(directory({ entries: other }).resolve(ANS_NAME), "NAME_MISMATCH");
  });

  it("rejects tampered TL objects", async () => {
    await expectAns(directory({ token: flip(statusToken, 1) }).resolve(ANS_NAME), "BAD_TL_SIGNATURE");
    await expectAns(directory({ receipt: flip(identityReceipt, 1) }).resolve(ANS_NAME), "BAD_TL_SIGNATURE");
  });

  it("does not swallow non-ANS errors", async () => {
    const broken = new TransparencyLogDirectory({
      source: { statusToken: async () => { throw new TypeError("bug"); }, identityReceipt: async () => identityReceipt },
      rootKeys,
      entries,
    });
    await expect(broken.isAnchored(ANS_NAME)).rejects.toThrow(TypeError);
  });
});

describe("synthetic TL objects signed by a test TL key", () => {
  const encoder = new Encoder({ mapsAsObjects: false, useRecords: false });
  const tl = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const TEST_KID = "7e57ab1e";
  const keys = new Map([...rootKeys, [TEST_KID, tl.publicKey]]);
  const NAME = "ans://v1.0.0.ops.burn402.xyz";
  const AGENT = "11111111-1111-1111-1111-111111111111";
  const IDENTITY = "22222222-2222-2222-2222-222222222222";
  const DID = "did:key:z6Mkp8cXFtov88UfVWyKeEhFFFkoMiTwq2rq6bQ6vCxskoDL";
  const NOW = 1_800_000_000;

  function cose(protectedHeader: Map<number, unknown>, unprotected: Map<number, unknown>, payload: Buffer): Uint8Array {
    const protectedBytes = encoder.encode(protectedHeader);
    const signature = nodeSign("sha256", sigStructure(protectedBytes, payload), { key: tl.privateKey, dsaEncoding: "ieee-p1363" });
    return new Uint8Array(encoder.encode(new Tag([protectedBytes, unprotected, payload, signature], 18)));
  }

  function header(alg = -7, extra: [number, unknown][] = []): Map<number, unknown> {
    return new Map<number, unknown>([[1, alg], [4, Buffer.from(TEST_KID, "hex")], ...extra]);
  }

  function token(status = "ACTIVE", ansName = NAME, alg = -7): Uint8Array {
    const claims = new Map<number, unknown>([[1, AGENT], [2, status], [3, NOW - 60], [4, NOW + 3600], [5, ansName]]);
    return cose(header(alg), new Map(), Buffer.from(encoder.encode(claims)));
  }

  function receipt(event: Record<string, unknown>): Uint8Array {
    const payload = Buffer.from(JSON.stringify({ payload: { producer: { event } } }));
    const root = createHash("sha256").update(Buffer.concat([Buffer.from([0]), payload])).digest();
    const proof = new Map<number, unknown>([[-1, 1], [-2, 0], [-3, []], [-4, root]]);
    return cose(header(-7, [[395, 1]]), new Map([[396, proof]]), payload);
  }

  const linked = { eventType: "IDENTITY_LINKED", identityId: IDENTITY, kind: "did:key", value: DID, ansIds: [AGENT] };

  function dir(t: Uint8Array, r: Uint8Array) {
    return new TransparencyLogDirectory({
      source: { statusToken: async () => t, identityReceipt: async () => r },
      rootKeys: keys,
      entries: { [NAME]: { agentId: AGENT, identityId: IDENTITY } },
      now: () => NOW,
    });
  }

  it("accepts a well-formed synthetic chain", async () => {
    expect((await dir(token(), receipt(linked)).resolve(NAME)).identity).toBe(DID);
  });

  it("rejects a revoked agent", async () => {
    await expectAns(dir(token("REVOKED"), receipt(linked)).resolve(NAME), "AGENT_NOT_ACTIVE");
  });

  it("rejects an identity whose latest sealed event is a revocation", async () => {
    await expectAns(dir(token(), receipt({ ...linked, eventType: "IDENTITY_REVOKED" })).resolve(NAME), "IDENTITY_NOT_LINKED");
  });

  it("rejects an identity linked only to other agents", async () => {
    await expectAns(dir(token(), receipt({ ...linked, ansIds: ["33333333-3333-3333-3333-333333333333"] })).resolve(NAME), "IDENTITY_NOT_LINKED");
  });

  it("rejects a did:web identity", async () => {
    await expectAns(dir(token(), receipt({ ...linked, kind: "did:web", value: "did:web:ops.burn402.xyz" })).resolve(NAME), "UNSUPPORTED_IDENTITY");
  });

  it("rejects an event whose kind does not match its did:key value", async () => {
    await expectAns(dir(token(), receipt({ ...linked, kind: "did:web" })).resolve(NAME), "UNSUPPORTED_IDENTITY");
  });

  it("rejects a non-ES256 algorithm even with a valid signature", () => {
    expect(() => verifyStatusToken(token("ACTIVE", NAME, -35), keys)).toThrow(expect.objectContaining({ code: "MALFORMED_COSE" }));
  });

  it("rejects a kid that is not pinned even when another pinned key exists", () => {
    const onlyReal = new Map([["deadbeef", tl.publicKey]]);
    expect(() => verifyStatusToken(token(), onlyReal)).toThrow(expect.objectContaining({ code: "UNKNOWN_TL_KEY" }));
  });
});
