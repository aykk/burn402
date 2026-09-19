import type { JWK } from "jose";
import { verifyReceipt, verifyStatusToken, type RootKeys } from "./cose";
import { didKeyToJwk } from "./didkey";
import { AnsError } from "./errors";

export type DirectoryEntry = {
  agentId: string;
  identityId: string;
};

export interface TlSource {
  statusToken(agentId: string): Promise<Uint8Array>;
  identityReceipt(identityId: string): Promise<Uint8Array>;
}

export type ResolvedAgent = {
  ansName: string;
  agentId: string;
  status: string;
  statusExp: number;
  identity: string;
  identityId: string;
  keys: JWK[];
};

export type DirectoryOptions = {
  source: TlSource;
  rootKeys: RootKeys;
  entries: Record<string, DirectoryEntry>;
  now?: () => number;
};

type IdentityEvent = {
  eventType?: unknown;
  identityId?: unknown;
  kind?: unknown;
  value?: unknown;
  ansIds?: unknown;
};

export class HttpTlSource implements TlSource {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  statusToken(agentId: string): Promise<Uint8Array> {
    return this.get(`/v1/agents/${encodeURIComponent(agentId)}/status-token`);
  }

  identityReceipt(identityId: string): Promise<Uint8Array> {
    return this.get(`/v1/identities/${encodeURIComponent(identityId)}/receipt`);
  }

  private async get(path: string): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
    } catch (error) {
      throw new AnsError("TL_UNAVAILABLE", `${path}: ${(error as Error).message}`);
    }
    if (!response.ok) throw new AnsError("TL_UNAVAILABLE", `${path}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export class TransparencyLogDirectory {
  private readonly source: TlSource;
  private readonly rootKeys: RootKeys;
  private readonly entries: Record<string, DirectoryEntry>;
  private readonly now: () => number;

  constructor(options: DirectoryOptions) {
    this.source = options.source;
    this.rootKeys = options.rootKeys;
    this.entries = options.entries;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async resolve(ansName: string): Promise<ResolvedAgent> {
    const entry = this.entries[ansName];
    if (!entry) throw new AnsError("NOT_IN_DIRECTORY", `${ansName} has no directory entry`);

    const token = verifyStatusToken(await this.source.statusToken(entry.agentId), this.rootKeys);
    if (token.agentId !== entry.agentId) throw new AnsError("NAME_MISMATCH", `status token is for ${token.agentId}, not ${entry.agentId}`);
    if (token.ansName !== ansName) throw new AnsError("NAME_MISMATCH", `agent ${entry.agentId} is ${token.ansName}, not ${ansName}`);
    if (token.status !== "ACTIVE") throw new AnsError("AGENT_NOT_ACTIVE", `${ansName} is ${token.status}`);
    if (this.now() >= token.exp) throw new AnsError("STATUS_EXPIRED", `status token expired at ${token.exp}`);

    const leaf = verifyReceipt(await this.source.identityReceipt(entry.identityId), this.rootKeys) as {
      payload?: { producer?: { event?: IdentityEvent } };
    };
    const event = leaf?.payload?.producer?.event;
    if (!event || event.identityId !== entry.identityId) {
      throw new AnsError("IDENTITY_NOT_LINKED", `receipt is not for identity ${entry.identityId}`);
    }
    if (event.eventType !== "IDENTITY_LINKED") {
      throw new AnsError("IDENTITY_NOT_LINKED", `latest identity event is ${String(event.eventType)}, not IDENTITY_LINKED`);
    }
    if (!Array.isArray(event.ansIds) || !event.ansIds.includes(entry.agentId)) {
      throw new AnsError("IDENTITY_NOT_LINKED", `identity ${entry.identityId} is not linked to agent ${entry.agentId}`);
    }
    if (event.kind !== "did:key" || typeof event.value !== "string") {
      throw new AnsError("UNSUPPORTED_IDENTITY", `identity kind ${String(event.kind)} is not did:key`);
    }

    return {
      ansName,
      agentId: entry.agentId,
      status: token.status,
      statusExp: token.exp,
      identity: event.value,
      identityId: entry.identityId,
      keys: [didKeyToJwk(event.value)],
    };
  }

  async resolveKeys(ansName: string): Promise<JWK[]> {
    try {
      return (await this.resolve(ansName)).keys;
    } catch (error) {
      if (error instanceof AnsError) return [];
      throw error;
    }
  }

  async isAnchored(ansName: string): Promise<boolean> {
    try {
      await this.resolve(ansName);
      return true;
    } catch (error) {
      if (error instanceof AnsError) return false;
      throw error;
    }
  }
}
