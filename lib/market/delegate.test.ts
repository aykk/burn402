import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { TOKEN_PROGRAM_ADDRESS, getApproveCheckedInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { base58Encode, verifyEd25519 } from "./auth";
import { WalletError, approvalMemo, buildApproval, checkSignedApproval, isWalletAddress, makeDelegatePayer, usdcAccount, waitForAllowance, walletFunds, type ApprovalAsk, type Rpc } from "./delegate";
import { payerSignatureOf } from "./pay";
import { DEVNET_USDC } from "./testing";
import { base58Decode } from "../x402/client";

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const BLOCKHASH = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 7));

/** A keypair as the app holds one (a 64-byte secret) and as a wallet holds one (a key that signs). */
function wallet(): { address: string; secret: string; key: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  return { address: base58Encode(new Uint8Array(pub)), secret: base58Encode(new Uint8Array(Buffer.concat([seed, pub]))), key: privateKey };
}

/** What a browser wallet does with an unsigned transaction: signs the message and fills its own slot. */
function signAs(w: { address: string; key: KeyObject }, unsignedBase64: string): string {
  const bytes = Buffer.from(unsignedBase64, "base64");
  const tx = getTransactionDecoder().decode(new Uint8Array(bytes));
  const slots = Object.keys(tx.signatures);
  const at = slots.indexOf(w.address);
  if (at < 0) throw new Error("the wallet is not a signer of this transaction");
  const signature = sign(null, Buffer.from(tx.messageBytes), w.key);
  // wire format: compact count (one byte here), then 64 bytes per slot, then the message
  signature.copy(bytes, 1 + at * 64);
  return bytes.toString("base64");
}

type Account = { atomic: string; delegate?: string; delegated?: string; owner?: string; mint?: string };

/** A Solana node holding one wallet's USDC account and SOL balance. */
function node(o: { owner: string; account: Account | null; lamports?: number; calls?: string[] }): Rpc {
  return async (method) => {
    o.calls?.push(method);
    if (method === "getAccountInfo") {
      if (!o.account) return { value: null };
      const a = o.account;
      return {
        value: {
          data: {
            parsed: {
              info: {
                mint: a.mint ?? DEVNET_USDC,
                owner: a.owner ?? o.owner,
                tokenAmount: { amount: a.atomic },
                ...(a.delegate ? { delegate: a.delegate, delegatedAmount: { amount: a.delegated ?? "0" } } : {}),
              },
            },
          },
        },
      };
    }
    if (method === "getBalance") return { value: o.lamports ?? 5_000_000 };
    if (method === "getLatestBlockhash") return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } };
    throw new Error(`unexpected ${method}`);
  };
}

const visitor = wallet();
const agent = wallet();
const ask: ApprovalAsk = { market: "test", owner: visitor.address, delegate: agent.address, atomic: BigInt(10382), memo: approvalMemo("mkt_1", "code-1") };
const funded = () => node({ owner: visitor.address, account: { atomic: "5000000" } });

/** A transaction of the visitor's own making, for the cases a real wallet or a tampered page could send. */
async function custom(instructions: Instruction[]): Promise<string> {
  const owner = address(visitor.address);
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: BigInt(1000) }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return signAs(visitor, getBase64EncodedWireTransaction(compileTransaction(message)));
}

async function approveIx(over: { amount?: bigint; delegate?: string; source?: string } = {}): Promise<Instruction> {
  return getApproveCheckedInstruction({
    source: address(over.source ?? (await usdcAccount("test", visitor.address))),
    mint: address(DEVNET_USDC),
    delegate: address(over.delegate ?? agent.address),
    owner: createNoopSigner(address(visitor.address)),
    amount: over.amount ?? ask.atomic,
    decimals: 6,
  });
}
const memoIx = (text: string): Instruction => ({ programAddress: address(MEMO_PROGRAM), accounts: [], data: new TextEncoder().encode(text) });

describe("isWalletAddress", () => {
  it("takes a 32-byte base58 address and nothing else", () => {
    expect(isWalletAddress(visitor.address)).toBe(true);
    expect(isWalletAddress(DEVNET_USDC)).toBe(true);
    expect(isWalletAddress("")).toBe(false);
    expect(isWalletAddress("0x52908400098527886E0F7030069857D2E4169EE7")).toBe(false);
    expect(isWalletAddress(`${visitor.address}x`.repeat(2))).toBe(false);
    expect(isWalletAddress("1".repeat(40))).toBe(false); // 40 zero bytes, not 32
    expect(isWalletAddress(42)).toBe(false);
    expect(isWalletAddress(null)).toBe(false);
  });
});

describe("approvalMemo", () => {
  it("is different for every run and code, and never shows the code", () => {
    const m = approvalMemo("mkt_1", "secret-code");
    expect(m).toMatch(/^burn402 [0-9a-f]{32}$/);
    expect(m).not.toContain("secret-code");
    expect(approvalMemo("mkt_1", "other")).not.toBe(m);
    expect(approvalMemo("mkt_2", "secret-code")).not.toBe(m);
  });
});

describe("walletFunds", () => {
  it("reads the balance and the approval on the wallet's own USDC account", async () => {
    const f = await walletFunds(node({ owner: visitor.address, account: { atomic: "250000", delegate: agent.address, delegated: "10382" } }), "test", visitor.address);
    expect(f).toEqual({ account: await usdcAccount("test", visitor.address), exists: true, atomic: BigInt(250000), delegate: agent.address, delegated: BigInt(10382) });
  });

  it("says the account does not exist when there is none, or when it is not this wallet's USDC", async () => {
    expect((await walletFunds(node({ owner: visitor.address, account: null }), "test", visitor.address)).exists).toBe(false);
    expect((await walletFunds(node({ owner: visitor.address, account: { atomic: "9", owner: agent.address } }), "test", visitor.address)).exists).toBe(false);
    expect((await walletFunds(node({ owner: visitor.address, account: { atomic: "9", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } }), "test", visitor.address)).exists).toBe(false);
  });
});

describe("buildApproval", () => {
  it("asks the wallet to approve exactly the quoted amount to the agent, with the run's note, and nothing else", async () => {
    const unsigned = await buildApproval(funded(), ask);
    const tx = getTransactionDecoder().decode(new Uint8Array(Buffer.from(unsigned, "base64")));
    // one signer, the visitor, whose slot is still empty
    expect(Object.keys(tx.signatures)).toEqual([visitor.address]);
    expect(tx.signatures[address(visitor.address)]).toBeNull();
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (message.version !== "legacy") throw new Error("expected a legacy transaction");
    const keys = message.staticAccounts.map(String);
    expect(keys[0]).toBe(visitor.address);
    expect(message.instructions).toHaveLength(2);
    const [approve, memo] = message.instructions;
    expect(keys[approve.programAddressIndex]).toBe(TOKEN_PROGRAM_ADDRESS);
    expect((approve.accountIndices ?? []).map((i) => keys[i])).toEqual([await usdcAccount("test", visitor.address), DEVNET_USDC, agent.address, visitor.address]);
    const data = new Uint8Array(approve.data!);
    expect(data[0]).toBe(13);
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(1, true)).toBe(BigInt(10382));
    expect(keys[memo.programAddressIndex]).toBe(MEMO_PROGRAM);
    expect(new TextDecoder().decode(new Uint8Array(memo.data!))).toBe(ask.memo);
  });

  it("refuses in plain words when the wallet could not complete it", async () => {
    await expect(buildApproval(node({ owner: visitor.address, account: null }), ask)).rejects.toThrow("Your wallet holds no USDC on Solana devnet.");
    await expect(buildApproval(node({ owner: visitor.address, account: { atomic: "5000" } }), ask)).rejects.toThrow("Your wallet holds $0.005 USDC on Solana devnet; this rental needs $0.010382.");
    await expect(buildApproval(node({ owner: visitor.address, account: { atomic: "5000000" }, lamports: 0 }), ask)).rejects.toThrow(/needs a little SOL on Solana devnet/);
    await expect(buildApproval(node({ owner: visitor.address, account: null }), ask)).rejects.toBeInstanceOf(WalletError);
  });
});

describe("checkSignedApproval", () => {
  const expected = async () => ({ ...ask, account: await usdcAccount("test", visitor.address) });

  it("accepts the approval once the visitor's wallet has signed it", async () => {
    const signed = signAs(visitor, await buildApproval(funded(), ask));
    const r = checkSignedApproval(signed, await expected());
    expect(r).toEqual({ ok: true, wire: signed });
  });

  it("accepts what a wallet adds of its own: a priority fee and Phantom's safety checks", async () => {
    const guard = { programAddress: address("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"), accounts: [], data: new Uint8Array([1, 2, 3]) };
    const fee = (n: number) => ({ programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data: new Uint8Array([n, 1, 0, 0, 0]) });
    // the shape Phantom really sent on mainnet: two compute-budget instructions, the approval, the memo
    expect(checkSignedApproval(await custom([fee(2), fee(3), await approveIx(), memoIx(ask.memo)]), await expected()).ok).toBe(true);
    expect(checkSignedApproval(await custom([await approveIx(), memoIx(ask.memo), guard]), await expected()).ok).toBe(true);
  });

  it("refuses any other program beside the approval: it could move the wallet's funds another way", async () => {
    const SYSTEM = "11111111111111111111111111111111";
    const stranger = wallet().address;
    // a SOL transfer to a third party (System program, instruction 2)
    const solTransfer: Instruction = {
      programAddress: address(SYSTEM),
      accounts: [
        { address: address(visitor.address), role: 3 },
        { address: address(stranger), role: 1 },
      ],
      data: new Uint8Array([2, 0, 0, 0, 0, 0xf2, 0x05, 0x2a, 1, 0, 0, 0]),
    };
    // an arbitrary program handed the wallet's USDC account and the wallet as signer
    const unknown: Instruction = {
      programAddress: address(stranger),
      accounts: [
        { address: address(await usdcAccount("test", visitor.address)), role: 1 },
        { address: address(visitor.address), role: 3 },
      ],
      data: new Uint8Array([9]),
    };
    // the newer token program
    const token2022: Instruction = { programAddress: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), accounts: [], data: new Uint8Array([5]) };
    for (const extra of [solTransfer, unknown, token2022]) {
      const r = checkSignedApproval(await custom([await approveIx(), memoIx(ask.memo), extra]), await expected());
      expect(r).toEqual({ ok: false, error: "the transaction does something besides the approval" });
    }
  });

  it("refuses a second required signer", async () => {
    // a memo that names another account as a signer makes the transaction need two signatures
    const cosigned: Instruction = { programAddress: address(MEMO_PROGRAM), accounts: [{ address: address(agent.address), role: 2 }], data: new TextEncoder().encode("x") };
    const r = checkSignedApproval(await custom([await approveIx(), memoIx(ask.memo), cosigned]), await expected());
    expect(r).toEqual({ ok: false, error: "the approval must be signed by your wallet alone" });
  });

  it("refuses more instructions than an approval needs", async () => {
    const pad = Array.from({ length: 8 }, (_, i) => memoIx(`pad ${i}`));
    const r = checkSignedApproval(await custom([await approveIx(), memoIx(ask.memo), ...pad]), await expected());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("more instructions than an approval needs");
  });

  it("refuses an unsigned transaction, one signed by someone else, and a changed one", async () => {
    const unsigned = await buildApproval(funded(), ask);
    expect(checkSignedApproval(unsigned, await expected())).toEqual({ ok: false, error: "the transaction is not signed by your wallet" });
    // a valid signature, but by another key in the visitor's slot
    const forged = signAs({ address: visitor.address, key: agent.key }, unsigned);
    expect(checkSignedApproval(forged, await expected())).toEqual({ ok: false, error: "your wallet's signature on the transaction is not valid" });
    // signed, then one byte of the message changed
    const bytes = Buffer.from(signAs(visitor, unsigned), "base64");
    bytes[bytes.length - 1] ^= 1;
    expect(checkSignedApproval(bytes.toString("base64"), await expected()).ok).toBe(false);
  });

  it.each([
    ["a larger amount", async () => custom([await approveIx({ amount: BigInt(5_000_000) }), memoIx(ask.memo)]), "not for the quoted amount"],
    ["another delegate", async () => custom([await approveIx({ delegate: wallet().address }), memoIx(ask.memo)]), "this run's agent"],
    ["another source account", async () => custom([await approveIx({ source: await usdcAccount("test", agent.address) }), memoIx(ask.memo)]), "your USDC account"],
    ["another run's note", async () => custom([await approveIx(), memoIx(approvalMemo("mkt_other", "code-1"))]), "not made for this run"],
    ["no note", async () => custom([await approveIx()]), "not made for this run"],
    ["no approval at all", async () => custom([memoIx(ask.memo)]), "exactly one token instruction"],
    ["a second approval beside it", async () => custom([await approveIx(), await approveIx({ delegate: wallet().address, amount: BigInt(9_000_000) }), memoIx(ask.memo)]), "exactly one token instruction"],
    [
      "a transfer instead of an approval",
      async () =>
        custom([
          getTransferCheckedInstruction({
            source: address(await usdcAccount("test", visitor.address)),
            mint: address(DEVNET_USDC),
            destination: address(await usdcAccount("test", agent.address)),
            authority: createNoopSigner(address(visitor.address)),
            amount: ask.atomic,
            decimals: 6,
          }),
          memoIx(ask.memo),
        ]),
      "not an approval",
    ],
  ])("refuses %s", async (_name, make, words) => {
    const r = checkSignedApproval(await make(), await expected());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(words);
  });

  it("refuses garbage without throwing", async () => {
    const e = await expected();
    expect(checkSignedApproval("not base64 !!", e).ok).toBe(false);
    expect(checkSignedApproval("", e).ok).toBe(false);
    expect(checkSignedApproval(Buffer.alloc(2000, 1).toString("base64"), e).ok).toBe(false);
    expect(checkSignedApproval(Buffer.from([1, 2, 3]).toString("base64"), e).ok).toBe(false);
    expect(checkSignedApproval(42 as never, e).ok).toBe(false);
  });
});

describe("waitForAllowance", () => {
  const want = { market: "test" as const, owner: visitor.address, delegate: agent.address, atomic: BigInt(10382) };

  it("returns once the chain shows the agent approved for at least the amount", async () => {
    let reads = 0;
    const rpc: Rpc = async (method) => {
      if (method !== "getAccountInfo") throw new Error("unexpected");
      reads++;
      // the approval lands on the third look
      return node({ owner: visitor.address, account: reads < 3 ? { atomic: "5000000" } : { atomic: "5000000", delegate: agent.address, delegated: "10382" } })("getAccountInfo", []);
    };
    const slept: number[] = [];
    await waitForAllowance(rpc, want, { sleep: async (ms) => void slept.push(ms), everyMs: 10 });
    expect(reads).toBe(3);
    expect(slept).toEqual([10, 10]);
  });

  it("gives up in plain words when it never shows, is for less, or names someone else", async () => {
    let t = 0;
    const opts = { sleep: async () => void (t += 1000), now: () => t, timeoutMs: 5000, everyMs: 1000 };
    const never = "your wallet's approval did not show up on chain in time, so nothing was paid";
    await expect(waitForAllowance(funded(), want, opts)).rejects.toThrow(never);
    t = 0;
    await expect(waitForAllowance(node({ owner: visitor.address, account: { atomic: "5000000", delegate: agent.address, delegated: "10381" } }), want, opts)).rejects.toThrow(never);
    t = 0;
    await expect(waitForAllowance(node({ owner: visitor.address, account: { atomic: "5000000", delegate: wallet().address, delegated: "99999999" } }), want, opts)).rejects.toThrow(never);
  });

  it("keeps asking while the node does not answer, and stops at once when the money is gone", async () => {
    let t = 0;
    let calls = 0;
    const flaky: Rpc = async () => {
      calls++;
      if (calls < 3) throw new Error("node down");
      return node({ owner: visitor.address, account: { atomic: "5000000", delegate: agent.address, delegated: "10382" } })("getAccountInfo", []);
    };
    await waitForAllowance(flaky, want, { sleep: async () => void (t += 1000), now: () => t, timeoutMs: 60_000 });
    expect(calls).toBe(3);
    const spent = node({ owner: visitor.address, account: { atomic: "100", delegate: agent.address, delegated: "10382" } });
    await expect(waitForAllowance(spent, want, { sleep: async () => {}, now: () => 0 })).rejects.toThrow("your wallet no longer holds the $0.010382 USDC it approved");
  });
});

describe("makeDelegatePayer", () => {
  const FEE_PAYER = wallet().address;
  const PAY_TO = wallet().address;
  const required = {
    x402Version: 2,
    resource: { url: "http://127.0.0.1:3000/api/testseller/compute/provision", description: "d", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: DEVNET_USDC, amount: "10382", payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } }],
  };
  const approved = (calls?: string[]) => node({ owner: visitor.address, account: { atomic: "5000000", delegate: agent.address, delegated: "10382" }, calls });

  it("signs and manages as the agent, and says whose money it spends", async () => {
    const p = await makeDelegatePayer(agent.secret, { market: "test", owner: visitor.address, rpc: approved() });
    expect(p.address).toBe(agent.address);
    expect(p.signer.address).toBe(agent.address);
    expect(p.funds).toBe(visitor.address);
  });

  it("refuses a bad address and the agent's own wallet", async () => {
    await expect(makeDelegatePayer(agent.secret, { market: "test", owner: "nope" })).rejects.toThrow("not a Solana wallet address");
    await expect(makeDelegatePayer(agent.secret, { market: "test", owner: agent.address })).rejects.toThrow("agent's own");
  });

  it("moves exactly the amount from the visitor's account to the seller's, signed by the agent alone", async () => {
    const calls: string[] = [];
    const p = await makeDelegatePayer(agent.secret, { market: "test", owner: visitor.address, rpc: approved(calls) });
    const headers = await p.payHeaders(required as never);
    // the approval is read on chain before anything is signed
    expect(calls[0]).toBe("getAccountInfo");

    const payload = decodePaymentSignatureHeader(headers["PAYMENT-SIGNATURE"] ?? headers["payment-signature"]);
    const tx = getTransactionDecoder().decode(new Uint8Array(Buffer.from((payload.payload as { transaction: string }).transaction, "base64")));
    // two signers: the seller's fee payer (still empty) and the agent (signed). The visitor's wallet signs nothing here.
    expect(Object.keys(tx.signatures)).toEqual([FEE_PAYER, agent.address]);
    expect(tx.signatures[address(FEE_PAYER)]).toBeNull();
    const signature = tx.signatures[address(agent.address)]!;
    expect(verifyEd25519(base58Decode(agent.address), new Uint8Array(tx.messageBytes), new Uint8Array(signature))).toBe(true);
    expect(payerSignatureOf(headers)).toBe(base58Encode(new Uint8Array(signature)));

    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (message.version !== 0) throw new Error("expected a version 0 transaction");
    const keys = message.staticAccounts.map(String);
    // compute limit, compute price, the transfer, a memo: the layout the x402 exact scheme checks
    expect(message.instructions).toHaveLength(4);
    const transfer = message.instructions[2];
    expect(keys[transfer.programAddressIndex]).toBe(TOKEN_PROGRAM_ADDRESS);
    const data = new Uint8Array(transfer.data!);
    expect(data[0]).toBe(12); // TransferChecked
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(1, true)).toBe(BigInt(10382));
    expect((transfer.accountIndices ?? []).map((i) => keys[i])).toEqual([await usdcAccount("test", visitor.address), DEVNET_USDC, await usdcAccount("test", PAY_TO), agent.address]);
    expect(keys[message.instructions[3].programAddressIndex]).toBe(MEMO_PROGRAM);
    expect(keys).not.toContain(visitor.address);
  });

  it("signs nothing while the approval is missing", async () => {
    const calls: string[] = [];
    let t = 0;
    const p = await makeDelegatePayer(agent.secret, {
      market: "test",
      owner: visitor.address,
      rpc: node({ owner: visitor.address, account: { atomic: "5000000" }, calls }),
      wait: { sleep: async () => void (t += 1000), now: () => t, timeoutMs: 3000 },
    });
    await expect(p.payHeaders(required as never)).rejects.toThrow("did not show up on chain in time");
    expect(calls).not.toContain("getLatestBlockhash");
  });

  it("refuses to pay in a token that is not this market's USDC", async () => {
    const p = await makeDelegatePayer(agent.secret, { market: "test", owner: visitor.address, rpc: approved() });
    const other = { ...required, accepts: [{ ...required.accepts[0], asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }] };
    await expect(p.payHeaders(other as never)).rejects.toThrow();
  });
});
