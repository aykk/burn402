import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { Decoder, Tag } from "cbor-x";
import { AnsError } from "./errors";

const decoder = new Decoder({ mapsAsObjects: false, useRecords: false });

const COSE_SIGN1_TAG = 18;
const LABEL_ALG = 1;
const LABEL_KID = 4;
const LABEL_VDS = 395;
const LABEL_VDP = 396;
const ALG_ES256 = -7;
const VDS_RFC9162_SHA256 = 1;
const PROOF_TREE_SIZE = -1;
const PROOF_LEAF_INDEX = -2;
const PROOF_PATH = -3;
const PROOF_ROOT = -4;

export type CoseSign1 = {
  protectedBytes: Uint8Array;
  protectedHeader: Map<number, unknown>;
  unprotected: Map<number, unknown>;
  payload: Uint8Array;
  signature: Uint8Array;
  kid: string;
};

export type RootKeys = Map<string, KeyObject>;

function bytes(value: unknown, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new AnsError("MALFORMED_COSE", `${what} is not a byte string`);
  return value;
}

export function parseCoseSign1(data: Uint8Array): CoseSign1 {
  let decoded: unknown;
  try {
    decoded = decoder.decode(data);
  } catch {
    throw new AnsError("MALFORMED_COSE", "not CBOR");
  }
  const arr = decoded instanceof Tag ? (decoded.tag === COSE_SIGN1_TAG ? decoded.value : null) : decoded;
  if (!Array.isArray(arr) || arr.length !== 4) throw new AnsError("MALFORMED_COSE", "not a COSE_Sign1 array");

  const protectedBytes = bytes(arr[0], "protected header");
  const protectedHeader = decoder.decode(protectedBytes);
  if (!(protectedHeader instanceof Map)) throw new AnsError("MALFORMED_COSE", "protected header is not a map");
  if (!(arr[1] instanceof Map)) throw new AnsError("MALFORMED_COSE", "unprotected header is not a map");
  if (protectedHeader.get(LABEL_ALG) !== ALG_ES256) throw new AnsError("MALFORMED_COSE", "alg must be ES256");

  const payload = bytes(arr[2], "payload");
  const signature = bytes(arr[3], "signature");
  if (signature.length !== 64) throw new AnsError("MALFORMED_COSE", `ES256 signature must be 64 bytes, got ${signature.length}`);
  const kid = Buffer.from(bytes(protectedHeader.get(LABEL_KID), "kid")).toString("hex");

  return { protectedBytes, protectedHeader, unprotected: arr[1], payload, signature, kid };
}

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(length, 1);
  return b;
}

function cborBytes(value: Uint8Array): Buffer {
  return Buffer.concat([cborHead(2, value.length), value]);
}

export function sigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Buffer {
  const context = Buffer.from("Signature1", "utf8");
  return Buffer.concat([
    cborHead(4, 4),
    cborHead(3, context.length),
    context,
    cborBytes(protectedBytes),
    cborBytes(new Uint8Array(0)),
    cborBytes(payload),
  ]);
}

export function parseRootKeys(text: string): RootKeys {
  const keys: RootKeys = new Map();
  for (const line of text.split("\n").map((l) => l.trim())) {
    const parts = line.split("+");
    if (parts.length !== 3) continue;
    const raw = Buffer.from(parts[2], "base64");
    if (raw.length < 2 || raw[0] !== 0x02) continue;
    try {
      const key = createPublicKey({ key: raw.subarray(1), format: "der", type: "spki" });
      if (key.asymmetricKeyType === "ec") keys.set(parts[1], key);
    } catch {
      continue;
    }
  }
  return keys;
}

export function verifyCoseSign1(cose: CoseSign1, rootKeys: RootKeys): void {
  const key = rootKeys.get(cose.kid);
  if (!key) throw new AnsError("UNKNOWN_TL_KEY", `kid ${cose.kid} is not a pinned TL root key`);
  const ok = verify(
    "sha256",
    sigStructure(cose.protectedBytes, cose.payload),
    { key, dsaEncoding: "ieee-p1363" },
    cose.signature,
  );
  if (!ok) throw new AnsError("BAD_TL_SIGNATURE", `signature does not verify under TL key ${cose.kid}`);
}

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export function rfc9162RootFromProof(leaf: Uint8Array, leafIndex: number, treeSize: number, path: Uint8Array[]): Buffer {
  if (treeSize <= 0 || leafIndex >= treeSize) throw new AnsError("BAD_INCLUSION_PROOF", "leaf index out of range");
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = sha256(Buffer.from([0x00]), leaf);
  for (const p of path) {
    if (p.length !== 32) throw new AnsError("BAD_INCLUSION_PROOF", "path element is not 32 bytes");
    if ((fn & 1) === 1 || fn === sn) {
      r = sha256(Buffer.from([0x01]), p, r);
      while (fn !== 0 && (fn & 1) === 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      r = sha256(Buffer.from([0x01]), r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  if (fn !== 0) throw new AnsError("BAD_INCLUSION_PROOF", "proof path too short");
  return r;
}

export function verifyReceipt(data: Uint8Array, rootKeys: RootKeys): unknown {
  const cose = parseCoseSign1(data);
  if (cose.protectedHeader.get(LABEL_VDS) !== VDS_RFC9162_SHA256) {
    throw new AnsError("MALFORMED_COSE", "receipt is not an RFC 9162 SHA-256 receipt");
  }
  const vdp = cose.unprotected.get(LABEL_VDP);
  if (!(vdp instanceof Map)) throw new AnsError("BAD_INCLUSION_PROOF", "missing inclusion proof");
  const treeSize = Number(vdp.get(PROOF_TREE_SIZE));
  const leafIndex = Number(vdp.get(PROOF_LEAF_INDEX));
  const path = vdp.get(PROOF_PATH);
  const root = vdp.get(PROOF_ROOT);
  if (!Number.isSafeInteger(treeSize) || !Number.isSafeInteger(leafIndex) || !Array.isArray(path)) {
    throw new AnsError("BAD_INCLUSION_PROOF", "malformed inclusion proof");
  }
  const computed = rfc9162RootFromProof(cose.payload, leafIndex, treeSize, path.map((p) => bytes(p, "path element")));
  if (!computed.equals(Buffer.from(bytes(root, "root hash")))) {
    throw new AnsError("BAD_INCLUSION_PROOF", "computed root does not match proof root");
  }
  verifyCoseSign1(cose, rootKeys);
  try {
    return JSON.parse(Buffer.from(cose.payload).toString("utf8"));
  } catch {
    throw new AnsError("MALFORMED_COSE", "receipt payload is not JSON");
  }
}

export type StatusToken = {
  agentId: string;
  status: string;
  iat: number;
  exp: number;
  ansName: string | null;
};

export function verifyStatusToken(data: Uint8Array, rootKeys: RootKeys): StatusToken {
  const cose = parseCoseSign1(data);
  verifyCoseSign1(cose, rootKeys);
  const claims = decoder.decode(cose.payload);
  if (!(claims instanceof Map)) throw new AnsError("MALFORMED_COSE", "status token payload is not a map");
  const agentId = claims.get(1);
  const status = claims.get(2);
  const iat = Number(claims.get(3));
  const exp = Number(claims.get(4));
  const ansName = claims.get(5);
  if (typeof agentId !== "string" || typeof status !== "string" || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) {
    throw new AnsError("MALFORMED_COSE", "status token is missing required claims");
  }
  return { agentId, status, iat, exp, ansName: typeof ansName === "string" ? ansName : null };
}
