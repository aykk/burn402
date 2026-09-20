import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importJWK, type JWK } from "jose";
import { HttpTlSource, parseRootKeys, TransparencyLogDirectory, type DirectoryEntry } from "../ans";
import { registrationConfig } from "./register";
import { anchorTransaction, TurboGateway, type AnchorPolicy, type Disclosure, type Network } from "../anchor";
import type { Auditor } from "../auditor";
import { Broker, FakeResource, VultrResource, type Resource } from "../burn";
import { MandateRegistry, type SigningKey } from "../mandate";
import { TrustIndexClient } from "../trust";
import { publicAuditDeps, rootKeysFor } from "../verify";
import { ProvisionGate, X402Processor, type TransactionRecord } from "../x402";
import { DemoLog } from "./log";
import { WalletWatcher } from "./wallets";
import { bootScript, ServerTracker } from "./servers";

export type Actor = SigningKey & { name: string; privateJwk: JWK };

export type DemoConfig = {
  root: string;
  registration: ReturnType<typeof registrationConfig>;
  tlUrl: string;
  tlApiKey: string;
  trustIndexUrl: string;
  region: string;
  prepayHours: number;
  resource: "simulated" | "vultr";
  brokerUrl: string;
  agentSecretKey: string | null;
  agentAddress: string | null;
  payTo: string | null;
};

export function defaultNetwork(): Network {
  return process.env.BURN402_ARWEAVE_NETWORK === "testnet" ? "testnet" : "production";
}

export function configFromEnv(root = process.cwd()): DemoConfig {
  return {
    root,
    registration: registrationConfig(root),
    tlUrl: process.env.TL_URL ?? "http://localhost:18081",
    tlApiKey: process.env.TL_API_KEY ?? "tl-internal-key",
    trustIndexUrl: process.env.TRUST_INDEX_URL ?? "http://localhost:8090",
    region: process.env.BURN402_REGION ?? "ewr",
    prepayHours: Number(process.env.BURN402_PREPAY_HOURS ?? 1 / 12),
    resource: process.env.BURN402_RESOURCE === "simulated" || !process.env.VULTR_API_KEY ? "simulated" : "vultr",
    brokerUrl: process.env.BURN402_BROKER_URL ?? "http://localhost:3000/api/provision",
    agentSecretKey: process.env.AGENT_SOLANA_SECRET_KEY ?? null,
    agentAddress: process.env.AGENT_SOLANA_ADDRESS ?? null,
    payTo: process.env.SOLANA_RECEIVER_ADDRESS ?? null,
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

function simulatedResource(root: string, region: string, now: () => number): FakeResource {
  const plans = readJson<{ plans: { id: string; hourly_cost: number; locations: string[]; location_cost?: Record<string, { hourly_cost?: number }> }[] }>(
    join(root, "fixtures", "vultr", "plans.json"),
  ).plans;
  const prices = Object.fromEntries(
    plans.filter((p) => p.locations.includes(region)).map((p) => [p.id, p.location_cost?.[region]?.hourly_cost ?? p.hourly_cost]),
  );
  return new FakeResource(prices, now, "gpu");
}

export type Runtime = {
  config: DemoConfig;
  log: DemoLog;
  actors: { human: Actor; ops: Actor; broker: Actor; auditor: Actor; stresstester: Actor; helper: Actor; vultr: Actor; company?: Actor };
  entries: Record<string, DirectoryEntry>;
  tl: HttpTlSource;
  directory: TransparencyLogDirectory;
  registry: MandateRegistry;
  resource: Resource;
  broker: Broker;
  gate: ProvisionGate | null;
  gateUrl: string;
  auditor: Auditor;
  anchor: AnchorPolicy;
  arweave: TurboGateway;
  network: Network;
  disclosure: Disclosure;
  trust: TrustIndexClient;
  wallets: WalletWatcher;
  servers: ServerTracker;
  ledger: LedgerEntry[];
  transactions: StoredTransaction[];
  pendingBoot: Map<string, (plan: string, subject: string) => string>;
  runId: string;
};

export type StoredTransaction = TransactionRecord & {
  arweaveId: string | null;
  arweaveUrl: string | null;
  network: Network;
  storage: "uploading" | "stored" | "failed";
  storageError: string | null;
  solscan: string | null;
};

export type LedgerEntry = {
  at: number;
  from: string;
  to: string;
  usdc: number;
  tx: string;
  link: string;
  what: string;
  fromBefore: number | null;
  toBefore: number | null;
  fromAfter: number | null;
  toAfter: number | null;
};

export function displayName(ans: string): string {
  const name = /^ans:\/\/v[\d.]+\.([^.]+)\./.exec(ans)?.[1] ?? ans;
  return ({ ops: "your agent", helper: "helper", stresstester: "stress tester", broker: "broker", auditor: "auditor" } as Record<string, string>)[name] ?? name;
}

export function setDisclosure(rt: Runtime, disclosure: Disclosure): void {
  rt.disclosure = disclosure;
  rt.log.info(
    disclosure === "full"
      ? "your own words now go on Arweave with the negotiation, permanently and publicly"
      : "only the desk's side of the negotiation goes on Arweave; your words are stored as a hash",
  );
}

export function setNetwork(rt: Runtime, network: Network): void {
  rt.network = network;
  rt.arweave = new TurboGateway({ network, privateJwk: rt.actors.auditor.privateJwk });
  rt.anchor = { gateway: rt.arweave, resolveAuditorKeys: (iss) => rt.directory.resolveKeys(iss), trustedAuditors: [rt.actors.auditor.name] };
  rt.log.info(`verdicts now go to Arweave ${network === "production" ? "mainnet (permanent and public)" : "testnet (not permanent)"}`);
}

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
    auditor: await loadActor(config.root, "auditor"),
    stresstester: await loadActor(config.root, "stresstester"),
    helper: await loadActor(config.root, "helper"),
    vultr: await loadActor(config.root, "vultr"),
  };

  const clock = () => Date.now() / 1000;
  const registry = new MandateRegistry({
    resolveAgentKeys: (iss) => directory.resolveKeys(iss),
    resolveRootKeys: rootKeysFor,
    isAnchored: (iss) => directory.isAnchored(iss),
    onEvent: (e) => log.fromDelegation(e),
  });

  const vultrKey = process.env.VULTR_API_KEY;
  const resource: Resource =
    config.resource === "vultr" && vultrKey ? new VultrResource({ apiKey: vultrKey }) : simulatedResource(config.root, config.region, clock);
  const servers = new ServerTracker(resource);
  servers.start();
  const ledger: LedgerEntry[] = [];
  const transactions: StoredTransaction[] = [];
  const pendingBoot = new Map<string, (plan: string, subject: string) => string>();
  const box: { rt?: Runtime } = {};

  const storeTransaction = async (record: TransactionRecord) => {
    const rtNow = box.rt;
    const network: Network = rtNow?.network ?? defaultNetwork();
    const entry: StoredTransaction = {
      ...record,
      arweaveId: null,
      arweaveUrl: null,
      network,
      storage: "uploading",
      storageError: null,
      solscan: record.tx ? `https://solscan.io/tx/${record.tx}?cluster=devnet` : null,
    };
    transactions.push(entry);
    try {
      const gateway = new TurboGateway({ network, privateJwk: actors.broker.privateJwk });
      const { id } = await anchorTransaction({ gateway, broker: actors.broker.name, brokerKey: actors.broker, record });
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

  const broker = new Broker({
    registry,
    resource,
    now: clock,
    onEvent: (e) => {
      log.fromBurn(e);
      if (e.type === "RESOURCE_PROVISIONED") {
        const sub = registry.get(e.mandate)?.mandate.sub ?? "";
        void servers.add(e.handle, { rentedBy: displayName(sub), how: "through the broker, paid over x402", plan: e.plan, region: config.region, hourlyUsd: e.hourly_usd });
      }
      if (e.type === "RESOURCE_REAPED") servers.markShutDown(e.handle, "its budget ran out");
      if (e.type === "RESOURCE_RELEASED") servers.markShutDown(e.handle, "released");
    },
  });
  broker.startReaper();

  const gateUrl = config.brokerUrl;
  const wallets = new WalletWatcher(
    [
      config.agentAddress ? { role: "stress tester (pays)", address: config.agentAddress } : null,
      config.payTo ? { role: "you (receive)", address: config.payTo } : null,
    ].filter((w): w is { role: string; address: string } => w !== null),
  );
  wallets.start();

  const recordPayment = async (tx: string, usdc: number, what: string) => {
    const payer = wallets.wallets[0];
    const payee = wallets.wallets[1];
    const entry: LedgerEntry = {
      at: Date.now(),
      from: "stress tester's wallet",
      to: "your wallet",
      usdc,
      tx,
      link: `https://solscan.io/tx/${tx}?cluster=devnet`,
      what,
      fromBefore: payer?.usdc ?? null,
      toBefore: payee?.usdc ?? null,
      fromAfter: null,
      toAfter: null,
    };
    ledger.push(entry);
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      await wallets.refresh();
      if (payee?.usdc !== null && payee?.usdc !== entry.toBefore) break;
    }
    entry.fromAfter = payer?.usdc ?? null;
    entry.toAfter = payee?.usdc ?? null;
  };

  const gate =
    config.payTo && config.agentSecretKey
      ? new ProvisionGate({
          registry,
          broker,
          processor: new X402Processor({ payTo: config.payTo }),
          resolveAgentKeys: (iss) => directory.resolveKeys(iss),
          brokerName: actors.broker.name,
          brokerKey: actors.broker,
          payTo: config.payTo,
          resourceUrl: gateUrl,
          prepayHours: config.prepayHours,
          decorateSpec: (spec, ctx) => ({
            ...spec,
            userData:
              pendingBoot.get(ctx.mandateJti)?.(spec.plan, ctx.subject) ??
              bootScript({
                rentedBy: ctx.subject,
                how: "through the broker, paid over x402",
                budget: `${ctx.mandateJti}, $${ctx.limitUsd} at up to $${ctx.rateUsdHr}/hour`,
                plan: spec.plan,
              }),
          }),
          onEvent: (e) => {
            log.fromGate(e);
            if (e.type === "PAYMENT_SETTLED") void recordPayment(e.tx, e.usd, `rent server ${e.handle}`);
            if (e.type === "TRANSACTION") void storeTransaction(e.record);
          },
        })
      : null;

  const network: Network = defaultNetwork();
  const arweave = new TurboGateway({ network, privateJwk: actors.auditor.privateJwk });
  const anchor: AnchorPolicy = { gateway: arweave, resolveAuditorKeys: (iss) => directory.resolveKeys(iss), trustedAuditors: [actors.auditor.name] };
  const auditor: Auditor = { name: actors.auditor.name, key: actors.auditor, deps: publicAuditDeps(directory, [actors.broker.name]) };

  log.info(
    `runtime up: ${Object.keys(entries).length} agents from the ANS transparency log, servers ${resource.kind === "vultr" ? "rented on Vultr" : "simulated (no VULTR_API_KEY)"}, x402 ${gate ? "on Solana devnet" : "disabled (set AGENT_SOLANA_SECRET_KEY and SOLANA_RECEIVER_ADDRESS)"}, Arweave testnet`,
  );

  const rt: Runtime = {
    config,
    log,
    actors,
    entries,
    tl,
    directory,
    registry,
    resource,
    broker,
    gate,
    gateUrl,
    auditor,
    anchor,
    arweave,
    network,
    disclosure: "desk-only",
    trust: new TrustIndexClient({ baseUrl: config.trustIndexUrl }),
    wallets,
    servers,
    ledger,
    transactions,
    pendingBoot,
    runId: Date.now().toString(36),
  };
  box.rt = rt;
  return rt;
}
