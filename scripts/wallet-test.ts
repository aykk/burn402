/* eslint-disable @typescript-eslint/no-explicit-any -- a live test script reading loosely shaped JSON from a Solana node and the app */
// End-to-end test of "pay from a connected wallet" on devnet, with a stand-in wallet in place of Phantom.
// The stand-in wallet (.burn402/keys/standin-wallet.json, a throwaway devnet keypair) needs 0.005 devnet SOL from
// https://faucet.solana.com. Usage, with the app running: npm run wallet:test [-- minutes to wait for the SOL]
// Add `revoke` to test taking back an approval left unused: npm run wallet:test -- 0 revoke
import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, getTransferCheckedInstruction } from "@solana-program/token";
import { address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createTransactionMessage, getBase64EncodedWireTransaction, getTransactionDecoder, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, type Blockhash } from "@solana/kit";
import { base58Decode } from "../lib/x402/client";

/** The running app; APP_URL points the test at another local copy (a dev server on another port). */
const APP = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(process.env.APP_URL ?? "") ? process.env.APP_URL! : "http://127.0.0.1:3000";
const RPC = "https://api.devnet.solana.com";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const env = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const visitor = JSON.parse(readFileSync(".burn402/keys/standin-wallet.json", "utf8")) as { address: string; secret: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function rpc(method: string, params: unknown[]): Promise<any> {
  const r = await (await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}
const sol = async (a: string) => (await rpc("getBalance", [a, { commitment: "confirmed" }])).value as number;
async function usdc(owner: string): Promise<{ atomic: bigint; delegate: string | null; delegated: bigint } | null> {
  const [ata] = await findAssociatedTokenPda({ mint: address(MINT), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const v = (await rpc("getAccountInfo", [ata, { encoding: "jsonParsed", commitment: "confirmed" }])).value;
  const info = v?.data?.parsed?.info;
  return info ? { atomic: BigInt(info.tokenAmount.amount), delegate: info.delegate ?? null, delegated: BigInt(info.delegatedAmount?.amount ?? "0") } : null;
}
async function confirmed(signature: string) {
  for (let i = 0; i < 40; i++) {
    const s = (await rpc("getSignatureStatuses", [[signature]])).value[0];
    if (s?.err) throw new Error(`transaction failed: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
    await sleep(1500);
  }
  throw new Error("transaction was not confirmed in a minute");
}
async function app(path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${APP}${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
/** What a browser wallet does: sign the transaction's message with its key and fill its own slot. */
function walletSign(unsignedBase64: string): string {
  const bytes = Buffer.from(unsignedBase64, "base64");
  const tx = getTransactionDecoder().decode(new Uint8Array(bytes));
  const at = Object.keys(tx.signatures).indexOf(visitor.address);
  if (at < 0) throw new Error("the stand-in wallet is not a signer");
  const seed = Buffer.from(base58Decode(visitor.secret).subarray(0, 32));
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  sign(null, Buffer.from(tx.messageBytes), key).copy(bytes, 1 + at * 64);
  return bytes.toString("base64");
}

async function main() {
  const waitMinutes = Number(process.argv[2] ?? "0");
  say("stand-in wallet", visitor.address);
  let lamports = await sol(visitor.address);
  for (let i = 0; lamports < 5_000_000 && i < waitMinutes * 6; i++) {
    await sleep(10_000);
    lamports = await sol(visitor.address).catch(() => lamports);
  }
  if (lamports < 5_000_000) {
    say(`NO SOL: the stand-in wallet holds ${lamports / 1e9} SOL; it needs at least 0.005 devnet SOL`);
    process.exit(2);
  }
  say("SOL", lamports / 1e9);

  // 1. give the stand-in wallet a little devnet USDC from the test seller's receiver wallet (test money, both ours)
  let funds = await usdc(visitor.address);
  if (!funds || funds.atomic < BigInt(50_000)) {
    const me = await createKeyPairSignerFromBytes(base58Decode(visitor.secret));
    const receiver = await createKeyPairSignerFromBytes(base58Decode(env.SOLANA_RECEIVER_SECRET_KEY));
    const [from] = await findAssociatedTokenPda({ mint: address(MINT), owner: receiver.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [to] = await findAssociatedTokenPda({ mint: address(MINT), owner: me.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const create = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: me, mint: address(MINT), owner: me.address });
    const move = getTransferCheckedInstruction({ source: from, mint: address(MINT), destination: to, authority: receiver, amount: BigInt(100_000), decimals: 6 });
    const latest = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(me, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: latest.blockhash as Blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight) }, m),
      (m) => appendTransactionMessageInstructions([create, move], m),
    );
    const signature = await rpc("sendTransaction", [getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message)), { encoding: "base64", preflightCommitment: "confirmed" }]);
    await confirmed(signature);
    funds = await usdc(visitor.address);
    say("funded with devnet USDC:", signature);
  }
  say("USDC", Number(funds!.atomic) / 1e6, "approved to", funds!.delegate ?? "nobody");

  // 2. the app's own flow, as the page drives it
  await app("/api/demo/reset", {});
  const started = await app("/api/market/run", { market: "test", need: { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false }, budgetUsd: 1, rateUsdHr: 0.05, askBeforePaying: false, wallet: visitor.address });
  if (!started.run) throw new Error(`the run did not start: ${started.error}`);
  say("run", started.run.id, "paid from", started.run.wallet);
  let run = started.run;
  for (let i = 0; i < 40 && run.phase !== "approval"; i++) {
    await sleep(1500);
    run = (await app("/api/demo/state")).market;
    if (["failed", "refused"].includes(run.phase)) throw new Error(`the run ended before approval: ${run.error ?? run.refusal?.detail}`);
  }
  if (run.phase !== "approval") throw new Error(`the run never reached approval (phase ${run.phase})`);
  say("approval stop:", run.approval.exact, "to", run.approval.payTo, "plan", run.approval.plan);

  const prepared = await app("/api/market/wallet", { run: run.id, code: run.approval.code });
  if (!prepared.transaction) throw new Error(`the approval was not prepared: ${prepared.error}`);
  say("approval transaction prepared for", prepared.wallet, "on", prepared.chain);

  // "revoke" mode: the approval reaches the chain, the run ends without paying, and the wallet takes the approval back
  if (process.argv.includes("revoke")) {
    const sig = await rpc("sendTransaction", [walletSign(prepared.transaction), { encoding: "base64", preflightCommitment: "confirmed" }]);
    await confirmed(sig);
    say("approval on chain, left unused:", JSON.stringify(await usdc(visitor.address), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const cancelled = await app("/api/market/destroy", { run: run.id, cancel: true });
    say("run cancelled:", cancelled.status);
    const early = await app("/api/market/wallet", { run: "nope", revoke: true });
    say("wrong run is refused:", early.status, early.error);
    const left = await app("/api/market/wallet", { run: run.id, revoke: true });
    if (!left.transaction) throw new Error(`no revoke was offered: ${JSON.stringify(left)}`);
    say("revoke offered for", left.exact, "on", left.chain);
    const wrong = await app("/api/market/wallet", { run: run.id, revoke: true, signedTransaction: walletSign(prepared.transaction) });
    say("an approval passed off as a revoke is refused:", wrong.status, wrong.error);
    const sent = await app("/api/market/wallet", { run: run.id, revoke: true, signedTransaction: walletSign(left.transaction) });
    if (sent.status !== 200) throw new Error(`the revoke was refused: ${sent.error}`);
    let now = await usdc(visitor.address);
    for (let i = 0; i < 20 && now?.delegate; i++) {
      await sleep(1500);
      now = await usdc(visitor.address);
    }
    say("after the revoke, approved to:", now?.delegate ?? "nobody");
    const again = await app("/api/market/wallet", { run: run.id, revoke: true });
    say("asking again:", JSON.stringify({ status: again.status, none: again.none }));
    say(!now?.delegate && again.none === true && wrong.status === 400 ? "RESULT: PASS" : "RESULT: FAIL");
    return;
  }
  const before = await usdc(visitor.address);
  const approved = await app("/api/market/approve", { run: run.id, code: run.approval.code, signedTransaction: walletSign(prepared.transaction) });
  if (approved.status !== 200) throw new Error(`the approval was refused: ${approved.error}`);
  say("approval accepted and sent; the agent pays next");

  for (let i = 0; i < 80; i++) {
    await sleep(1500);
    run = (await app("/api/demo/state")).market;
    if (["ready", "failed", "refused", "released"].includes(run.phase)) break;
  }
  const after = await usdc(visitor.address);
  say("ENDED IN PHASE", run.phase);
  say("payment", JSON.stringify(run.payment));
  say("machine", run.machine ? `${run.machine.id} ${run.machine.ip} ${run.machine.status}` : "none");
  say("error", run.error ?? run.refusal?.detail ?? "none");
  say("attempts", JSON.stringify(run.attempts.slice(-3)));
  say("stand-in wallet USDC before", Number(before!.atomic) / 1e6, "after", Number(after!.atomic) / 1e6, "left approved", Number(after!.delegated) / 1e6);
  if (run.phase === "ready") {
    const destroyed = await app("/api/market/destroy", { run: run.id });
    await sleep(4000);
    say("destroy:", destroyed.status, (await app("/api/demo/state")).market.phase);
  }
  say(run.phase === "ready" && run.payment?.status === "confirmed" && run.payment.payer === visitor.address ? "RESULT: PASS" : "RESULT: FAIL");
}

main().catch((e) => {
  say("RESULT: FAIL", (e as Error).message);
  process.exit(1);
});
