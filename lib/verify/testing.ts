import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Encoder, Tag } from "cbor-x";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { jwkToDidKey, sigStructure, type DirectoryEntry, type RootKeys, type TlSource } from "../ans";
import { arweaveAddress, type ArweaveGateway, type ArweaveItem, type ArweaveTag } from "../anchor";
import { kidFor, type SigningKey } from "../mandate";

const encoder = new Encoder({ mapsAsObjects: false, useRecords: false });

export type TestAgent = { name: string; signing: SigningKey; publicJwk: JWK; did: string; agentId: string; identityId: string };

export async function testAgent(name: string, n: number): Promise<TestAgent> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), use: "sig" };
  const hex = n.toString(16).padStart(12, "0");
  return {
    name,
    signing: { privateKey, kid: await kidFor(publicJwk) },
    publicJwk,
    did: jwkToDidKey(publicJwk),
    agentId: `00000000-0000-4000-8000-${hex}`,
    identityId: `11111111-1111-4111-8111-${hex}`,
  };
}

export class TestTransparencyLog implements TlSource {
  readonly rootKeys: RootKeys;
  private readonly key = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private readonly kid = "7e57ab1e";
  private readonly agents = new Map<string, TestAgent>();
  iat: number;

  constructor(iat: number) {
    this.iat = iat;
    this.rootKeys = new Map([[this.kid, this.key.publicKey]]);
  }

  add(agent: TestAgent): this {
    this.agents.set(agent.agentId, agent);
    return this;
  }

  entries(): Record<string, DirectoryEntry> {
    return Object.fromEntries([...this.agents.values()].map((a) => [a.name, { agentId: a.agentId, identityId: a.identityId }]));
  }

  async statusToken(agentId: string): Promise<Uint8Array> {
    const a = this.agents.get(agentId)!;
    const claims = new Map<number, unknown>([[1, agentId], [2, "ACTIVE"], [3, this.iat], [4, this.iat + 3600], [5, a.name]]);
    return this.cose(new Map(), Buffer.from(encoder.encode(claims)), []);
  }

  async identityReceipt(identityId: string): Promise<Uint8Array> {
    const a = [...this.agents.values()].find((x) => x.identityId === identityId)!;
    const event = { eventType: "IDENTITY_LINKED", identityId, kind: "did:key", value: a.did, ansIds: [a.agentId] };
    const payload = Buffer.from(JSON.stringify({ payload: { producer: { event } } }));
    const root = createHash("sha256").update(Buffer.concat([Buffer.from([0]), payload])).digest();
    const proof = new Map<number, unknown>([[-1, 1], [-2, 0], [-3, []], [-4, root]]);
    return this.cose(new Map([[396, proof]]), payload, [[395, 1]]);
  }

  private cose(unprotected: Map<number, unknown>, payload: Buffer, extra: [number, unknown][]): Uint8Array {
    const header = new Map<number, unknown>([[1, -7], [4, Buffer.from(this.kid, "hex")], ...extra]);
    const protectedBytes = encoder.encode(header);
    const signature = sign("sha256", sigStructure(protectedBytes, payload), { key: this.key.privateKey, dsaEncoding: "ieee-p1363" });
    return new Uint8Array(encoder.encode(new Tag([protectedBytes, unprotected, payload, signature], 18)));
  }
}

export class MemoryArweave implements ArweaveGateway {
  readonly items: (ArweaveItem & { data: Uint8Array })[] = [];
  ownerKey: string | null;

  constructor(ownerKey: string | null) {
    this.ownerKey = ownerKey;
  }

  async upload(data: Uint8Array, tags: ArweaveTag[]) {
    return this.put(data, tags, this.ownerKey!);
  }

  put(data: Uint8Array, tags: ArweaveTag[], ownerKey: string) {
    const id = `tx_${this.items.length + 1}`;
    this.items.push({ id, ownerKey, ownerAddress: arweaveAddress(ownerKey), tags, data, blockAt: null });
    return { id, ownerKey };
  }

  async query(tags: ArweaveTag[]) {
    return this.items
      .filter((i) => tags.every((t) => i.tags.some((x) => x.name === t.name && x.value === t.value)))
      .map(({ id, ownerKey, ownerAddress, tags: t, blockAt }) => ({ id, ownerKey, ownerAddress, tags: t, blockAt }));
  }

  async item(id: string) {
    const found = this.items.find((i) => i.id === id);
    return found ? { id: found.id, ownerKey: found.ownerKey, ownerAddress: found.ownerAddress, tags: found.tags, blockAt: found.blockAt } : null;
  }

  async fetchData(id: string) {
    const found = this.items.find((i) => i.id === id);
    if (!found) throw new Error("not found");
    return found.data;
  }
}
