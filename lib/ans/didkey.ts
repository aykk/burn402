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

export function didKeyToJwk(did: string): JWK {
  if (!did.startsWith("did:key:z")) throw new AnsError("UNSUPPORTED_IDENTITY", `not a base58btc did:key: ${did}`);
  const raw = base58btcDecode(did.slice("did:key:z".length));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) {
    throw new AnsError("UNSUPPORTED_IDENTITY", "did:key is not an Ed25519 key");
  }
  return { kty: "OKP", crv: "Ed25519", x: raw.subarray(2).toString("base64url"), use: "sig" };
}
