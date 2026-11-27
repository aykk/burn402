import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired as X402PaymentRequired } from "@x402/core/types";
import { toClientSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58Decode } from "../x402/client";
import { base58Encode, signerFromSecret, type Signer } from "./auth";
import { MAX_PAYMENT_USD } from "./guard";

export type PaymentRequired = X402PaymentRequired;
export type Payer = {
  /** the wallet that signs the payment and the seller's management calls: it owns the machine */
  address: string;
  signer: Signer;
  /** set when the money is not the signer's own: the connected wallet whose USDC it moves under that wallet's approval */
  funds?: string;
  payHeaders(required: PaymentRequired): Promise<Record<string, string>>;
};

/**
 * Signs a payment for exactly the requirement it is given. The caller decodes the 402
 * and runs the guard first; this never fetches or decides what to pay on its own.
 */
export async function makePayer(secretKeyBase58: string): Promise<Payer> {
  const signer = await signerFromSecret(secretKeyBase58);
  const svmSigner = toClientSvmSigner(await createKeyPairSignerFromBytes(base58Decode(secretKeyBase58)));
  // The library's own per-payment cap defaults to $1; raise it to this app's cap. The guard has already
  // checked the amount against the approved quote, the budget, the hourly limit and the same cap.
  const client = new x402Client().register("solana:*", new ExactSvmScheme(svmSigner)).setSpendControls({ maxAmountPerPayment: `$${MAX_PAYMENT_USD}` });
  const http = new x402HTTPClient(client);
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

/** A Solana transaction is at most 1232 bytes, so it cannot carry more signatures than this. */
const MAX_SIGNATURES = 19;
const SIGNATURE_BYTES = 64;

/**
 * The payer's own signature (base58) on the transaction inside a PAYMENT-SIGNATURE header, so the
 * run can find exactly its own transfer on chain. The exact-SVM payload carries a base64 partially
 * signed transaction: the fee payer's slot stays empty until the facilitator signs, so this is the
 * first slot that is not all zeros. Null on anything unexpected; never throws.
 */
export function payerSignatureOf(headers: Record<string, string>): string | null {
  try {
    const name = Object.keys(headers).find((k) => k.toLowerCase() === "payment-signature");
    const value = name === undefined ? undefined : headers[name];
    if (typeof value !== "string" || !value) return null;
    const payload: unknown = decodePaymentSignatureHeader(value).payload;
    if (typeof payload !== "object" || payload === null) return null;
    const b64 = (payload as Record<string, unknown>).transaction;
    if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
    const bytes = Buffer.from(b64, "base64");
    // compact-u16 signature count: 7 bits per byte, high bit means another byte follows
    let count = 0;
    let offset = 0;
    for (let shift = 0; ; shift += 7) {
      if (offset >= bytes.length || shift > 14) return null;
      const b = bytes[offset++];
      count |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
    }
    if (count < 1 || count > MAX_SIGNATURES || bytes.length < offset + count * SIGNATURE_BYTES) return null;
    for (let i = 0; i < count; i++) {
      const sig = bytes.subarray(offset + i * SIGNATURE_BYTES, offset + (i + 1) * SIGNATURE_BYTES);
      if (sig.some((b) => b !== 0)) return base58Encode(new Uint8Array(sig));
    }
    return null;
  } catch {
    return null;
  }
}
