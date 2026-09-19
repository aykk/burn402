import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/server";

export const SOLANA_DEVNET: Network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const DEFAULT_FACILITATOR = "https://x402.org/facilitator";

export type Settlement = { ok: true; tx: string; payer: string | null; network: string } | { ok: false; reason: string };

export interface PaymentProcessor {
  requirements(usd: number): Promise<PaymentRequirements>;
  paymentRequiredHeader(requirements: PaymentRequirements, resourceUrl: string, description: string): Promise<string>;
  decode(header: string): PaymentPayload;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ ok: true } | { ok: false; reason: string }>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Settlement>;
  responseHeader(settlement: Settlement, requirements: PaymentRequirements): string;
}

export function usdPrice(usd: number): string {
  return `$${(Math.ceil(usd * 1e6) / 1e6).toFixed(6)}`;
}

export class X402Processor implements PaymentProcessor {
  private readonly server: x402ResourceServer;
  private readonly network: Network;
  private readonly payTo: string;
  private ready: Promise<void> | null = null;

  constructor(options: { payTo: string; network?: Network; facilitatorUrl?: string }) {
    this.network = options.network ?? SOLANA_DEVNET;
    this.payTo = options.payTo;
    this.server = new x402ResourceServer(new HTTPFacilitatorClient({ url: options.facilitatorUrl ?? DEFAULT_FACILITATOR })).register(
      this.network,
      new ExactSvmScheme(),
    );
  }

  private init(): Promise<void> {
    this.ready ??= this.server.initialize();
    return this.ready;
  }

  async requirements(usd: number): Promise<PaymentRequirements> {
    await this.init();
    const [requirements] = await this.server.buildPaymentRequirements({
      scheme: "exact",
      price: usdPrice(usd),
      network: this.network,
      payTo: this.payTo,
    });
    return requirements;
  }

  async paymentRequiredHeader(requirements: PaymentRequirements, resourceUrl: string, description: string): Promise<string> {
    const required = await this.server.createPaymentRequiredResponse([requirements], { url: resourceUrl, description, mimeType: "application/json" });
    return encodePaymentRequiredHeader(required);
  }

  decode(header: string): PaymentPayload {
    return decodePaymentSignatureHeader(header);
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements) {
    const match = this.server.findMatchingRequirements([requirements], payload);
    if (!match) return { ok: false as const, reason: "payment does not match the quoted requirements" };
    const result = await this.server.verifyPayment(payload, match);
    return result.isValid ? { ok: true as const } : { ok: false as const, reason: result.invalidMessage ?? result.invalidReason ?? "invalid payment" };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Settlement> {
    const result = await this.server.settlePayment(payload, requirements);
    if (!result.success || !result.transaction) return { ok: false, reason: result.errorReason ?? "settlement failed" };
    return { ok: true, tx: result.transaction, payer: result.payer ?? null, network: result.network };
  }

  responseHeader(settlement: Settlement, requirements: PaymentRequirements): string {
    return encodePaymentResponseHeader(
      settlement.ok
        ? { success: true, transaction: settlement.tx, network: requirements.network, payer: settlement.payer ?? undefined }
        : { success: false, errorReason: settlement.reason, transaction: "", network: requirements.network },
    );
  }
}
