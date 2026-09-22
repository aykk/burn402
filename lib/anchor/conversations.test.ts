import { exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { kidFor, signJws, toCompact, type SigningKey } from "../mandate";
import {
  anchorConversation,
  anchoredMessage,
  commitmentFor,
  parseConversationRecord,
  reveal,
  verifyConversation,
  arweaveAddress,
  type ArweaveGateway,
  type ArweaveItem,
  type ArweaveTag,
  type ConversationRecord,
} from "./index";

const DESK = "ans://v1.0.0.vultr.burn402.xyz";
const BUYER = "ans://v1.0.0.acme.burn402.xyz";
const OUTSIDER = "ans://v1.0.0.rogue.burn402.xyz";
const A2A_TYP = "a2a+jws";
const CONV = "run_1";

async function actor(): Promise<{ signing: SigningKey; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), use: "sig" };
  return { signing: { privateKey, kid: await kidFor(publicJwk) }, publicJwk };
}

const desk = await actor();
const buyer = await actor();
const outsider = await actor();
const keys: Record<string, JWK[]> = { [DESK]: [desk.publicJwk], [BUYER]: [buyer.publicJwk], [OUTSIDER]: [outsider.publicJwk] };
const resolve = async (iss: string) => keys[iss] ?? [];

class MemoryGateway implements ArweaveGateway {
  readonly items: (ArweaveItem & { data: Uint8Array })[] = [];
  readonly ownerKey = desk.publicJwk.x!;

  async upload(data: Uint8Array, tags: ArweaveTag[]) {
    const id = `tx_${this.items.length + 1}`;
    this.items.push({ id, ownerKey: this.ownerKey, ownerAddress: arweaveAddress(this.ownerKey), tags, data, blockAt: null });
    return { id, ownerKey: this.ownerKey };
  }

  async query() {
    return this.items;
  }

  async item(id: string) {
    return this.items.find((i) => i.id === id) ?? null;
  }

  async fetchData(id: string) {
    return this.items.find((i) => i.id === id)!.data;
  }
}

async function a2a(from: { signing: SigningKey }, iss: string, aud: string, kind: string, text: string): Promise<string> {
  return toCompact(await signJws({ conv: CONV, kind, iss, aud, at: 1_700_000_000, text }, from.signing, A2A_TYP));
}

async function exchange(): Promise<{ ask: string; offer: string }> {
  return {
    ask: await a2a(buyer, BUYER, DESK, "quote_request", "we need it cheap"),
    offer: await a2a(desk, DESK, BUYER, "quote", "vhf-2c-2gb is the one, $0.0089 an hour"),
  };
}

async function anchored(record: Omit<ConversationRecord, "iss">): Promise<{ gateway: MemoryGateway; id: string; signed: string }> {
  const gateway = new MemoryGateway();
  const { id, signed } = await anchorConversation({ gateway, desk: DESK, deskKey: desk.signing, record });
  return { gateway, id, signed };
}

describe("conversation records", () => {
  it("verifies both sides when everything is disclosed", async () => {
    const { ask, offer } = await exchange();
    const record: Omit<ConversationRecord, "iss"> = {
      conv: CONV,
      at: 1_700_000_100,
      buyer: BUYER,
      desk: DESK,
      mandateJti: "m_1",
      agreedPlan: "vhf-2c-2gb",
      disclosure: "full",
      messages: [
        { disclose: "full", jws: ask },
        { disclose: "full", jws: offer },
      ],
    };
    const { gateway, id, signed } = await anchored(record);
    const parsed = parseConversationRecord(await gateway.fetchData(id));
    const checked = await verifyConversation(parsed.conversation, signed, resolve);
    expect(checked.problems).toEqual([]);
    expect(checked.complete).toBe(true);
    expect(checked.turns.map((t) => t.state)).toEqual(["verified", "verified"]);
    expect(checked.turns[1].text).toContain("vhf-2c-2gb");
  });

  it("keeps the buyer's words out of the record but still commits to them", async () => {
    const { ask, offer } = await exchange();
    const record: Omit<ConversationRecord, "iss"> = {
      conv: CONV,
      at: 1_700_000_100,
      buyer: BUYER,
      desk: DESK,
      mandateJti: "m_1",
      agreedPlan: "vhf-2c-2gb",
      disclosure: "desk-only",
      messages: [
        anchoredMessage({ jws: ask, iss: BUYER, kind: "quote_request", at: 1_700_000_000, disclose: "hash" }),
        { disclose: "full", jws: offer },
      ],
    };
    const { gateway, id, signed } = await anchored(record);
    const bytes = await gateway.fetchData(id);
    expect(new TextDecoder().decode(bytes)).not.toContain("we need it cheap");

    const parsed = parseConversationRecord(bytes);
    const checked = await verifyConversation(parsed.conversation, signed, resolve);
    expect(checked.problems).toEqual([]);
    expect(checked.turns.map((t) => t.state)).toEqual(["withheld", "verified"]);
    expect(reveal(parsed.conversation, ask)).toEqual({ seq: 1, matches: true });
    expect(reveal(parsed.conversation, offer)).toBeNull();
    expect(commitmentFor(ask)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects a message from someone outside the conversation", async () => {
    const { offer } = await exchange();
    const intruder = await a2a(outsider, OUTSIDER, DESK, "quote_request", "let me in");
    const record: Omit<ConversationRecord, "iss"> = {
      conv: CONV,
      at: 1_700_000_100,
      buyer: BUYER,
      desk: DESK,
      mandateJti: "m_1",
      agreedPlan: "vhf-2c-2gb",
      disclosure: "full",
      messages: [
        { disclose: "full", jws: intruder },
        { disclose: "full", jws: offer },
      ],
    };
    const { gateway, id, signed } = await anchored(record);
    const parsed = parseConversationRecord(await gateway.fetchData(id));
    const checked = await verifyConversation(parsed.conversation, signed, resolve);
    expect(checked.complete).toBe(false);
    expect(checked.problems.join(" ")).toContain("not in this conversation");
    expect(checked.turns[0].state).toBe("broken");
  });

  it("catches a plan the desk never named", async () => {
    const { ask, offer } = await exchange();
    const record: Omit<ConversationRecord, "iss"> = {
      conv: CONV,
      at: 1_700_000_100,
      buyer: BUYER,
      desk: DESK,
      mandateJti: "m_1",
      agreedPlan: "vc2-16c-64gb",
      disclosure: "full",
      messages: [
        { disclose: "full", jws: ask },
        { disclose: "full", jws: offer },
      ],
    };
    const { gateway, id, signed } = await anchored(record);
    const parsed = parseConversationRecord(await gateway.fetchData(id));
    const checked = await verifyConversation(parsed.conversation, signed, resolve);
    expect(checked.complete).toBe(false);
    expect(checked.problems.join(" ")).toContain("never named vc2-16c-64gb");
  });

  it("catches a record whose message list was edited after signing", async () => {
    const { ask, offer } = await exchange();
    const record: Omit<ConversationRecord, "iss"> = {
      conv: CONV,
      at: 1_700_000_100,
      buyer: BUYER,
      desk: DESK,
      mandateJti: "m_1",
      agreedPlan: "vhf-2c-2gb",
      disclosure: "full",
      messages: [
        { disclose: "full", jws: ask },
        { disclose: "full", jws: offer },
      ],
    };
    const { gateway, id, signed } = await anchored(record);
    const parsed = parseConversationRecord(await gateway.fetchData(id));
    parsed.conversation.messages = [parsed.conversation.messages[1]];
    const checked = await verifyConversation(parsed.conversation, signed, resolve);
    expect(checked.complete).toBe(false);
    expect(checked.problems.join(" ")).toContain("signed message list does not match");
  });

  it("tags the record with both fqdns, the disclosure setting and the plan", async () => {
    const { ask, offer } = await exchange();
    const { gateway, id } = await anchored({
      conv: CONV,
      at: 1_700_000_100,
      buyer: BUYER,
      desk: DESK,
      mandateJti: "m_1",
      agreedPlan: "vhf-2c-2gb",
      disclosure: "desk-only",
      messages: [anchoredMessage({ jws: ask, iss: BUYER, kind: "quote_request", at: 1, disclose: "hash" }), { disclose: "full", jws: offer }],
    });
    const tags = Object.fromEntries((await gateway.item(id))!.tags.map((t) => [t.name, t.value]));
    expect(tags).toMatchObject({
      "App-Name": "burn402",
      Schema: "conversation-v1",
      "Subject-FQDN": "acme.burn402.xyz",
      "Desk-FQDN": "vultr.burn402.xyz",
      Disclosure: "desk-only",
      Plan: "vhf-2c-2gb",
      "Message-Count": "2",
      "Mandate-Jti": "m_1",
    });
  });
});
