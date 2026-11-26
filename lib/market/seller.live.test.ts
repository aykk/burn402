import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base58Encode, signerFromSecret } from "./auth";
import { NETWORKS } from "./guard";
import { SELLERS, SellerClient } from "./seller";

// Free calls only: GETs and an unpaid quote. Keys are generated here, never read from the environment.
const live = process.env.BURN402_LIVE_MARKET === "1";

function sshString(b: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
}

function throwawayKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const sshBlob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(pub)]);
  return { secret: base58Encode(new Uint8Array([...seed, ...pub])), sshPublicKey: `ssh-ed25519 ${sshBlob.toString("base64")}` };
}

describe.skipIf(!live)("x402layer live (free calls only)", () => {
  it("lists plans and gives a firm quote for vc2-1c-1gb in ewr", async () => {
    const client = new SellerClient(SELLERS.real);
    const { offers } = await client.catalog();
    console.log(`live: ${offers.length} offers`);
    expect(offers.length).toBeGreaterThan(50);
    const offer = offers.find((o) => o.id === "vc2-1c-1gb");
    expect(offer).toBeDefined();

    const quote = await client.quote({ offer: offer!, regions: ["ewr"], hours: 1, estimateUsd: offer!.hourlyUsd }, "ewr", {
      sshPublicKey: throwawayKeys().sshPublicKey,
      maxTotalUsd: 0.05,
    });
    console.log(`live: quote ${quote.atomic} atomic ($${quote.amountUsd}) on ${quote.accepts.network}, asset ${quote.accepts.asset}`);
    expect(quote.accepts.network).toBe(NETWORKS.real.caip2);
    expect(quote.accepts.asset).toBe(NETWORKS.real.usdc);
    expect(quote.amountUsd).toBeGreaterThanOrEqual(0.005);
    expect(quote.amountUsd).toBeLessThanOrEqual(0.05);
  }, 90_000);

  it("accepts a signed instance list from a fresh wallet", async () => {
    const client = new SellerClient(SELLERS.real, { signer: await signerFromSecret(throwawayKeys().secret) });
    const list = await client.instances();
    console.log(`live: signed instance list returned ${list.length} instances`);
    expect(Array.isArray(list)).toBe(true);
  }, 30_000);
});
