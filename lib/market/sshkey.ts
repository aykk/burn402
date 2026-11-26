import { generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const COMMENT = "agent-rental";
const KEY_TYPE = "ssh-ed25519";
const BLOCK = 8;

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const sshString = (v: Buffer | string) => {
  const b = typeof v === "string" ? Buffer.from(v) : v;
  return Buffer.concat([u32(b.length), b]);
};

/**
 * A fresh ed25519 key in OpenSSH format. The private file is written once (never overwritten)
 * with mode 0o600 next to `<name>.pub`; only the public line and the file path are returned.
 */
export function newSshKey(dir: string, name: string): { publicKey: string; privatePath: string } {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) throw new Error("the key name must be a plain file name");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const secret = Buffer.concat([seed, pub]);

  const pubBlob = Buffer.concat([sshString(KEY_TYPE), sshString(pub)]);
  const check = randomBytes(4);
  const section = Buffer.concat([check, check, sshString(KEY_TYPE), sshString(pub), sshString(secret), sshString(COMMENT)]);
  const padLen = (BLOCK - (section.length % BLOCK)) % BLOCK;
  const padding = Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1));
  const privSection = Buffer.concat([section, padding]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    u32(1),
    sshString(pubBlob),
    sshString(privSection),
  ]);
  const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
  seed.fill(0);
  secret.fill(0);
  section.fill(0);
  privSection.fill(0);
  body.fill(0);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const privatePath = path.resolve(dir, name);
  fs.writeFileSync(privatePath, pem, { mode: 0o600, flag: "wx" });
  fs.chmodSync(privatePath, 0o600);
  const line = `${KEY_TYPE} ${pubBlob.toString("base64")} ${COMMENT}`;
  fs.writeFileSync(`${privatePath}.pub`, `${line}\n`, { mode: 0o644, flag: "wx" });
  return { publicKey: line, privatePath };
}
