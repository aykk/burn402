import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { jwkToDidKey, type DirectoryEntry } from "../ans";
import { kidFor } from "../mandate";

export const NAME_PATTERN = /^[a-z][a-z0-9-]{1,22}[a-z0-9]$/;

export type RegisteredAgent = { name: string; ansName: string; agentId: string; identityId: string; kid: string };

type Config = {
  root: string;
  raUrl: string;
  tlUrl: string;
  raApiKey: string;
  tlApiKey: string;
  ansRepo: string;
  domain: string;
  version: string;
};

export function registrationConfig(root = process.cwd()): Config {
  return {
    root,
    raUrl: process.env.RA_URL ?? "http://localhost:18080",
    tlUrl: process.env.TL_URL ?? "http://localhost:18081",
    raApiKey: process.env.RA_API_KEY ?? "ans-dev-key-change-me",
    tlApiKey: process.env.TL_API_KEY ?? "tl-internal-key",
    ansRepo: resolve(process.env.ANS_REPO ?? join(root, "ans")),
    domain: process.env.BURN402_DOMAIN ?? "burn402.xyz",
    version: process.env.BURN402_AGENT_VERSION ?? "1.0.0",
  };
}

export function slugFor(input: string): string {
  if (input.trim().length > 32) throw new Error("that name is too long: 3 to 24 letters, numbers or hyphens");
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  if (!NAME_PATTERN.test(slug)) throw new Error("use 3 to 24 letters, numbers or hyphens, starting with a letter");
  return slug;
}

export function ansNameFor(slug: string, config = registrationConfig()): string {
  return `ans://v${config.version}.${slug}.${config.domain}`;
}

export function alreadyRegistered(slug: string, config = registrationConfig()): RegisteredAgent | null {
  const ansName = ansNameFor(slug, config);
  const directoryFile = join(config.root, ".burn402", "directory.json");
  const keyFile = join(config.root, ".burn402", "keys", `${slug}.json`);
  if (!existsSync(directoryFile) || !existsSync(keyFile)) return null;
  const entries = JSON.parse(readFileSync(directoryFile, "utf8")) as Record<string, DirectoryEntry>;
  const entry = entries[ansName];
  if (!entry) return null;
  const key = JSON.parse(readFileSync(keyFile, "utf8")) as { kid: string };
  return { name: slug, ansName, agentId: entry.agentId, identityId: entry.identityId, kid: key.kid };
}

async function ra(config: Config, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${config.raUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.raApiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function registerHost(config: Config, host: string): string {
  const script = join(config.ansRepo, "scripts", "demo", "register.sh");
  if (!existsSync(script)) throw new Error("the ANS reference repo is not where BURN402 expects it");
  const out = execFileSync(script, ["--v2", host, config.version], {
    cwd: config.ansRepo,
    env: { ...process.env, RA_URL: config.raUrl, TL_URL: config.tlUrl, RA_API_KEY: config.raApiKey, TL_API_KEY: config.tlApiKey, NO_COLOR: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
  const agentId = out.trim().split("\n").pop()!.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!/^[0-9a-f-]{36}$/.test(agentId)) throw new Error("the registration authority did not return an agent id");
  return agentId;
}

async function proveControl(publicJwk: JWK, privateKey: CryptoKey, kid: string, signingInput: string): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid, jwk: publicJwk })).toString("base64url");
  const toSign = `${header}.${signingInput}`;
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(toSign));
  return `${toSign}.${Buffer.from(signature).toString("base64url")}`;
}

export async function registerAgent(input: string, config = registrationConfig()): Promise<{ agent: RegisteredAgent; created: boolean }> {
  const slug = slugFor(input);
  const existing = alreadyRegistered(slug, config);
  if (existing) return { agent: existing, created: false };

  const host = `${slug}.${config.domain}`;
  const agentId = registerHost(config, host);

  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = await kidFor(publicJwk);

  const identity = await ra(config, "POST", "/v2/ans/identities", { value: jwkToDidKey(publicJwk) });
  const identityId = String(identity.identityId);
  const challenge = (identity.challenges as { kid: string; signingInput: string }[])[0];
  await ra(config, "POST", `/v2/ans/identities/${identityId}/verify-control`, {
    signedProofs: [await proveControl(publicJwk, privateKey as CryptoKey, challenge.kid, challenge.signingInput)],
  });
  const linked = await ra(config, "POST", `/v2/ans/identities/${identityId}/links`, { agentIds: [agentId] });
  if (linked.linked !== 1) throw new Error(`the identity did not link to ${host}`);

  const ansName = ansNameFor(slug, config);
  const keysDir = join(config.root, ".burn402", "keys");
  writeFileSync(join(keysDir, `${slug}.json`), JSON.stringify({ ansName, kid, privateJwk }, null, 2), { mode: 0o600 });

  const directoryFile = join(config.root, ".burn402", "directory.json");
  const entries = JSON.parse(readFileSync(directoryFile, "utf8")) as Record<string, DirectoryEntry>;
  entries[ansName] = { agentId, identityId };
  writeFileSync(directoryFile, JSON.stringify(entries, null, 2));

  return { agent: { name: slug, ansName, agentId, identityId, kid }, created: true };
}
