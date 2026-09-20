import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { AnsError, HttpTlSource, jwkToDidKey, parseRootKeys, TransparencyLogDirectory, type DirectoryEntry, type ResolvedAgent } from "../lib/ans";
import { kidFor } from "../lib/mandate";

const RA_URL = process.env.RA_URL ?? "http://localhost:18080";
const TL_URL = process.env.TL_URL ?? "http://localhost:18081";
const RA_API_KEY = process.env.RA_API_KEY ?? "ans-dev-key-change-me";
const TL_API_KEY = process.env.TL_API_KEY ?? "tl-internal-key";
const ANS_REPO = resolve(process.env.ANS_REPO ?? "ans");
const OUT = resolve(process.env.BURN402_STATE ?? ".burn402");
const DOMAIN = process.env.BURN402_DOMAIN ?? "burn402.xyz";
const VERSION = process.env.BURN402_AGENT_VERSION ?? "1.0.0";
const AGENTS = (process.env.BURN402_AGENTS ?? "ops,broker,auditor,stresstester,helper").split(",");

type Registered = {
  name: string;
  ansName: string;
  agentId: string;
  identityId: string;
  did: string;
  kid: string;
};

async function ra(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${RA_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${RA_API_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function registerAgent(host: string): string {
  const script = join(ANS_REPO, "scripts", "demo", "register.sh");
  if (!existsSync(script)) throw new Error(`ANS reference repo not found at ${ANS_REPO}`);
  let out: string;
  try {
    out = execFileSync(script, ["--v2", host, VERSION], {
      cwd: ANS_REPO,
      env: { ...process.env, RA_URL, TL_URL, RA_API_KEY, TL_API_KEY, NO_COLOR: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    const detail = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const hint = detail.includes("409") ? " (already registered: restart the ANS stack with ans/scripts/demo/start.sh, or set BURN402_AGENT_VERSION)" : "";
    throw new Error(`register.sh failed for ${host}${hint}\n${detail.slice(-1500)}`);
  }
  const lines = out.trim().split("\n");
  const agentId = lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!/^[0-9a-f-]{36}$/.test(agentId)) throw new Error(`register.sh did not print an agentId for ${host}`);
  return agentId;
}

async function proveControl(publicJwk: JWK, privateKey: CryptoKey, kid: string, signingInput: string): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid, jwk: publicJwk })).toString("base64url");
  const toSign = `${header}.${signingInput}`;
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(toSign));
  return `${toSign}.${Buffer.from(signature).toString("base64url")}`;
}

async function mintKey(): Promise<{ privateKey: CryptoKey; publicJwk: JWK; privateJwk: JWK; did: string; kid: string }> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  return { privateKey: privateKey as CryptoKey, publicJwk, privateJwk, did: jwkToDidKey(publicJwk), kid: await kidFor(publicJwk) };
}

async function registerOne(name: string, keysDir: string): Promise<Registered> {
  const host = `${name}.${DOMAIN}`;
  const ansName = `ans://v${VERSION}.${host}`;
  process.stdout.write(`${ansName}\n`);

  const agentId = registerAgent(host);
  process.stdout.write(`  agent      ${agentId} ACTIVE\n`);

  const key = await mintKey();
  const identity = await ra("POST", "/v2/ans/identities", { value: key.did });
  const identityId = String(identity.identityId);
  const challenge = (identity.challenges as { kid: string; signingInput: string }[])[0];
  await ra("POST", `/v2/ans/identities/${identityId}/verify-control`, {
    signedProofs: [await proveControl(key.publicJwk, key.privateKey, challenge.kid, challenge.signingInput)],
  });
  process.stdout.write(`  identity   ${key.did} VERIFIED\n`);

  const linked = await ra("POST", `/v2/ans/identities/${identityId}/links`, { agentIds: [agentId] });
  if (linked.linked !== 1) throw new Error(`link failed for ${ansName}: ${JSON.stringify(linked)}`);
  process.stdout.write(`  linked     ${identityId} -> ${agentId}\n`);

  writeFileSync(join(keysDir, `${name}.json`), JSON.stringify({ ansName, kid: key.kid, privateJwk: key.privateJwk }, null, 2), { mode: 0o600 });
  return { name, ansName, agentId, identityId, did: key.did, kid: key.kid };
}

async function resolveWhenSealed(directory: TransparencyLogDirectory, ansName: string): Promise<ResolvedAgent> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await directory.resolve(ansName);
    } catch (error) {
      if (!(error instanceof AnsError) || error.code !== "TL_UNAVAILABLE" || attempt >= 20) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function main() {
  const keysDir = join(OUT, "keys");
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });

  const rootKeysText = await (await fetch(`${TL_URL}/root-keys`, { headers: { Authorization: `Bearer ${TL_API_KEY}` } })).text();
  const rootKeys = parseRootKeys(rootKeysText);
  if (rootKeys.size === 0) throw new Error("TL returned no usable root keys");
  writeFileSync(join(OUT, "tl-root-keys.txt"), rootKeysText);

  const humanFile = join(keysDir, "human.json");
  let humanDid: string;
  if (existsSync(humanFile)) {
    humanDid = (JSON.parse(readFileSync(humanFile, "utf8")) as { principal: string }).principal;
    process.stdout.write(`human root   ${humanDid} (kept)\n\n`);
  } else {
    const human = await mintKey();
    writeFileSync(humanFile, JSON.stringify({ principal: human.did, kid: human.kid, privateJwk: human.privateJwk }, null, 2), { mode: 0o600 });
    humanDid = human.did;
    process.stdout.write(`human root   ${humanDid}\n\n`);
  }

  const directoryFile = join(OUT, "directory.json");
  const existing: Record<string, DirectoryEntry> = existsSync(directoryFile) && process.env.BURN402_FRESH !== "1" ? JSON.parse(readFileSync(directoryFile, "utf8")) : {};
  const wanted = AGENTS.filter((name) => !existing[`ans://v${VERSION}.${name}.${DOMAIN}`]);
  for (const name of AGENTS.filter((n) => !wanted.includes(n))) process.stdout.write(`ans://v${VERSION}.${name}.${DOMAIN} already registered (kept)\n`);

  const registered: Registered[] = [];
  for (const name of wanted) registered.push(await registerOne(name, keysDir));

  const entries: Record<string, DirectoryEntry> = {
    ...existing,
    ...Object.fromEntries(registered.map((r) => [r.ansName, { agentId: r.agentId, identityId: r.identityId }])),
  };
  writeFileSync(directoryFile, JSON.stringify(entries, null, 2));
  writeFileSync(join(OUT, "root-principals.json"), JSON.stringify([humanDid], null, 2));

  const directory = new TransparencyLogDirectory({ source: new HttpTlSource(TL_URL, TL_API_KEY), rootKeys, entries });
  process.stdout.write("\nverifying against the transparency log\n");
  for (const r of registered) {
    const resolved = await resolveWhenSealed(directory, r.ansName);
    const kid = await kidFor(resolved.keys[0]);
    if (kid !== r.kid) throw new Error(`${r.ansName}: TL key ${kid} does not match minted key ${r.kid}`);
    process.stdout.write(`  ok ${r.ansName.padEnd(36)} kid ${kid}\n`);
  }
  process.stdout.write(`\n${registered.length} new agent(s); directory now lists ${Object.keys(entries).length} under ${OUT}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
