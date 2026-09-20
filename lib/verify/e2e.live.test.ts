import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importJWK, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { HttpTlSource, parseRootKeys, TransparencyLogDirectory, type DirectoryEntry } from "../ans";
import { TurboGateway } from "../anchor";
import type { EvidenceBundle } from "../auditor";
import { mandateHash, signMandate, toCompact, type SigningKey } from "../mandate";
import { publicAuditDeps, publishVerdict } from "./index";

const STATE = join(process.cwd(), ".burn402");
const live = process.env.BURN402_LIVE_E2E === "1" && existsSync(join(STATE, "directory.json"));

function state<T>(name: string): T {
  return JSON.parse(readFileSync(join(STATE, name), "utf8")) as T;
}

async function signer(name: string): Promise<SigningKey & { id: string; privateJwk: JWK }> {
  const f = state<{ ansName?: string; principal?: string; kid: string; privateJwk: JWK }>(`keys/${name}.json`);
  return { privateKey: (await importJWK(f.privateJwk, "EdDSA")) as CryptoKey, kid: f.kid, id: f.ansName ?? f.principal!, privateJwk: f.privateJwk };
}

describe.runIf(live)("live end to end: breach -> audit -> Arweave -> independent CLI verify", () => {
  it("the CLI reproduces the auditor's verdict from the anchored record alone", { timeout: 240_000 }, async () => {
    const tl = new HttpTlSource(process.env.TL_URL ?? "http://localhost:18081", process.env.TL_API_KEY ?? "tl-internal-key");
    const entries = state<Record<string, DirectoryEntry>>("directory.json");
    const rootKeys = parseRootKeys(readFileSync(join(STATE, "tl-root-keys.txt"), "utf8"));
    const directory = new TransparencyLogDirectory({ source: tl, rootKeys, entries });

    const human = await signer("human");
    const ops = await signer("ops");
    const rogue = await signer("rogue");
    const auditor = await signer("auditor");
    const now = Math.floor(Date.now() / 1000);

    const root = toCompact(
      await signMandate(
        { jti: `m_e2e_root_${now}`, iss: human.id, sub: ops.id, aud: ops.id, parent: null, depth: 0, max_depth: 3, scope: ["compute:provision"], limit_usd: 20, rate_usd_hr: 0.06, nbf: now - 7200, exp: now + 86400 },
        human,
      ),
    );
    const leaf = toCompact(
      await signMandate(
        { jti: `m_e2e_rogue_${now}`, iss: ops.id, sub: rogue.id, aud: rogue.id, parent: mandateHash(root), depth: 1, max_depth: 3, scope: ["compute:provision"], limit_usd: 8, rate_usd_hr: 0.06, nbf: now - 7200, exp: now + 86400 },
        ops,
      ),
    );
    const bundle: EvidenceBundle = {
      subject: rogue.id,
      chain: [root, leaf],
      delegations: [],
      usage: [{ mandate_jti: `m_e2e_rogue_${now}`, handle: "vultr-e2e", plan: "vcg-a16-2c-16g-4vram", hourly_usd: 0.118, started_at: now - 3600, ended_at: now - 60 }],
      receipts: [],
      observed_at: now,
    };

    const gateway = new TurboGateway({ network: "testnet", privateJwk: auditor.privateJwk });
    const { verdict, anchored } = await publishVerdict({
      auditor: { name: auditor.id, key: auditor, deps: publicAuditDeps(directory) },
      bundle,
      tl,
      entries,
      anchor: { gateway, resolveAuditorKeys: (iss) => directory.resolveKeys(iss), trustedAuditors: [auditor.id] },
      issuedAt: now,
    });
    expect(verdict).toMatchObject({ verdict: "BREACH", failure_mode: "RATE_CEILING_EXCEEDED" });
    expect(anchored.status).toBe("ANCHORED");
    const txid = (anchored as { id: string }).id;

    let output = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        output = execFileSync("npx", ["tsx", "cli/burn402.ts", "verify", txid, "--tl-root-keys", join(STATE, "tl-root-keys.txt")], { encoding: "utf8" });
        break;
      } catch (error) {
        output = String((error as { stdout?: string }).stdout ?? "");
        if (!output.includes("not found on the gateway")) throw new Error(output);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    process.stdout.write(`\n${output}\n`);
    expect(output).toContain("(reproduced)");
    expect(output).toContain("RATE_CEILING_EXCEEDED");
  });
});
