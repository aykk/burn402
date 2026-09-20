import { createHash } from "node:crypto";
import type { AnsProof } from "../ans";
import { fqdnOf } from "../auditor";
import { fromCompact, signJws, toCompact, verifyJws, type KeyResolver, type SigningKey } from "../mandate";
import { APP_NAME } from "./anchor";
import type { ArweaveGateway, ArweaveTag } from "./arweave";

export const CONVERSATION_SCHEMA = "conversation-v1";
export const CONVERSATION_TYP = "conversation+jws";
const A2A_TYP = "a2a+jws";

export type Disclosure = "desk-only" | "full";

export type AnchoredMessage =
  | { disclose: "full"; jws: string }
  | { disclose: "hash"; iss: string; kind: string; at: number; sha256: string };

export type ConversationRecord = {
  iss: string;
  conv: string;
  at: number;
  buyer: string;
  desk: string;
  mandateJti: string | null;
  agreedPlan: string | null;
  disclosure: Disclosure;
  messages: AnchoredMessage[];
};

export type ConversationTurn = {
  seq: number;
  iss: string;
  aud: string;
  kind: string;
  at: number;
  text: string;
  state: "verified" | "withheld" | "broken";
  reason: string | null;
};

export type VerifiedConversation = {
  record: ConversationRecord;
  turns: ConversationTurn[];
  complete: boolean;
  problems: string[];
};

export function commitmentFor(jws: string): string {
  return `sha256:${createHash("sha256").update(jws, "utf8").digest("hex")}`;
}

function textOf(payload: Record<string, unknown>): string {
  for (const field of ["text", "ask", "note"]) {
    const value = payload[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

export function anchoredMessage(options: { jws: string; iss: string; kind: string; at: number; disclose: "full" | "hash" }): AnchoredMessage {
  if (options.disclose === "full") return { disclose: "full", jws: options.jws };
  return { disclose: "hash", iss: options.iss, kind: options.kind, at: Math.floor(options.at), sha256: commitmentFor(options.jws) };
}

export function conversationTags(c: ConversationRecord): ArweaveTag[] {
  const tags: ArweaveTag[] = [
    { name: "Content-Type", value: "application/json" },
    { name: "App-Name", value: APP_NAME },
    { name: "Schema", value: CONVERSATION_SCHEMA },
    { name: "Desk-FQDN", value: fqdnOf(c.desk) },
    { name: "Subject-FQDN", value: fqdnOf(c.buyer) },
    { name: "Conversation", value: c.conv },
    { name: "Disclosure", value: c.disclosure },
    { name: "Message-Count", value: String(c.messages.length) },
    { name: "Issued-At", value: String(Math.floor(c.at)) },
    { name: "Date", value: new Date(c.at * 1000).toISOString() },
  ];
  if (c.mandateJti) tags.push({ name: "Mandate-Jti", value: c.mandateJti });
  if (c.agreedPlan) tags.push({ name: "Plan", value: c.agreedPlan });
  return tags;
}

export async function anchorConversation(options: {
  gateway: ArweaveGateway;
  desk: string;
  deskKey: SigningKey;
  record: Omit<ConversationRecord, "iss">;
  ans?: AnsProof;
}): Promise<{ id: string; signed: string }> {
  const body: ConversationRecord = { iss: options.desk, ...options.record };
  const signed = toCompact(await signJws(body, options.deskKey, CONVERSATION_TYP));
  const data = new TextEncoder().encode(
    JSON.stringify({ schema: `burn402/${CONVERSATION_SCHEMA}`, conversation: body, jws: signed, ans: options.ans }),
  );
  const { id } = await options.gateway.upload(data, conversationTags(body));
  return { id, signed };
}

export function parseConversationRecord(bytes: Uint8Array): { conversation: ConversationRecord; jws: string; ans?: AnsProof } {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { schema?: string; conversation?: ConversationRecord; jws?: string; ans?: AnsProof };
  if (parsed.schema !== `burn402/${CONVERSATION_SCHEMA}`) throw new Error(`not a ${CONVERSATION_SCHEMA} record`);
  if (!parsed.conversation || !parsed.jws) throw new Error("the record is missing the conversation or its signature");
  return { conversation: parsed.conversation, jws: parsed.jws, ans: parsed.ans };
}

export function reveal(record: ConversationRecord, jws: string): { seq: number; matches: boolean } | null {
  const want = commitmentFor(jws);
  const index = record.messages.findIndex((m) => m.disclose === "hash" && m.sha256 === want);
  if (index === -1) return null;
  return { seq: index + 1, matches: true };
}

export async function verifyConversation(record: ConversationRecord, jws: string, resolveKeys: KeyResolver): Promise<VerifiedConversation> {
  const problems: string[] = [];
  const envelope = await verifyJws(fromCompact(jws), resolveKeys, CONVERSATION_TYP);
  const signedBody = envelope.payload as ConversationRecord;
  if (signedBody.conv !== record.conv) problems.push("the signed conversation id does not match the record");
  if (signedBody.messages.length !== record.messages.length) problems.push("the signed message list does not match the record");
  if (signedBody.disclosure !== record.disclosure) problems.push("the signed disclosure setting does not match the record");
  if (envelope.iss !== record.desk) problems.push(`the record was signed by ${envelope.iss}, not by the desk ${record.desk}`);

  const turns: ConversationTurn[] = [];
  for (const [index, message] of record.messages.entries()) {
    const seq = index + 1;
    if (message.disclose === "hash") {
      if (!/^sha256:[0-9a-f]{64}$/.test(message.sha256)) {
        problems.push(`message ${seq}: the commitment is not a sha256 digest`);
        turns.push({ seq, iss: message.iss, aud: "", kind: message.kind, at: message.at, text: "", state: "broken", reason: "malformed commitment" });
        continue;
      }
      if (message.iss !== record.buyer && message.iss !== record.desk) {
        problems.push(`message ${seq}: committed to by ${message.iss}, who is not in this conversation`);
      }
      turns.push({
        seq,
        iss: message.iss,
        aud: message.iss === record.buyer ? record.desk : record.buyer,
        kind: message.kind,
        at: message.at,
        text: "",
        state: "withheld",
        reason: `held back by the operator; ${message.sha256} commits to it`,
      });
      continue;
    }
    try {
      const checked = await verifyJws(fromCompact(message.jws), resolveKeys, A2A_TYP);
      const payload = checked.payload as Record<string, unknown>;
      const iss = String(payload.iss ?? "");
      const aud = String(payload.aud ?? "");
      if (payload.conv !== record.conv) throw new Error(`it belongs to conversation ${String(payload.conv)}`);
      if (iss !== record.buyer && iss !== record.desk) throw new Error(`it was signed by ${iss}, who is not in this conversation`);
      if (aud !== record.buyer && aud !== record.desk) throw new Error(`it is addressed to ${aud}, who is not in this conversation`);
      if (iss === aud) throw new Error("it is addressed to its own sender");
      turns.push({ seq, iss, aud, kind: String(payload.kind ?? ""), at: Number(payload.at ?? 0), text: textOf(payload), state: "verified", reason: null });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push(`message ${seq}: ${reason}`);
      turns.push({ seq, iss: "", aud: "", kind: "", at: 0, text: "", state: "broken", reason });
    }
  }

  const spoke = (who: string) => turns.some((t) => t.iss === who && t.state !== "broken");
  if (!spoke(record.buyer)) problems.push("the buyer never spoke");
  if (!spoke(record.desk)) problems.push("the desk never spoke");
  const deskSaid = turns.filter((t) => t.iss === record.desk && t.state === "verified");
  if (record.agreedPlan && deskSaid.length > 0 && !deskSaid.some((t) => t.text.includes(record.agreedPlan!))) {
    problems.push(`the desk never named ${record.agreedPlan} in this conversation`);
  }

  return { record, turns, complete: problems.length === 0, problems };
}
