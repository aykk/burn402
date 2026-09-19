import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { toClientSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import type { SigningKey } from "../mandate";
import { signProvisionRequest } from "./signed";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(input: string): Uint8Array {
  let n = BigInt(0);
  for (const ch of input) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("invalid base58 character");
    n = n * BigInt(58) + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros++;
  return new Uint8Array([...new Uint8Array(zeros), ...Buffer.from(n === BigInt(0) ? "" : hex, "hex")]);
}

export async function payingFetch(solanaSecretKeyBase58: string, baseFetch: typeof fetch = fetch): Promise<typeof fetch> {
  const signer = toClientSvmSigner(await createKeyPairSignerFromBytes(base58Decode(solanaSecretKeyBase58)));
  const client = new x402Client().register("solana:*", new ExactSvmScheme(signer));
  return wrapFetchWithPayment(baseFetch, client);
}

export type ProvisionCall = {
  url: string;
  chain: string[];
  mandate: string;
  subject: string;
  subjectKey: SigningKey;
  plan: string;
  region: string;
  fetch: typeof fetch;
};

export async function requestProvision(call: ProvisionCall): Promise<{ status: number; body: unknown; payment: unknown }> {
  const request = await signProvisionRequest({ iss: call.subject, mandate: call.mandate, plan: call.plan, region: call.region }, call.subjectKey);
  const response = await call.fetch(call.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain: call.chain, request }),
  });
  const header = response.headers.get("PAYMENT-RESPONSE");
  return { status: response.status, body: await response.json(), payment: header ? decodePaymentResponseHeader(header) : null };
}
