import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base58Decode } from "../x402/client";
import { authHeaders, authMessage, base58Encode, signerFromSecret, verifyAuth } from "./auth";

/** A fresh ed25519 keypair as a 64-byte (seed + public) base58 secret, like a Solana CLI key. */
function testSecret(): { secret: string; address: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { secret: base58Encode(new Uint8Array([...seed, ...pub])), address: base58Encode(pub) };
}

describe("base58Encode", () => {
  it("round-trips with base58Decode, keeping leading zero bytes", () => {
    for (const bytes of [new Uint8Array([]), new Uint8Array([0, 0, 1, 2, 255]), new Uint8Array(32).fill(7), new Uint8Array([0])]) {
      expect(Array.from(base58Decode(base58Encode(bytes)))).toEqual(Array.from(bytes));
    }
  });
  it("matches a known value", () => {
    expect(base58Encode(new Uint8Array(Buffer.from("hello world")))).toBe("StV1DL6CwTryKyV");
    expect(base58Encode(new Uint8Array([0, 0, 0]))).toBe("111");
  });
});

describe("authMessage", () => {
  it("follows the seller's template", () => {
    expect(authMessage({ address: "A", method: "delete", path: "/compute/instances/x", body: "", timestampMs: 1700000000000, nonce: "n" })).toBe(
      "X402-COMPUTE-AUTH\nv1\nsolana\nA\nDELETE\n/compute/instances/x\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n1700000000000\nn",
    );
  });
});

describe("authHeaders / verifyAuth", () => {
  const now = 1700000000000;
  const req = { method: "GET", path: "/compute/instances", body: "" };

  it("signerFromSecret gives the public half as the address", async () => {
    const { secret, address } = testSecret();
    expect((await signerFromSecret(secret)).address).toBe(address);
  });

  it("rejects a secret that is not 64 bytes", async () => {
    await expect(signerFromSecret(base58Encode(new Uint8Array(32).fill(1)))).rejects.toThrow();
  });

  it("sends exactly the six headers", async () => {
    const { secret, address } = testSecret();
    const h = await authHeaders(await signerFromSecret(secret), { ...req, now: () => now });
    expect(Object.keys(h).sort()).toEqual(
      ["X-Auth-Address", "X-Auth-Chain", "X-Auth-Nonce", "X-Auth-Sig-Encoding", "X-Auth-Signature", "X-Auth-Timestamp"].sort(),
    );
    expect(h["X-Auth-Address"]).toBe(address);
    expect(h["X-Auth-Chain"]).toBe("solana");
    expect(h["X-Auth-Sig-Encoding"]).toBe("base64");
    expect(h["X-Auth-Timestamp"]).toBe(String(now));
    expect(h["X-Auth-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(Buffer.from(h["X-Auth-Signature"], "base64")).toHaveLength(64);
  });

  it("round-trips and returns the signer's address", async () => {
    const { secret, address } = testSecret();
    const h = await authHeaders(await signerFromSecret(secret), { ...req, now: () => now });
    expect(verifyAuth(new Headers(h), { ...req, nowMs: now + 1000 })).toEqual({ ok: true, address });
  });

  it("fails on a changed path, body, old timestamp or flipped signature byte", async () => {
    const { secret } = testSecret();
    const signer = await signerFromSecret(secret);
    const h = await authHeaders(signer, { method: "DELETE", path: "/compute/instances/a", body: "{}", now: () => now });
    const base = { method: "DELETE", path: "/compute/instances/a", body: "{}", nowMs: now };
    expect(verifyAuth(new Headers(h), base).ok).toBe(true);
    expect(verifyAuth(new Headers(h), { ...base, path: "/compute/instances/b" }).ok).toBe(false);
    expect(verifyAuth(new Headers(h), { ...base, body: "" }).ok).toBe(false);
    expect(verifyAuth(new Headers(h), { ...base, method: "GET" }).ok).toBe(false);
    expect(verifyAuth(new Headers(h), { ...base, nowMs: now + 10 * 60_000 }).ok).toBe(false);
    const sig = Buffer.from(h["X-Auth-Signature"], "base64");
    sig[0] ^= 1;
    expect(verifyAuth(new Headers({ ...h, "X-Auth-Signature": sig.toString("base64") }), base).ok).toBe(false);
  });

  it("fails when a header is missing or malformed", async () => {
    const { secret } = testSecret();
    const h = await authHeaders(await signerFromSecret(secret), { ...req, now: () => now });
    const p = { ...req, nowMs: now };
    for (const k of Object.keys(h)) {
      const rest = { ...h };
      delete rest[k];
      expect(verifyAuth(new Headers(rest), p).ok).toBe(false);
    }
    expect(verifyAuth(new Headers({ ...h, "X-Auth-Chain": "base" }), p).ok).toBe(false);
    expect(verifyAuth(new Headers({ ...h, "X-Auth-Address": "not-base58!" }), p).ok).toBe(false);
    expect(verifyAuth(new Headers({ ...h, "X-Auth-Nonce": "xyz" }), p).ok).toBe(false);
  });
});
