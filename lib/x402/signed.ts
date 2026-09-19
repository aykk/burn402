import { randomBytes } from "node:crypto";
import type { PaymentReceipt } from "../auditor";
import { fromCompact, MandateError, signJws, toCompact, verifyJws, type KeyResolver, type SignedMandate, type SigningKey } from "../mandate";

export const PROVISION_REQUEST_TYP = "provision-request+jws";
export const RECEIPT_TYP = "receipt+jws";

export type ProvisionRequest = {
  jti: string;
  iss: string;
  mandate: string;
  plan: string;
  region: string;
  iat: number;
};

export type Receipt = {
  jti: string;
  iss: string;
  mandate: string;
  mandate_jti: string;
  usd: number;
  tx: string;
  network: string;
  payer: string | null;
  pay_to: string;
  settled_at: number;
};

export function signProvisionRequest(
  body: Omit<ProvisionRequest, "jti" | "iat"> & Partial<Pick<ProvisionRequest, "jti" | "iat">>,
  key: SigningKey,
): Promise<SignedMandate> {
  const request: ProvisionRequest = {
    jti: body.jti ?? `pr_${randomBytes(12).toString("hex")}`,
    iat: body.iat ?? Math.floor(Date.now() / 1000),
    iss: body.iss,
    mandate: body.mandate,
    plan: body.plan,
    region: body.region,
  };
  return signJws(request, key, PROVISION_REQUEST_TYP);
}

export async function verifyProvisionRequest(input: unknown, resolveKeys: KeyResolver): Promise<ProvisionRequest> {
  const verified = await verifyJws(input, resolveKeys, PROVISION_REQUEST_TYP);
  const r = verified.payload as Partial<ProvisionRequest>;
  const ok =
    typeof r.jti === "string" &&
    typeof r.iss === "string" &&
    typeof r.mandate === "string" &&
    typeof r.plan === "string" &&
    typeof r.region === "string" &&
    Number.isSafeInteger(r.iat);
  if (!ok) throw new MandateError("MALFORMED_PAYLOAD", "provision request is missing fields");
  return r as ProvisionRequest;
}

export async function signReceipt(receipt: Receipt, key: SigningKey): Promise<string> {
  return toCompact(await signJws(receipt, key, RECEIPT_TYP));
}

export function receiptVerifier(resolveKeys: KeyResolver, trustedBrokers: readonly string[]): (r: PaymentReceipt) => Promise<boolean> {
  return async (r) => {
    try {
      const verified = await verifyJws(fromCompact(r.sig), resolveKeys, RECEIPT_TYP);
      if (!trustedBrokers.includes(verified.iss)) return false;
      const signed = verified.payload as Receipt;
      return signed.mandate_jti === r.mandate_jti && signed.tx === r.tx && Math.abs(signed.usd - r.usd) < 1e-9;
    } catch (error) {
      if (error instanceof MandateError) return false;
      throw error;
    }
  };
}
