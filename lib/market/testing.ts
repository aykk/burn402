// Test helpers shared by the market tests. App code must not import this file.
import { generateKeyPairSync, sign } from "node:crypto";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { SOLANA_DEVNET, type PaymentProcessor, type Settlement } from "../x402/processor";
import type { Network } from "@x402/core/types";
import { base58Encode, type Signer } from "./auth";
import type { Payer, PaymentRequired } from "./pay";
import type { TestSeller } from "./testseller";

export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const FAKE_PAY_TO = "Receiver11111111111111111111111111111111111";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/** Requirement amount from USD; decode parses JSON; verify fails only on `bad: true`; counts settles. */
export class FakeProcessor implements PaymentProcessor {
  settled = 0;
  private readonly network: Network;
  private readonly asset: string;

  /** Defaults to devnet USDC; pass mainnet values to stand in for the real market. */
  constructor(o: { network?: string; asset?: string } = {}) {
    this.network = (o.network ?? SOLANA_DEVNET) as Network;
    this.asset = o.asset ?? DEVNET_USDC;
  }

  async requirements(usd: number): Promise<PaymentRequirements> {
    return {
      scheme: "exact",
      network: this.network,
      asset: this.asset,
      amount: String(Math.ceil(Math.round(usd * 1e12) / 1e6)),
      payTo: FAKE_PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { feePayer: FAKE_PAY_TO },
    };
  }

  async paymentRequiredHeader(requirements: PaymentRequirements, resourceUrl: string, description: string): Promise<string> {
    return b64({ x402Version: 2, resource: { url: resourceUrl, description, mimeType: "application/json" }, accepts: [requirements] });
  }

  decode(header: string): PaymentPayload {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload;
  }

  async verify(payload: PaymentPayload) {
    return (payload as unknown as { bad?: boolean }).bad === true ? { ok: false as const, reason: "bad payment" } : { ok: true as const };
  }

  async settle(payload: PaymentPayload): Promise<Settlement> {
    this.settled++;
    const payer = (payload as unknown as { payer?: string }).payer ?? null;
    return { ok: true, tx: `tx-${this.settled}`, payer, network: this.network };
  }

  responseHeader(settlement: Settlement): string {
    return b64(settlement);
  }
}

/**
 * A payer whose PAYMENT-SIGNATURE the FakeProcessor decodes. With no address it holds a real
 * ed25519 key, so its signer also passes `verifyAuth` as that address.
 */
export function fakePayer(address?: string): Payer & { calls: number } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const own = address ?? base58Encode(new Uint8Array(pub));
  const signer: Signer = { address: own, sign: async (message) => new Uint8Array(sign(null, message, privateKey)) };
  const payer = {
    address: own,
    signer,
    calls: 0,
    async payHeaders(required: PaymentRequired): Promise<Record<string, string>> {
      payer.calls++;
      return { "PAYMENT-SIGNATURE": b64({ x402Version: 2, accepted: required.accepts[0], payload: { n: payer.calls }, payer: own }) };
    },
  };
  return payer;
}

/** A fetch that routes every request to the seller in this process. */
export function inProcess(seller: Pick<TestSeller, "handle">): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => seller.handle(new Request(input, init))) as typeof fetch;
}
