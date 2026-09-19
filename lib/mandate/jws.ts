import { createHash } from "node:crypto";
import {
  calculateJwkThumbprint,
  flattenedVerify,
  FlattenedSign,
  importJWK,
  type CryptoKey,
  type JWK,
  type KeyObject,
} from "jose";
import { MandateError } from "./errors";
import { parseMandate, type Mandate } from "./mandate";

export const MANDATE_TYP = "mandate+jws";
const ALG = "EdDSA";
const ALLOWED_HEADER = new Set(["alg", "kid", "typ"]);
const B64URL = /^[A-Za-z0-9_-]+$/;

export type SignedMandate = {
  protected: string;
  payload: string;
  signature: string;
};

export type SigningKey = {
  privateKey: CryptoKey | KeyObject | JWK;
  kid: string;
};

export type KeyResolver = (iss: string) => Promise<JWK[]>;

export type VerifiedMandate = {
  mandate: Mandate;
  kid: string;
  hash: string;
  compact: string;
};

export function kidFor(publicJwk: JWK): Promise<string> {
  return calculateJwkThumbprint({ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x } as JWK);
}

export type VerifiedJws = {
  payload: unknown;
  iss: string;
  kid: string;
  hash: string;
  compact: string;
};

export async function signJws(value: unknown, key: SigningKey, typ: string): Promise<SignedMandate> {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const jws = await new FlattenedSign(payload).setProtectedHeader({ alg: ALG, kid: key.kid, typ }).sign(key.privateKey);
  return { protected: jws.protected!, payload: jws.payload, signature: jws.signature };
}

export async function signMandate(mandate: Mandate, key: SigningKey): Promise<SignedMandate> {
  return signJws(parseMandate(mandate), key, MANDATE_TYP);
}

export function toCompact(jws: SignedMandate): string {
  return `${jws.protected}.${jws.payload}.${jws.signature}`;
}

export function fromCompact(compact: string): SignedMandate {
  const parts = compact.split(".");
  if (parts.length !== 3) throw new MandateError("MALFORMED_JWS", "compact form needs three segments");
  const [protectedHeader, payload, signature] = parts;
  return assertShape({ protected: protectedHeader, payload, signature });
}

export function mandateHash(jws: SignedMandate | string): string {
  const compact = typeof jws === "string" ? jws : toCompact(jws);
  return `sha256:${createHash("sha256").update(compact, "ascii").digest("hex")}`;
}

function assertShape(input: unknown): SignedMandate {
  if (typeof input !== "object" || input === null) throw new MandateError("MALFORMED_JWS", "not an object");
  const raw = input as Record<string, unknown>;
  for (const field of ["protected", "payload", "signature"] as const) {
    const value = raw[field];
    if (typeof value !== "string" || !B64URL.test(value)) {
      throw new MandateError("MALFORMED_JWS", `${field} must be base64url`);
    }
  }
  const extra = Object.keys(raw).filter((k) => !["protected", "payload", "signature"].includes(k));
  if (extra.length > 0) throw new MandateError("FORBIDDEN_HEADER", `unprotected members not allowed: ${extra.join(", ")}`);
  return raw as SignedMandate;
}

function decodeJson(segment: string, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new MandateError("MALFORMED_JWS", `${what} is not base64url JSON`);
  }
}

function readHeader(segment: string, typ: string): { alg: string; kid: string } {
  const header = decodeJson(segment, "protected header");
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new MandateError("MALFORMED_JWS", "protected header must be an object");
  }
  const h = header as Record<string, unknown>;
  const forbidden = Object.keys(h).filter((k) => !ALLOWED_HEADER.has(k));
  if (forbidden.length > 0) throw new MandateError("FORBIDDEN_HEADER", `header members not allowed: ${forbidden.join(", ")}`);
  if (h.alg !== ALG) throw new MandateError("UNSUPPORTED_ALG", `alg must be ${ALG}, got ${String(h.alg)}`);
  if (h.typ !== typ) throw new MandateError("MALFORMED_JWS", `typ must be ${typ}`);
  if (typeof h.kid !== "string" || h.kid.length === 0) throw new MandateError("MALFORMED_JWS", "kid is required");
  return { alg: h.alg, kid: h.kid };
}

async function selectKey(keys: JWK[], kid: string, iss: string): Promise<JWK> {
  for (const jwk of keys) {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if ((await kidFor(jwk)) !== kid) continue;
    return { kty: "OKP", crv: "Ed25519", x: jwk.x };
  }
  throw new MandateError("UNKNOWN_KEY", `no Ed25519 key with kid ${kid} published for ${iss}`);
}

export async function verifyJws(input: unknown, resolveKeys: KeyResolver, typ: string): Promise<VerifiedJws> {
  const jws = assertShape(input);
  const { kid } = readHeader(jws.protected, typ);

  const claimed = decodeJson(jws.payload, "payload") as Record<string, unknown> | null;
  const iss = claimed?.iss;
  if (typeof iss !== "string" || iss.length === 0) throw new MandateError("MALFORMED_PAYLOAD", "iss is required");

  const jwk = await selectKey(await resolveKeys(iss), kid, iss);
  const key = await importJWK(jwk, ALG);

  let verifiedPayload: Uint8Array;
  try {
    const result = await flattenedVerify(jws, key, { algorithms: [ALG] });
    verifiedPayload = result.payload;
  } catch {
    throw new MandateError("SIGNATURE_INVALID", `signature does not verify under ${iss} kid ${kid}`);
  }

  const payload: unknown = JSON.parse(new TextDecoder().decode(verifiedPayload));
  const compact = toCompact(jws);
  return { payload, iss, kid, hash: mandateHash(compact), compact };
}

export async function verifyMandate(input: unknown, resolveKeys: KeyResolver): Promise<VerifiedMandate> {
  const verified = await verifyJws(input, resolveKeys, MANDATE_TYP);
  return { mandate: parseMandate(verified.payload), kid: verified.kid, hash: verified.hash, compact: verified.compact };
}
