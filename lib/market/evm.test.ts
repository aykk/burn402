import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentProcessor, Settlement } from "../x402/processor";
import { EvmWalletError, chainOfWallet, findBasePayment, isEvmAddress, makeWalletPayer, preparePayment, secondsLeft, signedByWallet, verifyWalletAuth, walletAuthChallenge, walletAuthHeaders, type PreparedPayment } from "./evm";
import { BASE_NETWORKS, NETWORKS, checkPayment } from "./guard";
import { Journal } from "./journal";
import type { PaymentRequired } from "./pay";
import { dismissOpenPurchase } from "./recover";
import { MarketRun, type MarketRunDeps } from "./run";
import { SELLERS, SellerClient } from "./seller";
import { FakeProcessor, inProcess } from "./testing";
import { TestSeller } from "./testseller";
import type { Limits, Need } from "./types";

const T0 = 1_700_000_000_000;
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"ab".repeat(32)}`;
const TRANSFER = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

type Auth = { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex };
const inner = (p: PaymentPayload) => p.payload as unknown as { authorization: Auth; signature: Hex };

/** A seller's side for Base's test network: real-shaped terms, and a real check of the wallet's signature. */
class BaseProcessor implements PaymentProcessor {
  settled = 0;
  payTo = PAY_TO;
  async requirements(usd: number): Promise<PaymentRequirements> {
    return {
      scheme: "exact",
      network: BASE_NETWORKS.test.caip2 as PaymentRequirements["network"],
      asset: BASE_NETWORKS.test.usdc,
      amount: String(Math.ceil(Math.round(usd * 1e12) / 1e6)),
      payTo: this.payTo,
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    };
  }
  async paymentRequiredHeader(requirements: PaymentRequirements, url: string, description: string): Promise<string> {
    return encodePaymentRequiredHeader({ x402Version: 2, resource: { url, description, mimeType: "application/json" }, accepts: [requirements] });
  }
  decode(header: string): PaymentPayload {
    return decodePaymentSignatureHeader(header);
  }
  async verify(payload: PaymentPayload, req: PaymentRequirements) {
    const { authorization: a, signature } = inner(payload);
    if (JSON.stringify(payload.accepted) !== JSON.stringify(req)) return { ok: false as const, reason: "accepted terms differ" };
    if (a.to.toLowerCase() !== req.payTo.toLowerCase() || a.value !== req.amount) return { ok: false as const, reason: "authorization differs from the terms" };
    const ok = await verifyTypedData({
      address: a.from,
      domain: { name: "USDC", version: "2", chainId: BASE_NETWORKS.test.chainId, verifyingContract: req.asset as Hex },
      types: { TransferWithAuthorization: TRANSFER },
      primaryType: "TransferWithAuthorization",
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      signature,
    });
    return ok ? { ok: true as const } : { ok: false as const, reason: "bad signature" };
  }
  async settle(payload: PaymentPayload): Promise<Settlement> {
    this.settled++;
    return { ok: true, tx: TX, payer: inner(payload).authorization.from, network: BASE_NETWORKS.test.caip2 };
  }
  responseHeader(): string {
    return "";
  }
}

/** What the browser wallet does with the prepared message: sign exactly it. */
async function walletSigns(account: ReturnType<typeof privateKeyToAccount>, p: PreparedPayment): Promise<string> {
  const m = p.typedData.message;
  return account.signTypedData({
    domain: { ...p.typedData.domain, verifyingContract: p.typedData.domain.verifyingContract as Hex },
    types: { TransferWithAuthorization: TRANSFER },
    primaryType: "TransferWithAuthorization",
    message: { from: m.from as Hex, to: m.to as Hex, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore), nonce: m.nonce as Hex },
  });
}

async function termsFor(usd = 0.01): Promise<PaymentRequired> {
  const req = await new BaseProcessor().requirements(usd);
  return { x402Version: 2, resource: { url: "http://127.0.0.1:3000/x", description: "d", mimeType: "application/json" }, accepts: [req] } as PaymentRequired;
}

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("which chain a wallet pays on", () => {
  it("an Ethereum address pays on Base; anything else on Solana", () => {
    expect(isEvmAddress("0x52908400098527886E0F7030069857D2E4169EE7")).toBe(true);
    for (const no of ["0x5290", "52908400098527886E0F7030069857D2E4169EE7", "", null, 7, "FwrVkgVzCBMs1zfTBMW5zd2ZpKXv87SyggSu5nh7trPo"]) expect(isEvmAddress(no)).toBe(false);
    expect(chainOfWallet("0x52908400098527886E0F7030069857D2E4169EE7")).toBe("base");
    expect(chainOfWallet("FwrVkgVzCBMs1zfTBMW5zd2ZpKXv87SyggSu5nh7trPo")).toBe("solana");
    expect(chainOfWallet(null)).toBe("solana");
  });
});

describe("the payment guard on Base", () => {
  const ok = { market: "test" as const, approvedAtomic: BigInt(10000), budgetLeftUsd: 1, rateUsdHr: 1, hours: 1, alreadyPaid: false, payTo: PAY_TO };
  const accepts = { scheme: "exact", network: BASE_NETWORKS.test.caip2, asset: BASE_NETWORKS.test.usdc, amount: "10000", payTo: PAY_TO };
  it("passes USDC on the market's Base network, whatever the letter case of the addresses", () => {
    expect(checkPayment({ ...ok, accepts, chain: "base" })).toEqual({ ok: true, usd: 0.01 });
    expect(checkPayment({ ...ok, accepts: { ...accepts, asset: accepts.asset.toLowerCase(), payTo: PAY_TO.toLowerCase() }, chain: "base" }).ok).toBe(true);
  });
  it("refuses the other market's Base network, another token, a changed recipient and a higher amount", () => {
    const code = (a: Partial<typeof accepts>) => {
      const r = checkPayment({ ...ok, accepts: { ...accepts, ...a }, chain: "base" });
      return r.ok ? "ok" : r.code;
    };
    expect(code({ network: BASE_NETWORKS.real.caip2 })).toBe("WRONG_NETWORK");
    expect(code({ network: NETWORKS.test.caip2 })).toBe("WRONG_NETWORK");
    expect(code({ asset: BASE_NETWORKS.real.usdc })).toBe("WRONG_ASSET");
    expect(code({ payTo: "0x1111111111111111111111111111111111111111" })).toBe("OVER_QUOTE");
    expect(code({ amount: "10001" })).toBe("OVER_QUOTE");
  });
  it("a run that pays on Solana refuses terms on Base, and says which network was asked for", () => {
    const r = checkPayment({ ...ok, accepts });
    expect(r).toMatchObject({ ok: false, code: "WRONG_NETWORK" });
    expect(!r.ok && r.detail).toContain("Base Sepolia");
  });
});

describe("preparePayment", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  it("writes one message: USDC on Base's test network, from the wallet to the seller, the exact amount", async () => {
    const p = await preparePayment(await termsFor(), { wallet: account.address, market: "test" });
    expect(p.typedData.primaryType).toBe("TransferWithAuthorization");
    expect(p.typedData.domain).toEqual({ name: "USDC", version: "2", chainId: 84532, verifyingContract: BASE_NETWORKS.test.usdc });
    expect(p.typedData.message).toMatchObject({ from: account.address, to: PAY_TO, value: "10000", nonce: p.nonce });
    // good for a limited time only
    const left = Number(p.typedData.message.validBefore) - Math.floor(Date.now() / 1000);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(300);
    // what a wallet is given must survive JSON as it is
    expect(JSON.parse(JSON.stringify(p.typedData))).toEqual(p.typedData);
    expect(p.terms).toEqual({ network: "eip155:84532", asset: BASE_NETWORKS.test.usdc, payTo: PAY_TO, amount: "10000", name: "USDC", version: "2" });
  });
  it("refuses terms that are not this market's USDC on Base, before any wallet is asked", async () => {
    const good = await termsFor();
    const bad = (patch: Partial<PaymentRequirements>, market: "test" | "real" = "test") =>
      preparePayment({ ...good, accepts: [{ ...good.accepts[0], ...patch }] } as PaymentRequired, { wallet: account.address, market });
    await expect(bad({}, "real")).rejects.toBeInstanceOf(EvmWalletError);
    await expect(bad({ asset: BASE_NETWORKS.real.usdc })).rejects.toBeInstanceOf(EvmWalletError);
    await expect(bad({ scheme: "upto" })).rejects.toBeInstanceOf(EvmWalletError);
    await expect(bad({ payTo: "not-an-address" })).rejects.toBeInstanceOf(EvmWalletError);
    await expect(bad({ extra: {} })).rejects.toBeInstanceOf(EvmWalletError);
    await expect(bad({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } })).rejects.toBeInstanceOf(EvmWalletError);
    await expect(preparePayment(good, { wallet: "FwrVkgVzCBMs1zfTBMW5zd2ZpKXv87SyggSu5nh7trPo", market: "test" })).rejects.toBeInstanceOf(EvmWalletError);
  });
  it("takes only that wallet's signature of exactly that message", async () => {
    const p = await preparePayment(await termsFor(), { wallet: account.address, market: "test" });
    expect(await signedByWallet(p, await walletSigns(account, p))).toBe(true);
    const other = privateKeyToAccount(generatePrivateKey());
    expect(await signedByWallet(p, await walletSigns(other, p))).toBe(false);
    // the same wallet's signature of another payment (a different one-time number)
    const p2 = await preparePayment(await termsFor(), { wallet: account.address, market: "test" });
    expect(await signedByWallet(p, await walletSigns(account, p2))).toBe(false);
    // a smart-contract account's longer signature is refused outright: it could pay, then never sign in to its machine
    const long = `${await walletSigns(account, p)}${"00".repeat(32)}`;
    for (const junk of ["", "0x", "0x1234", `0x${"zz".repeat(65)}`, long, 7 as unknown as string]) expect(await signedByWallet(p, junk)).toBe(false);
    expect(secondsLeft(p)).toBeGreaterThan(200);
    expect(secondsLeft(p, () => Date.now() + 400_000)).toBeLessThan(0);
  });
});

describe("makeWalletPayer", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  it("pays nothing until the wallet has signed, then exactly that payment, once", async () => {
    const terms = await termsFor();
    const payer = makeWalletPayer(account.address);
    expect(payer.self).toBe(true);
    expect(payer.funds).toBe(account.address);
    await expect(payer.payHeaders(terms)).rejects.toThrow(/has not signed/);
    await expect(payer.signer.sign(new Uint8Array(1))).rejects.toThrow(/browser/);
    const p = await preparePayment(terms, { wallet: account.address, market: "test" });
    const signature = await walletSigns(account, p);
    payer.arm(p, signature);
    const headers = await payer.payHeaders(terms);
    const sent = decodePaymentSignatureHeader(headers["PAYMENT-SIGNATURE"]);
    expect(inner(sent).signature).toBe(signature);
    expect(inner(sent).authorization).toMatchObject({ from: account.address, to: PAY_TO, value: "10000", nonce: p.nonce });
    expect(sent.accepted).toEqual(terms.accepts[0]);
    expect(payer.payReference?.()).toBe(p.nonce);
    await expect(payer.payHeaders(terms)).rejects.toThrow(/already made/);
  });
  it("refuses when the seller's terms changed after the wallet signed", async () => {
    const terms = await termsFor();
    for (const patch of [{ amount: "10001" }, { payTo: "0x1111111111111111111111111111111111111111" }, { network: "eip155:8453" }, { asset: BASE_NETWORKS.real.usdc }, { extra: { name: "USD Coin", version: "2" } }]) {
      const payer = makeWalletPayer(account.address);
      const p = await preparePayment(terms, { wallet: account.address, market: "test" });
      payer.arm(p, await walletSigns(account, p));
      const changed = { ...terms, accepts: [{ ...terms.accepts[0], ...patch }] } as PaymentRequired;
      await expect(payer.payHeaders(changed)).rejects.toThrow(/changed its payment terms/);
    }
  });
  it("is not armed with a payment prepared for another wallet", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const p = await preparePayment(await termsFor(), { wallet: other.address, market: "test" });
    expect(() => makeWalletPayer(account.address).arm(p, "0x00")).toThrow(/another wallet/);
  });
});

describe("signing in to the seller as the wallet", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const now = () => T0;
  it("the wallet's signature of the sign-in message passes the seller's check, as the lower-case address", async () => {
    const c = walletAuthChallenge(account.address, "GET", "/compute/instances/m-1", { now });
    expect(c.message.split("\n").slice(0, 6)).toEqual(["X402-COMPUTE-AUTH", "v1", "base", account.address.toLowerCase(), "GET", "/compute/instances/m-1"]);
    const headers = await walletAuthHeaders(account.address, c, await account.signMessage({ message: c.message }));
    expect(headers).toMatchObject({ "X-Auth-Address": account.address.toLowerCase(), "X-Auth-Chain": "base", "X-Auth-Sig-Encoding": "hex" });
    const check = { method: "GET", path: "/compute/instances/m-1", body: "", nowMs: T0 };
    expect(await verifyWalletAuth(new Headers(headers!), check)).toEqual({ ok: true, address: account.address.toLowerCase() });
    // signed for one machine and one action only
    expect(await verifyWalletAuth(new Headers(headers!), { ...check, path: "/compute/instances/m-2" })).toMatchObject({ ok: false });
    expect(await verifyWalletAuth(new Headers(headers!), { ...check, method: "DELETE" })).toMatchObject({ ok: false });
    expect(await verifyWalletAuth(new Headers(headers!), { ...check, nowMs: T0 + 301_000 })).toMatchObject({ ok: false, reason: "timestamp outside the allowed window" });
  });
  it("another wallet's signature gives no headers", async () => {
    const c = walletAuthChallenge(account.address, "DELETE", "/compute/instances/m-1", { now });
    const other = privateKeyToAccount(generatePrivateKey());
    expect(await walletAuthHeaders(account.address, c, await other.signMessage({ message: c.message }))).toBeNull();
    expect(await walletAuthHeaders(account.address, c, "0x1234")).toBeNull();
  });
});

describe("findBasePayment", () => {
  const payer = "0x52908400098527886E0F7030069857D2E4169EE7";
  const nonce = `0x${"cd".repeat(32)}`;
  it("says the money has not moved while the authorization is unused", async () => {
    expect(await findBasePayment({ market: "test", payer, nonce, reader: { used: async () => false, usedIn: async () => TX } })).toBeNull();
  });
  it("gives the transaction once it is used", async () => {
    expect(await findBasePayment({ market: "test", payer, nonce, reader: { used: async () => true, usedIn: async () => TX } })).toEqual({ tx: TX });
  });
  it("is unavailable when the chain cannot be read, the transaction cannot be found, or there is nothing to look for", async () => {
    const boom = async () => {
      throw new Error("rpc down");
    };
    expect(await findBasePayment({ market: "test", payer, nonce, reader: { used: boom, usedIn: async () => TX } })).toBe("unavailable");
    expect(await findBasePayment({ market: "test", payer, nonce, reader: { used: async () => true, usedIn: async () => null } })).toBe("unavailable");
    expect(await findBasePayment({ market: "test", payer, nonce: null, reader: { used: async () => true, usedIn: async () => TX } })).toBe("unavailable");
  });
});

// ---- a whole rental an Ethereum wallet pays for and owns ---------------------------------------

const NEED: Need = { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false };
const LIMITS: Limits = { budgetUsd: 1, rateUsdHr: 1 };

function world(o: { activeAfterSec?: number } = {}) {
  let t = T0;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
  };
  const account = privateKeyToAccount(generatePrivateKey());
  const base = new BaseProcessor();
  const seller = new TestSeller({ processor: new FakeProcessor(), baseProcessor: base, resourceUrl: `${SELLERS.test.baseUrl}/compute/provision`, now, activeAfterSec: o.activeAfterSec });
  const client = new SellerClient(SELLERS.test, { fetch: inProcess(seller), signer: null, chain: "base", now, sleep });
  const payer = makeWalletPayer(account.address);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evm-run-"));
  dirs.push(dir);
  const journal = new Journal(path.join(dir, "purchases.jsonl"));
  let codes = 0;
  const deps: MarketRunDeps = {
    id: "run-evm",
    market: "test",
    seller: client,
    payer,
    journal,
    need: NEED,
    limits: LIMITS,
    askBeforePaying: false,
    agent: { name: "Buyer", ansName: "buyer.agents.test" },
    keyDir: path.join(dir, "keys"),
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ5q3q3q3q3q3q3q3q3q3q3q3q3q3q3q3q3q3q3q3q3q",
    now,
    sleep,
    newCode: () => `code-${++codes}`,
  };
  const run = new MarketRun(deps);
  /** The wallet signs the payment for the approval the run is waiting on, as the page has it do. */
  const signAndApprove = async () => {
    const code = run.view().approval!.code;
    const quote = run.awaitingQuote(code)!;
    const prepared = await preparePayment(quote.required!, { wallet: account.address, market: "test" });
    payer.arm(prepared, await walletSigns(account, prepared));
    expect(run.approve(code)).toEqual({ ok: true });
    await vi.waitFor(() => expect(["provisioning", "ready", "failed", "refused"]).toContain(run.view().phase));
    return prepared;
  };
  /** One sign-in the wallet signs, for one look at its machine or its destroy. */
  const signIn = async (method: "GET" | "DELETE", by = account) => {
    const c = walletAuthChallenge(account.address, method, SellerClient.instancePath(run.view().machine!.id), { now });
    return (await walletAuthHeaders(by.address, { ...c }, await by.signMessage({ message: c.message })))!;
  };
  return { run, seller, base, account, journal, payer, signAndApprove, signIn, advance: (ms: number) => (t += ms), events: () => journal.all().map((e) => e.event) };
}

describe("a rental an Ethereum wallet pays for itself", () => {
  it("stops for the wallet's signature even when the form said not to ask, and names Base", async () => {
    const { run } = world();
    await run.start();
    const v = run.view();
    expect(v.error ?? v.refusal?.detail ?? null).toBeNull();
    expect(v.phase).toBe("approval");
    expect(v.chain).toBe("base");
    expect(v.selfManaged).toBe(true);
    expect(v.approval).toMatchObject({ network: "Base Sepolia (test network)", payTo: PAY_TO, token: "USDC" });
  });

  it("pays once with the wallet's signature; the machine is the wallet's, and only its signed look shows the address", async () => {
    const { run, base, account, signAndApprove, signIn, advance, events, seller } = world();
    await run.start();
    const prepared = await signAndApprove();
    let v = run.view();
    expect(v.phase).toBe("provisioning");
    expect(base.settled).toBe(1);
    expect(v.payment).toMatchObject({ status: "confirmed", tx: TX, payer: account.address, atomic: prepared.terms.amount });
    expect(v.machine).toMatchObject({ ip: null });
    expect(v.checkedAt).toBeNull();
    // the seller knows the machine as the wallet's
    expect([...seller.machines.values()][0].owner).toBe(account.address.toLowerCase());
    // the prepaid hour is the end of the rental: nothing here will destroy the machine
    expect(v.machine!.destroyAt).toBe(v.machine!.expiresAt);

    // time passes; the run learns nothing by itself
    advance(10_000);
    expect(run.view().machine!.ip).toBeNull();

    // a look the wallet signed
    expect(await run.look(await signIn("GET"))).toEqual({ ok: true });
    await vi.waitFor(() => expect(run.view().phase).toBe("ready"));
    v = run.view();
    expect(v.machine!.ip).toMatch(/^203\.0\.113\./);
    expect(v.checkedAt).not.toBeNull();
    expect(events()).toEqual(["intent", "paid", "active"]);
  });

  it("the seller takes each signed look once, and never another wallet's", async () => {
    const { run, signAndApprove, signIn, advance } = world();
    await run.start();
    await signAndApprove();
    advance(10_000);
    const headers = await signIn("GET");
    expect(await run.look(headers)).toEqual({ ok: true });
    const again = await run.look(headers);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.error).toMatch(/nonce already used/);
    // a stranger signing the same message is not the owner
    const stranger = privateKeyToAccount(generatePrivateKey());
    const c = walletAuthChallenge(stranger.address, "GET", SellerClient.instancePath(run.view().machine!.id), { now: () => T0 + 10_000 });
    const theirs = (await walletAuthHeaders(stranger.address, c, await stranger.signMessage({ message: c.message })))!;
    const before = run.view().phase;
    const refused = await run.look(theirs);
    // the seller answers "not found" to a wallet that does not own the machine: the run never takes that for "gone"
    expect(refused.ok).toBe(false);
    expect(run.view().phase).toBe(before);
    expect(run.view().machine!.status).not.toBe("gone");
  });

  it("Destroy without the wallet does nothing; with its signature the machine is destroyed and the rental ends", async () => {
    const { run, seller, signAndApprove, signIn, advance, events } = world();
    await run.start();
    await signAndApprove();
    advance(10_000);
    await run.look(await signIn("GET"));
    await vi.waitFor(() => expect(run.view().phase).toBe("ready"));

    await run.destroy();
    expect(run.view().phase).toBe("ready");
    expect([...seller.machines.values()][0].destroyed).toBe(false);

    // a look's signature cannot destroy
    const wrong = await run.destroyOwned(await signIn("GET"));
    expect(wrong.ok).toBe(false);
    expect(run.view().phase).toBe("ready");

    expect(await run.destroyOwned(await signIn("DELETE"))).toEqual({ ok: true });
    const v = run.view();
    expect(v.phase).toBe("released");
    expect(v.machine).toMatchObject({ status: "destroyed", ip: null });
    expect([...seller.machines.values()][0].destroyed).toBe(true);
    expect(events()).toEqual(["intent", "paid", "active", "released"]);
  });

  it("ends when the prepaid time is up, without claiming to have destroyed anything", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { run, seller, signAndApprove, advance, journal } = world({ activeAfterSec: 1e9 });
    await run.start();
    await signAndApprove();
    expect(run.view().phase).toBe("provisioning");
    advance(3600_000 + 1000);
    await vi.advanceTimersByTimeAsync(3600_000 + 1000);
    const v = run.view();
    expect(v.phase).toBe("released");
    expect(v.machine!.status).toBe("expired");
    expect([...seller.machines.values()][0].destroyed).toBe(false);
    expect(journal.all().at(-1)).toMatchObject({ event: "released" });
    expect(journal.all().at(-1)!.detail).toMatch(/did not destroy it/);
    expect(journal.open()).toEqual([]);
  });

  it("does not pay when the seller's terms change after the wallet signed", async () => {
    const { run, base, account, payer, events } = world();
    await run.start();
    const code = run.view().approval!.code;
    const prepared = await preparePayment(run.awaitingQuote(code)!.required!, { wallet: account.address, market: "test" });
    payer.arm(prepared, await walletSigns(account, prepared));
    // the seller now wants to be paid somewhere else
    base.payTo = "0x1111111111111111111111111111111111111111";
    run.approve(code);
    await vi.waitFor(() => expect(["failed", "refused"]).toContain(run.view().phase));
    expect(base.settled).toBe(0);
    expect(run.view().spent).toBe("nothing");
    expect(events()).toEqual(["intent", "failed"]);
  });

  it("the journal records the wallet as the machine's owner", async () => {
    const { run, account, journal, signAndApprove } = world();
    await run.start();
    await signAndApprove();
    expect(journal.open()[0].agent).toBe(account.address);
  });

  it("a signed destroy the seller answers with \"not found\" is not taken for destroyed", async () => {
    const { run, seller, signAndApprove, signIn, advance, events } = world();
    await run.start();
    await signAndApprove();
    advance(10_000);
    await run.look(await signIn("GET"));
    await vi.waitFor(() => expect(run.view().phase).toBe("ready"));
    // the seller stops listing the machine for a moment (it answers 404 for one it marks destroyed)
    const machine = [...seller.machines.values()][0];
    machine.destroyed = true;
    const r = await run.destroyOwned(await signIn("DELETE"));
    expect(r.ok).toBe(false);
    expect(run.view().phase).toBe("ready");
    expect(events()).toEqual(["intent", "paid", "active"]);
    // listed again: the destroy goes through
    machine.destroyed = false;
    expect(await run.destroyOwned(await signIn("DELETE"))).toEqual({ ok: true });
    expect(run.view().phase).toBe("released");
  });

  it("after the prepaid time ran out the owner can still destroy the machine to be sure, and a look says the rental is over", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { run, seller, signAndApprove, signIn, advance } = world({ activeAfterSec: 1e9 });
    await run.start();
    await signAndApprove();
    advance(3600_000 + 1000);
    await vi.advanceTimersByTimeAsync(3600_000 + 1000);
    expect(run.view().machine!.status).toBe("expired");
    const look = await run.look(await signIn("GET"));
    expect(look).toEqual({ ok: false, error: "this rental is over" });
    expect(run.view().machine!.status).toBe("expired");
    expect(await run.destroyOwned(await signIn("DELETE"))).toEqual({ ok: true });
    expect(run.view()).toMatchObject({ phase: "released", machine: { status: "destroyed" } });
    expect([...seller.machines.values()][0].destroyed).toBe(true);
  });

  it("an early end time from the seller does not cut the rental short", async () => {
    const { run, seller, signAndApprove } = world({ activeAfterSec: 1e9 });
    await run.start();
    // the seller reports the machine as ending a minute after it was made
    const handle = seller.handle.bind(seller);
    seller.handle = async (request: Request) => {
      const response = await handle(request);
      if (!request.headers.get("PAYMENT-SIGNATURE") || response.status !== 200) return response;
      const body = (await response.json()) as { order: { expires_at: string } };
      body.order.expires_at = new Date(T0 + 60_000).toISOString();
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    await signAndApprove();
    const v = run.view();
    expect(v.machine!.expiresAt).toBe(T0 + 60_000);
    // the rental lasts the hour that was paid for
    expect(v.machine!.destroyAt).toBe(v.paidAt! + 3600_000);
  });
});

describe("an open purchase whose machine an Ethereum wallet owns", () => {
  it("can be dismissed though it has a machine, and the journal says the app did not destroy it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evm-dismiss-"));
    dirs.push(dir);
    const journal = new Journal(path.join(dir, "purchases.jsonl"));
    const base = { run: "r1", market: "real" as const, seller: "x402layer", plan: "p", region: "ewr", usd: 0.01 };
    journal.append({ ...base, at: 1, event: "intent", agent: "0x52908400098527886E0F7030069857D2E4169EE7" });
    journal.append({ ...base, at: 2, event: "paid", instance: "m-1", tx: TX, agent: "0x52908400098527886E0F7030069857D2E4169EE7" });
    const open = journal.open()[0];
    const r = dismissOpenPurchase(open, journal);
    expect(r.ok).toBe(true);
    expect(r.ok && r.message).toMatch(/did not destroy the machine/);
    expect(journal.open()).toEqual([]);
    // the agent's own machine still has to be destroyed, not dismissed
    journal.append({ ...base, run: "r2", at: 3, event: "paid", instance: "m-2", agent: "FwrVkgVzCBMs1zfTBMW5zd2ZpKXv87SyggSu5nh7trPo" });
    expect(dismissOpenPurchase(journal.open()[0], journal).ok).toBe(false);
  });
});
