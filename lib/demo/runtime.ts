import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importJWK, type JWK } from "jose";
import { HttpTlSource, parseRootKeys, TransparencyLogDirectory, type DirectoryEntry } from "../ans";
import { anchorTransaction, TurboGateway, type Network } from "../anchor";
import { MandateRegistry, type SigningKey } from "../mandate";
import { rootKeysFor } from "../verify";
import type { TransactionRecord } from "../x402";
import { DemoLog } from "./log";

export type Actor = SigningKey & { name: string; privateJwk: JWK };

export type DemoConfig = {
  root: string;
  tlUrl: string;
  tlApiKey: string;
};

export function defaultNetwork(): Network {
  return process.env.BURN402_ARWEAVE_NETWORK === "production" ? "production" : "testnet";
}

export function configFromEnv(root = process.cwd()): DemoConfig {
  return {
    root,
    tlUrl: process.env.TL_URL ?? "http://localhost:18081",
    tlApiKey: process.env.TL_API_KEY ?? "tl-internal-key",
  };
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`${path} is missing; run npm run demo (it registers the agents)`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export async function loadActor(root: string, name: string): Promise<Actor> {
  const f = readJson<{ ansName?: string; principal?: string; kid: string; privateJwk: JWK }>(join(root, ".burn402", "keys", `${name}.json`));
  return {
    name: f.ansName ?? f.principal!,
    kid: f.kid,
    privateKey: (await importJWK(f.privateJwk, "EdDSA")) as CryptoKey,
    privateJwk: f.privateJwk,
  };
}

export type Runtime = {
  config: DemoConfig;
  log: DemoLog;
  /** human signs your limits; ops is your buying agent; broker's key signs and uploads the purchase records */
  actors: { human: Actor; ops: Actor; broker: Actor };
  entries: Record<string, DirectoryEntry>;
  tl: HttpTlSource;
  directory: TransparencyLogDirectory;
  registry: MandateRegistry;
  network: Network;
  transactions: StoredTransaction[];
  /** Stores a transaction record and anchors it on Arweave; anchoring failure is kept on the entry, never thrown. */
  storeTransaction: (record: TransactionRecord, options?: StoreOptions) => Promise<void>;
};

/** `signer` signs the record (default: the broker); `cluster` picks the Solscan link. */
export type StoreOptions = { signer?: Actor; cluster?: "devnet" | "mainnet" };

export type StoredTransaction = TransactionRecord & {
  mark: number | null;
  arweaveId: string | null;
  arweaveUrl: string | null;
  network: Network;
  storage: "uploading" | "stored" | "failed";
  storageError: string | null;
  solscan: string | null;
};

export async function createRuntime(config: DemoConfig): Promise<Runtime> {
  const log = new DemoLog();
  const state = join(config.root, ".burn402");
  const entries = readJson<Record<string, DirectoryEntry>>(join(state, "directory.json"));
  const rootKeys = parseRootKeys(readFileSync(join(config.root, "config", "ans", "tl-root-keys.txt"), "utf8"));
  const tl = new HttpTlSource(config.tlUrl, config.tlApiKey);
  const directory = new TransparencyLogDirectory({ source: tl, rootKeys, entries });

  const actors = {
    human: await loadActor(config.root, "human"),
    ops: await loadActor(config.root, "ops"),
    broker: await loadActor(config.root, "broker"),
  };

  const registry = new MandateRegistry({
    resolveAgentKeys: (iss) => directory.resolveKeys(iss),
    resolveRootKeys: rootKeysFor,
    isAnchored: (iss) => directory.isAnchored(iss),
    onEvent: (e) => log.fromDelegation(e),
  });

  const network: Network = defaultNetwork();
  const transactions: StoredTransaction[] = [];

  const storeTransaction = async (record: TransactionRecord, options: StoreOptions = {}) => {
    const signer = options.signer ?? actors.broker;
    const cluster = options.cluster ?? "devnet";
    const entry: StoredTransaction = {
      ...record,
      mark: null,
      arweaveId: null,
      arweaveUrl: null,
      network,
      storage: "uploading",
      storageError: null,
      solscan: record.tx ? `https://solscan.io/tx/${record.tx}${cluster === "devnet" ? "?cluster=devnet" : ""}` : null,
    };
    transactions.push(entry);
    try {
      const gateway = new TurboGateway({ network, privateJwk: actors.broker.privateJwk });
      const { id } = await anchorTransaction({ gateway, broker: signer.name, brokerKey: signer, record });
      entry.arweaveId = id;
      entry.arweaveUrl = `${gateway.gatewayUrl}/${id}`;
      entry.storage = "stored";
      log.push("anchor", "ARWEAVE", `transaction by ${record.subject} (${record.outcome}) stored`, { label: `ar://${id.slice(0, 10)}..`, href: entry.arweaveUrl });
    } catch (error) {
      entry.storage = "failed";
      entry.storageError = (error as Error).message;
      log.push("error", "ARWEAVE", `could not store transaction: ${entry.storageError}`);
    }
  };

  log.info(`runtime up: ${Object.keys(entries).length} agents from the ANS transparency log, records to Arweave ${network === "production" ? "mainnet" : "testnet"}`);

  return { config, log, actors, entries, tl, directory, registry, network, transactions, storeTransaction };
}
