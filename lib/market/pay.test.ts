import { describe, expect, it } from "vitest";
import { base58Encode } from "./auth";
import { payerSignatureOf } from "./pay";
import { DEVNET_USDC, fakePayer } from "./testing";

const KNOWN = Uint8Array.from({ length: 64 }, (_, i) => i + 1);

/** Solana wire format: compact-u16 signature count, count x 64 bytes, then the message. */
function wireTx(slots: Uint8Array[], message = Uint8Array.from([0x80, 1, 0, 1, 2, 3])): string {
  return Buffer.concat([Buffer.from([slots.length]), ...slots.map((s) => Buffer.from(s)), Buffer.from(message)]).toString("base64");
}

const header = (payload: unknown) =>
  Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: DEVNET_USDC, amount: "10382", payTo: "x", maxTimeoutSeconds: 60, extra: {} },
      payload,
    }),
  ).toString("base64");

describe("payerSignatureOf", () => {
  it("reads the payer's signature: the first slot that is not all zeros", () => {
    const tx = wireTx([new Uint8Array(64), KNOWN]);
    expect(payerSignatureOf({ "PAYMENT-SIGNATURE": header({ transaction: tx }) })).toBe(base58Encode(KNOWN));
    // header names are case-insensitive
    expect(payerSignatureOf({ "payment-signature": header({ transaction: tx }) })).toBe(base58Encode(KNOWN));
  });

  it("is null when every slot is empty, the transaction is cut short, or the count is zero", () => {
    expect(payerSignatureOf({ "PAYMENT-SIGNATURE": header({ transaction: wireTx([new Uint8Array(64), new Uint8Array(64)]) }) })).toBeNull();
    const cut = Buffer.from(wireTx([new Uint8Array(64), KNOWN]), "base64").subarray(0, 100).toString("base64");
    expect(payerSignatureOf({ "PAYMENT-SIGNATURE": header({ transaction: cut }) })).toBeNull();
    expect(payerSignatureOf({ "PAYMENT-SIGNATURE": header({ transaction: wireTx([]) }) })).toBeNull();
  });

  it("is null for garbage, a missing header, or a payload without a transaction (the fake payer's)", async () => {
    expect(payerSignatureOf({})).toBeNull();
    expect(payerSignatureOf({ "PAYMENT-SIGNATURE": "not base64 !!" })).toBeNull();
    expect(payerSignatureOf({ "PAYMENT-SIGNATURE": Buffer.from("{nope").toString("base64") })).toBeNull();
    expect(payerSignatureOf({ "PAYMENT-SIGNATURE": header({ transaction: 42 }) })).toBeNull();
    expect(payerSignatureOf({ "PAYMENT-SIGNATURE": header({ transaction: "%%%" }) })).toBeNull();
    expect(payerSignatureOf({ "PAYMENT-SIGNATURE": header(null) })).toBeNull();
    const p = fakePayer();
    const required = { x402Version: 2, resource: { url: "u", description: "d", mimeType: "application/json" }, accepts: [{ scheme: "exact", network: "solana:x", asset: DEVNET_USDC, amount: "1", payTo: "x", maxTimeoutSeconds: 60, extra: {} }] };
    expect(payerSignatureOf(await p.payHeaders(required as never))).toBeNull();
  });
});
