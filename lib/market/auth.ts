import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { base58Decode } from "../x402/client";

export type Signer = { address: string; sign(message: Uint8Array): Promise<Uint8Array> };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DEFAULT_MAX_SKEW_MS = 300_000;

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = BigInt(`0x0${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  const base = BigInt(58);
  while (n > BigInt(0)) {
    out = B58[Number(n % base)] + out;
    n /= base;
  }
  return "1".repeat(zeros) + out;
}

/** A Solana keypair secret: 64 bytes, seed then public key. */
export async function signerFromSecret(secretKeyBase58: string): Promise<Signer> {
  const bytes = base58Decode(secretKeyBase58);
  if (bytes.length !== 64) throw new Error("the wallet secret must be a 64-byte keypair");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, bytes.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const derivedPub = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(SPKI_ED25519_PREFIX.length);
  if (!derivedPub.equals(Buffer.from(bytes.subarray(32)))) throw new Error("the wallet secret's public half does not match its seed");
  return {
    address: base58Encode(new Uint8Array(derivedPub)),
    sign: async (message) => new Uint8Array(sign(null, message, key)),
  };
}

/** `chain` is "solana" unless given: an Ethereum wallet signs the same lines with "base" and its address in lower case. */
export function authMessage(p: { chain?: "solana" | "base"; address: string; method: string; path: string; body: string; timestampMs: number; nonce: string }): string {
  const bodyHash = createHash("sha256").update(p.body, "utf8").digest("hex");
  return ["X402-COMPUTE-AUTH", "v1", p.chain ?? "solana", p.address, p.method.toUpperCase(), p.path, bodyHash, String(p.timestampMs), p.nonce].join("\n");
}

export async function authHeaders(
  signer: Signer,
  p: { method: string; path: string; body: string; now?: () => number; nonce?: () => string },
): Promise<Record<string, string>> {
  const timestampMs = (p.now ?? Date.now)();
  const nonce = p.nonce ? p.nonce() : randomBytes(16).toString("hex");
  const message = authMessage({ address: signer.address, method: p.method, path: p.path, body: p.body, timestampMs, nonce });
  const signature = await signer.sign(new TextEncoder().encode(message));
  return {
    "X-Auth-Address": signer.address,
    "X-Auth-Chain": "solana",
    "X-Auth-Signature": Buffer.from(signature).toString("base64"),
    "X-Auth-Timestamp": String(timestampMs),
    "X-Auth-Nonce": nonce,
    "X-Auth-Sig-Encoding": "base64",
  };
}

/** True when `signature` is the ed25519 signature of `message` by the 32-byte public key. Never throws. */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]), format: "der", type: "spki" });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** Checks X-Auth-* headers. Does not track nonces; the caller must reject reuse. */
export function verifyAuth(
  headers: Headers,
  p: { method: string; path: string; body: string; nowMs: number; maxSkewMs?: number },
): { ok: true; address: string } | { ok: false; reason: string } {
  const address = headers.get("X-Auth-Address");
  const chain = headers.get("X-Auth-Chain");
  const signature = headers.get("X-Auth-Signature");
  const timestamp = headers.get("X-Auth-Timestamp");
  const nonce = headers.get("X-Auth-Nonce");
  const encoding = headers.get("X-Auth-Sig-Encoding");
  if (!address || !chain || !signature || !timestamp || !nonce || !encoding) return { ok: false, reason: "missing auth headers" };
  if (chain !== "solana") return { ok: false, reason: "unsupported chain" };
  if (encoding !== "base64") return { ok: false, reason: "unsupported signature encoding" };
  if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reason: "malformed nonce" };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "malformed timestamp" };
  const timestampMs = Number(timestamp);
  if (Math.abs(p.nowMs - timestampMs) > (p.maxSkewMs ?? DEFAULT_MAX_SKEW_MS)) return { ok: false, reason: "timestamp outside the allowed window" };

  let pub: Uint8Array;
  try {
    pub = base58Decode(address);
  } catch {
    return { ok: false, reason: "malformed address" };
  }
  if (pub.length !== 32) return { ok: false, reason: "malformed address" };
  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return { ok: false, reason: "malformed signature" };

  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, pub]), format: "der", type: "spki" });
    const message = authMessage({ address, method: p.method, path: p.path, body: p.body, timestampMs, nonce });
    if (!verify(null, Buffer.from(message, "utf8"), key, sig)) return { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true, address };
}
