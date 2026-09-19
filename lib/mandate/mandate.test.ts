import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import {
  fromCompact,
  kidFor,
  mandateHash,
  MandateError,
  parseMandate,
  signMandate,
  toCompact,
  verifyMandate,
  type KeyResolver,
  type Mandate,
  type SignedMandate,
  type SigningKey,
} from "./index";

const OPS = "ans://v1.0.0.ops.burn402.xyz";
const BROKER = "ans://v1.0.0.broker.burn402.xyz";

type Actor = { signing: SigningKey; publicJwk: JWK };

async function actor(): Promise<Actor> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), use: "sig" };
  return { signing: { privateKey, kid: await kidFor(publicJwk) }, publicJwk };
}

function resolverFor(directory: Record<string, JWK[]>): KeyResolver {
  return async (iss) => directory[iss] ?? [];
}

function mandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    jti: "m_7f3a91",
    iss: OPS,
    sub: BROKER,
    aud: BROKER,
    parent: `sha256:${"9c1f".padEnd(64, "0")}`,
    depth: 1,
    max_depth: 3,
    scope: ["compute:provision"],
    limit_usd: 20,
    rate_usd_hr: 1.36,
    nbf: 1789800000,
    exp: 1789886400,
    ...overrides,
  };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function withPayload(jws: SignedMandate, payload: unknown): SignedMandate {
  return { ...jws, payload: b64(payload) };
}

function withHeader(jws: SignedMandate, header: unknown): SignedMandate {
  return { ...jws, protected: b64(header) };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MandateError);
  expect((error as MandateError).code).toBe(code);
}

describe("mandate sign + verify", async () => {
  const ops = await actor();
  const other = await actor();
  const resolve = resolverFor({ [OPS]: [ops.publicJwk] });

  it("round-trips a signed mandate", async () => {
    const jws = await signMandate(mandate(), ops.signing);
    const verified = await verifyMandate(jws, resolve);
    expect(verified.mandate).toEqual(mandate());
    expect(verified.kid).toBe(ops.signing.kid);
    expect(verified.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("hash is stable across compact and JSON serialization", async () => {
    const jws = await signMandate(mandate(), ops.signing);
    const compact = toCompact(jws);
    const parsed = fromCompact(compact);
    expect(parsed).toEqual(jws);
    expect(mandateHash(parsed)).toBe(mandateHash(compact));
    expect((await verifyMandate(parsed, resolve)).hash).toBe(mandateHash(jws));
  });

  it("reject_forged_signature", async () => {
    const jws = await signMandate(mandate(), ops.signing);
    const sig = Buffer.from(jws.signature, "base64url");
    sig[0] ^= 0xff;
    await expectCode(verifyMandate({ ...jws, signature: sig.toString("base64url") }, resolve), "SIGNATURE_INVALID");
  });

  it("reject_forged_signature: payload altered after signing", async () => {
    const jws = await signMandate(mandate(), ops.signing);
    await expectCode(verifyMandate(withPayload(jws, mandate({ limit_usd: 2000 })), resolve), "SIGNATURE_INVALID");
  });

  it("reject_signature_from_wrong_key: other key, issuer's kid", async () => {
    const jws = await signMandate(mandate(), { privateKey: other.signing.privateKey, kid: ops.signing.kid });
    await expectCode(verifyMandate(jws, resolve), "SIGNATURE_INVALID");
  });

  it("reject_signature_from_wrong_key: key not published for issuer", async () => {
    const jws = await signMandate(mandate(), other.signing);
    await expectCode(verifyMandate(jws, resolve), "UNKNOWN_KEY");
  });

  it("rejects an issuer with no published keys", async () => {
    const jws = await signMandate(mandate({ iss: "ans://v1.0.0.nobody.burn402.xyz" }), ops.signing);
    await expectCode(verifyMandate(jws, resolve), "UNKNOWN_KEY");
  });

  it("rejects a published key whose kid is not its thumbprint", async () => {
    const jws = await signMandate(mandate(), { privateKey: other.signing.privateKey, kid: "spoofed" });
    const lying = resolverFor({ [OPS]: [{ ...other.publicJwk, kid: "spoofed" }] });
    await expectCode(verifyMandate(jws, lying), "UNKNOWN_KEY");
  });

  it("ignores non-Ed25519 keys in the published set", async () => {
    const relabeled = { ...ops.publicJwk, crv: "X25519" };
    const jws = await signMandate(mandate(), { privateKey: ops.signing.privateKey, kid: await kidFor(relabeled) });
    await expectCode(verifyMandate(jws, resolverFor({ [OPS]: [relabeled] })), "UNKNOWN_KEY");
  });

  it("rejects alg none", async () => {
    const jws = await signMandate(mandate(), ops.signing);
    const none = { ...withHeader(jws, { alg: "none", kid: ops.signing.kid, typ: "mandate+jws" }), signature: "AA" };
    await expectCode(verifyMandate(none, resolve), "UNSUPPORTED_ALG");
  });

  it("rejects HS256 downgrade", async () => {
    const jws = await signMandate(mandate(), ops.signing);
    const hs = withHeader(jws, { alg: "HS256", kid: ops.signing.kid, typ: "mandate+jws" });
    await expectCode(verifyMandate(hs, resolve), "UNSUPPORTED_ALG");
  });

  it("rejects a key embedded in the header", async () => {
    const jws = await signMandate(mandate(), other.signing);
    const embedded = withHeader(jws, { alg: "EdDSA", kid: other.signing.kid, typ: "mandate+jws", jwk: other.publicJwk });
    await expectCode(verifyMandate(embedded, resolve), "FORBIDDEN_HEADER");
  });

  it("rejects unprotected header members", async () => {
    const jws = await signMandate(mandate(), ops.signing);
    await expectCode(verifyMandate({ ...jws, header: { kid: "x" } }, resolve), "FORBIDDEN_HEADER");
  });

  it("rejects malformed JWS input", async () => {
    await expectCode(verifyMandate("not-a-jws", resolve), "MALFORMED_JWS");
    await expectCode(verifyMandate({ protected: "a", payload: "b" }, resolve), "MALFORMED_JWS");
    expect(() => fromCompact("a.b")).toThrow(MandateError);
  });

  it("refuses to sign a malformed mandate", async () => {
    await expectCode(signMandate(mandate({ limit_usd: -1 }), ops.signing), "MALFORMED_PAYLOAD");
  });
});

describe("mandate payload shape", () => {
  const cases: [string, unknown][] = [
    ["missing field", Object.fromEntries(Object.entries(mandate()).filter(([k]) => k !== "exp"))],
    ["unknown field", { ...mandate(), admin: true }],
    ["bad parent hash", mandate({ parent: "sha256:abc" })],
    ["root with parent", mandate({ depth: 0 })],
    ["child without parent", mandate({ parent: null })],
    ["depth above max_depth", mandate({ depth: 4 })],
    ["negative limit", mandate({ limit_usd: -1 })],
    ["infinite rate", mandate({ rate_usd_hr: Infinity })],
    ["fractional depth", mandate({ depth: 1.5 })],
    ["empty scope", mandate({ scope: [] })],
    ["duplicate scope", mandate({ scope: ["a", "a"] })],
    ["nbf after exp", mandate({ nbf: 1789886400, exp: 1789800000 })],
    ["sub not an ANS name", mandate({ sub: "broker.burn402.xyz" })],
    ["not an object", ["jti"]],
  ];

  it.each(cases)("rejects %s", (_name, input) => {
    let error: unknown;
    try {
      parseMandate(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MandateError);
    expect((error as MandateError).code).toBe("MALFORMED_PAYLOAD");
  });

  it("accepts a root mandate", () => {
    expect(parseMandate(mandate({ parent: null, depth: 0 })).depth).toBe(0);
  });
});

describe("ANS trust card compatibility", () => {
  it("kid convention matches kids published in ANS trust cards", async () => {
    for (const name of ["auditor", "authority"]) {
      const card = JSON.parse(readFileSync(join(process.cwd(), "fixtures", `${name}-trust-card.json`), "utf8"));
      const ed = (card.keys as JWK[]).filter((k) => k.kty === "OKP" && k.crv === "Ed25519");
      expect(ed.length).toBeGreaterThan(0);
      for (const key of ed) expect(await kidFor(key)).toBe(key.kid);
    }
  });
});
