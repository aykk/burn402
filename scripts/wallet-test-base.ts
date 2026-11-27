/* eslint-disable @typescript-eslint/no-explicit-any -- a live test script reading loosely shaped JSON from the app */
// End-to-end test of "pay from an Ethereum wallet, on Base", on Base's test network (Base Sepolia), with a
// stand-in wallet in place of MetaMask. The stand-in wallet (TEST_BASE_WALLET_SECRET_KEY in .env.local, a
// throwaway test key) needs a little test USDC from https://faucet.circle.com (pick "Base Sepolia"). It
// needs no ETH: signing a payment costs the wallet no network fee.
// Usage, with the app running: npm run wallet:test:base [-- visitor] [-- keep]
//   visitor  act as a public visitor through the public address instead of as the owner
//   keep     leave the machine running after the test instead of destroying it with the wallet's signature
import { readFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const APP = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(process.env.APP_URL ?? "") ? process.env.APP_URL! : "http://127.0.0.1:3000";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const env = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ownerKey = (() => {
  try {
    return readFileSync(".burn402/owner-token", "utf8").trim();
  } catch {
    return "";
  }
})();
const asOwner: Record<string, string> = ownerKey ? { "x-b402-owner": ownerKey } : {};
const VISITOR = process.argv.includes("visitor");
const PUBLIC = VISITOR ? `https://${readFileSync(".burn402/public-host", "utf8").trim()}` : null;
let cookie = "";

async function app(path: string, body?: unknown): Promise<any> {
  if (PUBLIC) {
    const headers: Record<string, string> = { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: PUBLIC }) };
    const r = await fetch(`${PUBLIC}${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    const set = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-b402_sid="));
    if (set) cookie = set;
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }
  const r = await fetch(`${APP}${path}`, body === undefined ? { headers: asOwner } : { method: "POST", headers: { "Content-Type": "application/json", ...asOwner }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

async function main() {
  const secret = env.TEST_BASE_WALLET_SECRET_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(secret ?? "")) throw new Error("TEST_BASE_WALLET_SECRET_KEY is not set in .env.local");
  const wallet = privateKeyToAccount(secret as Hex);
  const chain = createPublicClient({ transport: http("https://sepolia.base.org") });
  const balance = async () => chain.readContract({ address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [wallet.address] });
  say("stand-in Ethereum wallet", wallet.address);
  const before = await balance();
  say("test USDC on Base Sepolia:", Number(before) / 1e6);
  if (before < BigInt(20000)) say("NOTE: under 0.02 test USDC. The seller's side will refuse the payment; get test USDC at https://faucet.circle.com (Base Sepolia) for", wallet.address);

  if (PUBLIC) {
    say("acting as a public visitor through", PUBLIC);
    await app("/api/demo/state");
  }
  await app("/api/demo/reset", {});
  const started = await app("/api/market/run", { market: "test", need: { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false }, budgetUsd: 1, rateUsdHr: 0.05, askBeforePaying: false, wallet: wallet.address });
  if (!started.run) throw new Error(`the run did not start: ${started.error}`);
  let run = started.run;
  say("run", run.id, "paid from", run.wallet, "on", run.chain, "| the wallet owns the machine:", run.selfManaged);
  const state = async () => (await app("/api/demo/state")).market;
  for (let i = 0; i < 40 && run.phase !== "approval"; i++) {
    await sleep(1500);
    run = await state();
    if (["failed", "refused"].includes(run.phase)) throw new Error(`the run ended before approval: ${run.error ?? run.refusal?.detail}`);
  }
  if (run.phase !== "approval") throw new Error(`the run never reached approval (phase ${run.phase})`);
  say("approval stop:", run.approval.exact, "USDC on", run.approval.network, "to", run.approval.payTo, "plan", run.approval.plan);

  // 1. the message the wallet signs, as the page gets it
  const prepared = await app("/api/market/wallet", { run: run.id, code: run.approval.code });
  if (!prepared.typedData) throw new Error(`the payment was not prepared: ${prepared.error}`);
  const { domain, message, primaryType } = prepared.typedData;
  say("to sign:", primaryType, "| from", message.from, "to", message.to, "value", message.value, "| network", prepared.network.name, prepared.network.chainId);

  // a signature by another wallet must be refused
  const stranger = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const typed = { domain, types: { TransferWithAuthorization: prepared.typedData.types.TransferWithAuthorization }, primaryType, message: { ...message, value: BigInt(message.value), validAfter: BigInt(message.validAfter), validBefore: BigInt(message.validBefore) } } as any;
  const wrong = await app("/api/market/approve", { run: run.id, code: run.approval.code, signature: await stranger.signTypedData(typed) });
  say("a stranger's signature:", wrong.status, wrong.error ?? "ACCEPTED (wrong!)");
  if (wrong.status === 200) throw new Error("a stranger's signature was accepted");

  // 2. what MetaMask does: sign exactly that
  const approved = await app("/api/market/approve", { run: run.id, code: run.approval.code, signature: await wallet.signTypedData(typed) });
  if (approved.status !== 200) throw new Error(`the signed payment was not accepted: ${approved.error}`);
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    run = await state();
    if (run.machine || ["failed", "refused"].includes(run.phase)) break;
  }
  say("after paying: phase", run.phase, "| payment", run.payment ? `${run.payment.status} ${run.payment.tx ?? "(no tx yet)"}` : "none", "|", run.error ?? run.refusal?.detail ?? "");
  if (!run.machine) {
    say("RESULT: FAIL (no machine)");
    return;
  }
  say("machine", run.machine.id, run.machine.status, "address:", run.machine.ip ?? "not known until the wallet looks");

  // 3. the app cannot look by itself: the wallet signs a look
  const signed = async (kind: "look" | "destroy", by = wallet) => {
    const ask = await app("/api/market/wallet", { run: run.id, signIn: kind });
    if (!ask.message) throw new Error(`no sign-in message: ${ask.error}`);
    return app("/api/market/wallet", { run: run.id, signIn: kind, signature: await by.signMessage({ message: ask.message }) });
  };
  const notOwner = await signed("look", stranger);
  say("a stranger's look:", notOwner.status, notOwner.error ?? "ACCEPTED (wrong!)");
  await sleep(4000);
  const looked = await signed("look");
  if (looked.status !== 200) throw new Error(`the signed look failed: ${looked.error}`);
  for (let i = 0; i < 20 && run.phase !== "ready"; i++) {
    await sleep(1500);
    run = await state();
  }
  say("after the wallet's look: phase", run.phase, "| address", run.machine?.ip, "| prepaid until", new Date(run.machine.destroyAt).toISOString().slice(11, 19), "UTC");

  // 4. Destroy without the wallet must do nothing
  const plain = await app("/api/market/destroy", { run: run.id });
  say("destroy without the wallet:", plain.status, plain.error ?? "ACCEPTED (wrong!)");
  let end = run;
  if (!process.argv.includes("keep")) {
    const gone = await signed("destroy");
    if (gone.status !== 200) throw new Error(`the signed destroy failed: ${gone.error}`);
    end = await state();
    say("after the wallet's destroy: phase", end.phase, "| machine", end.machine?.status);
  }
  const after = await balance();
  say("test USDC now:", Number(after) / 1e6, "| moved:", Number(before - after) / 1e6);
  const ok = run.phase === "ready" && run.payment?.status === "confirmed" && run.payment.payer.toLowerCase() === wallet.address.toLowerCase() && notOwner.status !== 200 && plain.status !== 200 && (process.argv.includes("keep") || end.phase === "released");
  say(ok ? "RESULT: PASS" : "RESULT: FAIL");
}
main().catch((e) => {
  say("FAILED:", (e as Error).message);
  process.exitCode = 1;
});
