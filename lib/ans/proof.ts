import type { DirectoryEntry, TlSource } from "./directory";
import { AnsError } from "./errors";

export type AnsProofEntry = DirectoryEntry & {
  statusToken: string;
  identityReceipt: string;
};

export type AnsProof = Record<string, AnsProofEntry>;

export async function collectAnsProof(names: Iterable<string>, source: TlSource, entries: Record<string, DirectoryEntry>): Promise<AnsProof> {
  const proof: AnsProof = {};
  for (const name of new Set(names)) {
    const entry = entries[name];
    if (!entry) throw new AnsError("NOT_IN_DIRECTORY", `${name} has no directory entry`);
    proof[name] = {
      ...entry,
      statusToken: Buffer.from(await source.statusToken(entry.agentId)).toString("base64"),
      identityReceipt: Buffer.from(await source.identityReceipt(entry.identityId)).toString("base64"),
    };
  }
  return proof;
}

export function proofEntries(proof: AnsProof): Record<string, DirectoryEntry> {
  return Object.fromEntries(Object.entries(proof).map(([name, e]) => [name, { agentId: e.agentId, identityId: e.identityId }]));
}

export class ProofTlSource implements TlSource {
  private readonly byAgent = new Map<string, string>();
  private readonly byIdentity = new Map<string, string>();

  constructor(proof: AnsProof) {
    for (const e of Object.values(proof)) {
      this.byAgent.set(e.agentId, e.statusToken);
      this.byIdentity.set(e.identityId, e.identityReceipt);
    }
  }

  async statusToken(agentId: string): Promise<Uint8Array> {
    const value = this.byAgent.get(agentId);
    if (!value) throw new AnsError("TL_UNAVAILABLE", `proof has no status token for agent ${agentId}`);
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  async identityReceipt(identityId: string): Promise<Uint8Array> {
    const value = this.byIdentity.get(identityId);
    if (!value) throw new AnsError("TL_UNAVAILABLE", `proof has no identity receipt for ${identityId}`);
    return new Uint8Array(Buffer.from(value, "base64"));
  }
}
