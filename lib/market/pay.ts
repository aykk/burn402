import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired as X402PaymentRequired } from "@x402/core/types";
import { toClientSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58Decode } from "../x402/client";
import { signerFromSecret, type Signer } from "./auth";

export type PaymentRequired = X402PaymentRequired;
export type Payer = { address: string; signer: Signer; payHeaders(required: PaymentRequired): Promise<Record<string, string>> };

/**
 * Signs a payment for exactly the requirement it is given. The caller decodes the 402
 * and runs the guard first; this never fetches or decides what to pay on its own.
 */
export async function makePayer(secretKeyBase58: string): Promise<Payer> {
  const signer = await signerFromSecret(secretKeyBase58);
  const svmSigner = toClientSvmSigner(await createKeyPairSignerFromBytes(base58Decode(secretKeyBase58)));
  const http = new x402HTTPClient(new x402Client().register("solana:*", new ExactSvmScheme(svmSigner)));
  return {
    address: signer.address,
    signer,
    async payHeaders(required) {
      const payload = await http.createPaymentPayload(required);
      return http.encodePaymentSignatureHeader(payload);
    },
  };
}

/** The v2 PAYMENT-REQUIRED header only. The older v1 JSON body is ignored on purpose. */
export function readPaymentRequired(response: Response, bodyText: string): PaymentRequired | null {
  void bodyText;
  try {
    const pr = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((name) => response.headers.get(name));
    if (!pr || typeof pr !== "object" || !Array.isArray(pr.accepts)) return null;
    return pr;
  } catch {
    return null;
  }
}
