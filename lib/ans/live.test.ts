import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importJWK, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { MandateRegistry, signMandate, type Mandate, type SigningKey } from "../mandate";
import { didKeyToJwk, HttpTlSource, parseRootKeys, TransparencyLogDirectory } from "./index";

const STATE = join(process.cwd(), ".burn402");
const live = process.env.BURN402_LIVE === "1" && existsSync(join(STATE, "directory.json"));

function state<T>(name: string): T {
  return JSON.parse(readFileSync(join(STATE, name), "utf8")) as T;
}

async function signer(name: string): Promise<SigningKey & { id: string }> {
  const file = state<{ ansName?: string; principal?: string; kid: string; privateJwk: JWK }>(`keys/${name}.json`);
  return { privateKey: (await importJWK(file.privateJwk, "EdDSA")) as CryptoKey, kid: file.kid, id: file.ansName ?? file.principal! };
}

describe.runIf(live)("live ANS transparency log", () => {
  it("admits a real chain whose keys come only from the TL, and refuses a forged link", async () => {
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
    const rogue = await signer("rogue");
    const broker = (await signer("broker")).id;
    const now = Math.floor(Date.now() / 1000);

    const root: Mandate = {
      jti: "m_live_root",
      iss: human.id,
      sub: ops.id,
      aud: ops.id,
      parent: null,
      depth: 0,
      max_depth: 3,
      scope: ["compute:provision"],
      limit_usd: 20,
      rate_usd_hr: 1.36,
      nbf: now - 60,
      exp: now + 3600,
    };
    const rootResult = await registry.admitRoot(await signMandate(root, human));
    expect(rootResult.ok).toBe(true);
    if (!rootResult.ok) return;

    const delegation: Mandate = { ...root, jti: "m_live_broker", iss: ops.id, sub: broker, aud: broker, parent: rootResult.mandate.hash, depth: 1 };
    const accepted = await registry.admit(await signMandate(delegation, ops));
    expect(accepted.ok).toBe(true);

    const forged = await registry.admit(await signMandate({ ...delegation, jti: "m_live_forged" }, { privateKey: rogue.privateKey, kid: ops.kid }));
    expect(forged).toMatchObject({ ok: false, refusal: { rule: 11, code: "SIGNATURE_INVALID" } });
  });
});
