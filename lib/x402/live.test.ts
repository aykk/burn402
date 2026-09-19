import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { importJWK, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { didKeyToJwk, HttpTlSource, parseRootKeys, TransparencyLogDirectory } from "../ans";
import { Broker, FakeResource } from "../burn";
import { mandateHash, MandateRegistry, signMandate, toCompact, type SigningKey } from "../mandate";
import { payingFetch, ProvisionGate, receiptVerifier, requestProvision, X402Processor } from "./index";

const STATE = join(process.cwd(), ".burn402");
const ENV = join(process.cwd(), ".env.local");
const live = process.env.BURN402_LIVE_X402 === "1" && existsSync(join(STATE, "directory.json")) && existsSync(ENV);

function env(name: string): string {
  const value = new RegExp(`^${name}=(.+)$`, "m").exec(readFileSync(ENV, "utf8"))?.[1]?.trim();
  if (!value) throw new Error(`${name} missing from .env.local`);
  return value;
}

function state<T>(name: string): T {
  return JSON.parse(readFileSync(join(STATE, name), "utf8")) as T;
}

async function signer(name: string): Promise<SigningKey & { id: string }> {
  const f = state<{ ansName?: string; principal?: string; kid: string; privateJwk: JWK }>(`keys/${name}.json`);
  return { privateKey: (await importJWK(f.privateJwk, "EdDSA")) as CryptoKey, kid: f.kid, id: f.ansName ?? f.principal! };
}

async function toRequest(req: IncomingMessage, base: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  return new Request(new URL(req.url ?? "/", base), { method: req.method, headers, body: req.method === "GET" ? undefined : Buffer.concat(chunks) });
}

async function usdcBalance(owner: string): Promise<number> {
  const res = await fetch("https://api.devnet.solana.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [owner, { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }, { encoding: "jsonParsed" }],
    }),
  });
  const body = (await res.json()) as { result: { value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }[] } };
  return body.result.value.reduce((sum, a) => sum + a.account.data.parsed.info.tokenAmount.uiAmount, 0);
}

describe.runIf(live)("live x402 on Solana devnet", () => {
  it("an ANS agent pays real devnet USDC through the facilitator and gets a signed receipt", { timeout: 180_000 }, async () => {
    const directory = new TransparencyLogDirectory({
      source: new HttpTlSource(process.env.TL_URL ?? "http://localhost:18081", process.env.TL_API_KEY ?? "tl-internal-key"),
      rootKeys: parseRootKeys(readFileSync(join(STATE, "tl-root-keys.txt"), "utf8")),
      entries: state("directory.json"),
    });
    const principals = state<string[]>("root-principals.json");
    const registry = new MandateRegistry({
      resolveAgentKeys: (iss) => directory.resolveKeys(iss),
      resolveRootKeys: async (iss) => (principals.includes(iss) ? [didKeyToJwk(iss)] : []),
      isAnchored: (iss) => directory.isAnchored(iss),
    });
    const human = await signer("human");
    const ops = await signer("ops");
    const worker = await signer("rogue");
    const broker = await signer("broker");
    const payTo = env("SOLANA_RECEIVER_ADDRESS");
    const now = Math.floor(Date.now() / 1000);

    const root = toCompact(
      await signMandate(
        { jti: "m_x402_root", iss: human.id, sub: ops.id, aud: ops.id, parent: null, depth: 0, max_depth: 3, scope: ["compute:provision"], limit_usd: 1, rate_usd_hr: 0.01, nbf: now - 60, exp: now + 3600 },
        human,
      ),
    );
    const leaf = toCompact(
      await signMandate(
        { jti: `m_x402_${now}`, iss: ops.id, sub: worker.id, aud: worker.id, parent: mandateHash(root), depth: 1, max_depth: 3, scope: ["compute:provision"], limit_usd: 0.5, rate_usd_hr: 0.01, nbf: now - 60, exp: now + 3600 },
        ops,
      ),
    );

    const gateBox: { gate?: ProvisionGate } = {};
    const server = createServer(async (req, res) => {
      const response = await gateBox.gate!.handle(await toRequest(req, "http://localhost"));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://localhost:${(server.address() as AddressInfo).port}/provision`;

    gateBox.gate = new ProvisionGate({
      registry,
      broker: new Broker({ registry, resource: new FakeResource({ "demo-cpu": 0.001 }, () => Date.now() / 1000), now: () => Math.floor(Date.now() / 1000) }),
      processor: new X402Processor({ payTo }),
      resolveAgentKeys: (iss) => directory.resolveKeys(iss),
      brokerName: broker.id,
      brokerKey: broker,
      payTo,
      resourceUrl: url,
    });

    const before = await usdcBalance(payTo);
    try {
      const result = await requestProvision({
        url,
        chain: [root, leaf],
        mandate: mandateHash(leaf),
        subject: worker.id,
        subjectKey: worker,
        plan: "demo-cpu",
        region: "ewr",
        fetch: await payingFetch(env("AGENT_SOLANA_SECRET_KEY")),
      });
      process.stdout.write(`status ${result.status} ${JSON.stringify(result.body).slice(0, 400)}\n`);
      expect(result.status).toBe(200);
      const body = result.body as { receipt: { tx: string; usd: number; sig: string; mandate_jti: string } };
      process.stdout.write(`tx https://explorer.solana.com/tx/${body.receipt.tx}?cluster=devnet\n`);
      expect(await receiptVerifier((iss) => directory.resolveKeys(iss), [broker.id])({ mandate_jti: body.receipt.mandate_jti, usd: body.receipt.usd, tx: body.receipt.tx, sig: body.receipt.sig })).toBe(true);

      let after = await usdcBalance(payTo);
      for (let i = 0; i < 10 && after <= before; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        after = await usdcBalance(payTo);
      }
      expect(after - before).toBeCloseTo(0.001, 6);
    } finally {
      server.close();
    }
  });
});
