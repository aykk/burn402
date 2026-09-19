import type { JWK } from "jose";
import { AnsError } from "./errors";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcDecode(input: string): Buffer {
  let n = BigInt(0);
  for (const ch of input) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new AnsError("UNSUPPORTED_IDENTITY", "invalid base58btc character");
    n = n * BigInt(58) + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = n === BigInt(0) ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

function base58btcEncode(input: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(input).toString("hex") || "0"}`);
  let out = "";
  while (n > BigInt(0)) {
    out = ALPHABET[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const byte of input) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function jwkToDidKey(jwk: JWK): string {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new AnsError("UNSUPPORTED_IDENTITY", "only Ed25519 keys map to did:key here");
  }
  const x = Buffer.from(jwk.x, "base64url");
  if (x.length !== 32) throw new AnsError("UNSUPPORTED_IDENTITY", "Ed25519 key must be 32 bytes");
  return `did:key:z${base58btcEncode(Buffer.concat([Buffer.from([0xed, 0x01]), x]))}`;
}

export function didKeyToJwk(did: string): JWK {
  if (!did.startsWith("did:key:z")) throw new AnsError("UNSUPPORTED_IDENTITY", `not a base58btc did:key: ${did}`);
  const raw = base58btcDecode(did.slice("did:key:z".length));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) {
    throw new AnsError("UNSUPPORTED_IDENTITY", "did:key is not an Ed25519 key");
  }
  return { kty: "OKP", crv: "Ed25519", x: raw.subarray(2).toString("base64url"), use: "sig" };
}
