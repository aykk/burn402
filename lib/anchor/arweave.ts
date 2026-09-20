import { TurboUpload, PRODUCTION, TESTNET } from "@ardrive/turbo-upload";
import type { JWK } from "jose";

export type ArweaveTag = { name: string; value: string };

export type ArweaveItem = {
  id: string;
  ownerKey: string;
  tags: ArweaveTag[];
  blockAt: number | null;
};

export interface ArweaveGateway {
  readonly ownerKey: string | null;
  upload(data: Uint8Array, tags: ArweaveTag[]): Promise<{ id: string; ownerKey: string }>;
  query(tags: ArweaveTag[], first?: number): Promise<ArweaveItem[]>;
  item(id: string): Promise<ArweaveItem | null>;
  fetchData(id: string): Promise<Uint8Array>;
}

export type Network = "testnet" | "production";

export function ed25519SecretKey(privateJwk: JWK): Buffer {
  if (privateJwk.kty !== "OKP" || privateJwk.crv !== "Ed25519" || !privateJwk.d || !privateJwk.x) {
    throw new Error("an Ed25519 private JWK is required to sign Arweave items");
  }
  return Buffer.concat([Buffer.from(privateJwk.d, "base64url"), Buffer.from(privateJwk.x, "base64url")]);
}

export class TurboGateway implements ArweaveGateway {
  readonly network: Network;
  readonly gatewayUrl: string;
  readonly ownerKey: string | null;
  private readonly client: TurboUpload | null;

  constructor(options: { network: Network; privateJwk?: JWK; gatewayUrl?: string }) {
    const env = options.network === "production" ? PRODUCTION : TESTNET;
    this.network = options.network;
    this.gatewayUrl = (options.gatewayUrl ?? env.gatewayUrl).replace(/\/$/, "");
    this.client = options.privateJwk
      ? new TurboUpload({ jwk: ed25519SecretKey(options.privateJwk), token: "solana", uploadUrl: env.uploadUrl, paymentUrl: env.paymentUrl })
      : null;
    this.ownerKey = this.client ? this.client.owner.toString("base64url") : null;
  }

  async upload(data: Uint8Array, tags: ArweaveTag[]): Promise<{ id: string; ownerKey: string }> {
    if (!this.client) throw new Error("this gateway was created without a signing key");
    const result = await this.client.upload({ data: Buffer.from(data), tags });
    return { id: result.id, ownerKey: this.client.owner.toString("base64url") };
  }

  query(tags: ArweaveTag[], first = 100): Promise<ArweaveItem[]> {
    return this.graphql(
      "query($tags: [TagFilter!], $first: Int) { transactions(tags: $tags, first: $first, sort: HEIGHT_ASC) { edges { node { id owner { key } block { timestamp } tags { name value } } } } }",
      { tags: tags.map((t) => ({ name: t.name, values: [t.value] })), first },
    );
  }

  async item(id: string): Promise<ArweaveItem | null> {
    const [found] = await this.graphql("query($ids: [ID!]) { transactions(ids: $ids) { edges { node { id owner { key } block { timestamp } tags { name value } } } } }", { ids: [id] });
    return found ?? null;
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<ArweaveItem[]> {
    const response = await fetch(`${this.gatewayUrl}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`graphql HTTP ${response.status}`);
    const body = (await response.json()) as {
      data?: { transactions?: { edges?: { node: { id: string; owner: { key: string }; block: { timestamp: number } | null; tags: ArweaveTag[] } }[] } };
      errors?: unknown;
    };
    if (body.errors) throw new Error(`graphql error: ${JSON.stringify(body.errors).slice(0, 300)}`);
    return (body.data?.transactions?.edges ?? []).map(({ node }) => ({
      id: node.id,
      ownerKey: node.owner.key,
      tags: node.tags ?? [],
      blockAt: node.block?.timestamp ?? null,
    }));
  }

  async fetchData(id: string): Promise<Uint8Array> {
    const response = await fetch(`${this.gatewayUrl}/${encodeURIComponent(id)}`, { redirect: "follow" });
    if (!response.ok) throw new Error(`fetch ${id}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
