import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importJWK, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { HttpTlSource, parseRootKeys, TransparencyLogDirectory } from "../ans";
import { verdictJti, VERDICT_TYP, type Verdict } from "../auditor";
import { signJws } from "../mandate";
import { anchorVerdict, historyFor, TurboGateway, type AnchorPolicy } from "./index";

const STATE = join(process.cwd(), ".burn402");
const live = process.env.BURN402_LIVE_ARWEAVE === "1" && existsSync(join(STATE, "directory.json"));

function state<T>(name: string): T {
  return JSON.parse(readFileSync(join(STATE, name), "utf8")) as T;
}

describe.runIf(live)("live Arweave testnet", () => {
  it("anchors a verdict signed by the ANS-registered auditor and reads it back by FQDN", { timeout: 120_000 }, async () => {
    const directory = new TransparencyLogDirectory({
      source: new HttpTlSource(process.env.TL_URL ?? "http://localhost:18081", process.env.TL_API_KEY ?? "tl-internal-key"),
      rootKeys: parseRootKeys(readFileSync(join(STATE, "tl-root-keys.txt"), "utf8")),
      entries: state("directory.json"),
    });
    const auditorFile = state<{ ansName: string; kid: string; privateJwk: JWK }>("keys/auditor.json");
    const gateway = new TurboGateway({ network: "testnet", privateJwk: auditorFile.privateJwk });
    const policy: AnchorPolicy = {
      gateway,
      resolveAuditorKeys: (iss) => directory.resolveKeys(iss),
      trustedAuditors: [auditorFile.ansName],
    };

    const fqdn = `rogue-${Date.now()}.burn402.xyz`;
    const evidence = `sha256:${Buffer.from(fqdn).toString("hex").padEnd(64, "0").slice(0, 64)}`;
    const verdict: Verdict = {
      jti: verdictJti(auditorFile.ansName, evidence),
      iss: auditorFile.ansName,
      subject: `ans://v1.0.0.${fqdn}`,
      fqdn,
      chain: [],
      evidence,
      verdict: "BREACH",
      checks: [{ id: "rate_ceiling", result: "FAIL", detail: "provisioned 2.04/hr against mandate rate 1.36/hr", failure_mode: "RATE_CEILING_EXCEEDED" }],
      failure_mode: "RATE_CEILING_EXCEEDED",
      issued_at: Math.floor(Date.now() / 1000),
    };
    const jws = await signJws(verdict, { privateKey: (await importJWK(auditorFile.privateJwk, "EdDSA")) as CryptoKey, kid: auditorFile.kid }, VERDICT_TYP);

    const anchored = await anchorVerdict(policy, jws);
    expect(anchored.status).toBe("ANCHORED");

    let history = await historyFor(policy, fqdn);
    for (let i = 0; i < 20 && history.entries.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      history = await historyFor(policy, fqdn);
    }
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].verdict.jti).toBe(verdict.jti);
    expect(history.rejected).toEqual([]);

    expect((await anchorVerdict(policy, jws)).status).toBe("DUPLICATE");
  });
});
