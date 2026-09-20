import { fqdnOf } from "../auditor";
import { signJws, toCompact, type SigningKey } from "../mandate";
import type { TransactionRecord } from "../x402";
import { APP_NAME } from "./anchor";
import type { ArweaveGateway, ArweaveTag } from "./arweave";

export const TRANSACTION_SCHEMA = "transaction-v1";
export const TRANSACTION_TYP = "transaction+jws";

export type SignedTransaction = TransactionRecord & { iss: string };

export function transactionTags(t: SignedTransaction): ArweaveTag[] {
  const tags: ArweaveTag[] = [
    { name: "Content-Type", value: "application/json" },
    { name: "App-Name", value: APP_NAME },
    { name: "Schema", value: TRANSACTION_SCHEMA },
    { name: "Broker-FQDN", value: fqdnOf(t.iss) },
    { name: "Outcome", value: t.outcome },
    { name: "Plan", value: t.plan },
    { name: "Issued-At", value: String(Math.floor(t.at)) },
    { name: "Date", value: new Date(t.at * 1000).toISOString() },
  ];
  if (t.subject.startsWith("ans://")) tags.push({ name: "Subject-FQDN", value: fqdnOf(t.subject) });
  if (t.mandateJti) tags.push({ name: "Mandate-Jti", value: t.mandateJti });
  if (t.tx) tags.push({ name: "Solana-Tx", value: t.tx });
  return tags;
}

export async function anchorTransaction(options: {
  gateway: ArweaveGateway;
  broker: string;
  brokerKey: SigningKey;
  record: TransactionRecord;
}): Promise<{ id: string; signed: string }> {
  const body: SignedTransaction = { iss: options.broker, ...options.record };
  const signed = toCompact(await signJws(body, options.brokerKey, TRANSACTION_TYP));
  const data = new TextEncoder().encode(JSON.stringify({ schema: `burn402/${TRANSACTION_SCHEMA}`, transaction: body, jws: signed }));
  const { id } = await options.gateway.upload(data, transactionTags(body));
  return { id, signed };
}
