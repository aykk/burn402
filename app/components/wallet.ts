"use client";

import { useSyncExternalStore } from "react";

/**
 * The visitor's own wallet in this browser, of either kind:
 *
 *  - a Solana wallet, found through the Wallet Standard that browser wallets announce themselves with:
 *    Phantom, MetaMask (its Solana accounts), Solflare, Backpack, Coinbase Wallet, Trust, OKX and any other
 *    that follows it show up without this app naming them. It pays in USDC on Solana.
 *  - an Ethereum wallet, found the same way through that world's own announcement (EIP-6963): MetaMask,
 *    Coinbase Wallet, Rabby, Rainbow, Trust, OKX, Phantom's Ethereum side and the rest. It pays in USDC on Base.
 *
 * Both are found by listening for the wallets' own announcements, with no connector library and nothing
 * loaded from another site. This page never sees a key: it asks the wallet to connect (which gives an
 * address) and to sign what the server prepared, which the wallet shows its owner first.
 */

type StdAccount = { address: string; chains: readonly string[] };
type StdWallet = { name: string; icon?: string; chains: readonly string[]; features: Record<string, unknown>; accounts: readonly StdAccount[] };
type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StdAccount[] }> };
type DisconnectFeature = { disconnect(): Promise<void> };
type EventsFeature = { on(event: "change", listener: (change: { accounts?: readonly StdAccount[] }) => void): () => void };
type SignFeature = { signTransaction(...inputs: { account: StdAccount; transaction: Uint8Array; chain?: string }[]): Promise<readonly { signedTransaction: Uint8Array }[]> };

export type WalletChain = "solana:devnet" | "solana:mainnet";
/** "solana": pays in USDC on Solana. "evm": an Ethereum wallet, which pays in USDC on Base. */
export type WalletKind = "solana" | "evm";
export type WalletState = {
  /** wallets in this browser that can pay: `id` names one of them whatever its kind */
  wallets: { id: string; name: string; icon: string | null; kind: WalletKind }[];
  connected: { wallet: string; address: string; kind: WalletKind } | null;
  /** the id of the wallet being connected right now, if any */
  connecting: string | null;
};

/** The network an Ethereum wallet must be on to sign a payment, as the server names it. */
export type EvmNetwork = { chainId: number; name: string; rpcUrl: string; explorer: string };

type EvmProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown>; on?(event: string, listener: (...args: unknown[]) => void): void };
type EvmWallet = { id: string; name: string; icon: string | null; provider: EvmProvider };

const REMEMBER = "b402_wallet";
const EMPTY: WalletState = { wallets: [], connected: null, connecting: null };

const SOL = "sol:";
const EVM = "evm:";
/** Ethereum wallets by id. */
const evmFound = new Map<string, EvmWallet>();
/** The connected Ethereum wallet, when that is the kind connected. */
let evm: { wallet: EvmWallet; address: string } | null = null;

const found = new Map<string, StdWallet>();
const listeners = new Set<() => void>();
let state: WalletState = EMPTY;
let account: StdAccount | null = null;
let started = false;

function set(next: Partial<WalletState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

const feature = <T,>(w: StdWallet, name: string): T | null => {
  const f = w.features?.[name];
  return typeof f === "object" && f !== null ? (f as T) : null;
};

const isSolana = (chains: readonly string[] | undefined) => Array.isArray(chains) && chains.some((c) => typeof c === "string" && c.startsWith("solana:"));

function usable(w: unknown): w is StdWallet {
  if (typeof w !== "object" || w === null) return false;
  const c = w as StdWallet;
  return typeof c.name === "string" && c.name !== "" && isSolana(c.chains) && !!feature(c, "standard:connect") && !!feature(c, "solana:signTransaction");
}

/** Only a small embedded image is ever shown as a wallet's icon, never a link to somewhere else. */
const iconOf = (w: { icon?: unknown }) => (typeof w.icon === "string" && /^data:image\/(png|svg\+xml|webp|gif);base64,/.test(w.icon) && w.icon.length < 200_000 ? w.icon : null);

/** Every wallet found, Solana ones first. */
function listed(): WalletState["wallets"] {
  return [
    ...[...found.values()].map((x) => ({ id: SOL + x.name, name: x.name, icon: iconOf(x), kind: "solana" as const })),
    ...[...evmFound.values()].map((x) => ({ id: x.id, name: x.name, icon: x.icon, kind: "evm" as const })),
  ];
}

/** The id of the wallet used last. A bare name is a Solana wallet remembered before ids had a kind. */
function remembered(): string | null {
  try {
    const v = window.localStorage.getItem(REMEMBER);
    return v === null ? null : v.startsWith(SOL) || v.startsWith(EVM) ? v : SOL + v;
  } catch {
    return null;
  }
}
function remember(name: string | null) {
  try {
    if (name === null) window.localStorage.removeItem(REMEMBER);
    else window.localStorage.setItem(REMEMBER, name);
  } catch {
    // private windows: the wallet is simply not remembered
  }
}

function adopt(w: StdWallet, accounts: readonly StdAccount[]) {
  const first = accounts.find((a) => typeof a?.address === "string" && isSolana(a.chains)) ?? null;
  if (!first) {
    if (state.connected?.kind === "solana" && state.connected.wallet === w.name) {
      account = null;
      set({ connected: null });
    }
    return;
  }
  account = first;
  evm = null;
  set({ connected: { wallet: w.name, address: first.address, kind: "solana" } });
}

function add(w: unknown) {
  if (!usable(w) || found.has(w.name)) return;
  found.set(w.name, w);
  set({ wallets: listed() });
  // the wallet tells us when the visitor switches account or disconnects from inside it
  try {
    feature<EventsFeature>(w, "standard:events")?.on("change", (change) => {
      if (change.accounts && state.connected?.kind === "solana" && state.connected.wallet === w.name) adopt(w, change.accounts);
    });
  } catch {
    // a wallet without change events still works; the address is checked again when it signs
  }
  // the wallet used last time connects again without a prompt, if it still trusts this site
  if (remembered() === SOL + w.name) void reconnectQuietly();
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const firstAddress = (v: unknown): string | null => (Array.isArray(v) && typeof v[0] === "string" && EVM_ADDRESS.test(v[0]) ? v[0] : null);

function adoptEvm(w: EvmWallet, accounts: unknown) {
  const address = firstAddress(accounts);
  if (!address) {
    if (state.connected?.kind === "evm" && evm?.wallet.id === w.id) {
      evm = null;
      set({ connected: null });
    }
    return;
  }
  evm = { wallet: w, address };
  account = null;
  set({ connected: { wallet: w.name, address, kind: "evm" } });
}

/** An Ethereum wallet announcing itself (EIP-6963): its name, its small icon, and the object it is asked through. */
function addEvm(detail: unknown) {
  if (!isObj(detail) || !isObj(detail.info) || !isObj(detail.provider) || typeof detail.provider.request !== "function") return;
  const { name, rdns, uuid } = detail.info;
  const key = typeof rdns === "string" && rdns !== "" ? rdns : typeof uuid === "string" ? uuid : "";
  if (typeof name !== "string" || name === "" || name.length > 60 || key === "" || key.length > 120) return;
  const id = EVM + key;
  if (evmFound.has(id)) return;
  const w: EvmWallet = { id, name, icon: iconOf(detail.info), provider: detail.provider as EvmProvider };
  evmFound.set(id, w);
  set({ wallets: listed() });
  try {
    // the wallet tells us when the visitor switches account or disconnects from inside it
    w.provider.on?.("accountsChanged", (accounts) => {
      if (state.connected?.kind === "evm" && evm?.wallet.id === id) adoptEvm(w, accounts);
    });
  } catch {
    // a wallet without change events still works; the address is checked again when it signs
  }
  if (remembered() === id) void reconnectQuietly();
}

let reconnecting: Promise<void> | null = null;

/**
 * Connects again to the wallet used last, without a prompt. A wallet drops its connection whenever it
 * locks or its owner looks at another account, and says nothing when it is unlocked again; so this is
 * tried when the wallet is found, when the visitor comes back to the page, and before a signature is
 * asked for. A wallet that is locked or no longer trusts the site simply stays disconnected.
 */
function reconnectQuietly(): Promise<void> {
  const id = remembered();
  if (!id || state.connected || state.connecting) return Promise.resolve();
  const ew = evmFound.get(id);
  if (ew) {
    // eth_accounts never opens the wallet: it answers with the accounts this site may already see, or none
    reconnecting ??= ew.provider
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        if (!state.connected) adoptEvm(ew, accounts);
      })
      .catch(() => {})
      .finally(() => {
        reconnecting = null;
      });
    return reconnecting;
  }
  const w = id.startsWith(SOL) ? found.get(id.slice(SOL.length)) : undefined;
  const connect = w && feature<ConnectFeature>(w, "standard:connect");
  if (!w || !connect) return Promise.resolve();
  reconnecting ??= connect
    .connect({ silent: true })
    .then((r) => {
      if (!state.connected) adopt(w, r.accounts);
    })
    .catch(() => {})
    .finally(() => {
      reconnecting = null;
    });
  return reconnecting;
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const api = Object.freeze({
    register: (...wallets: unknown[]) => {
      for (const w of wallets) add(w);
      return () => {};
    },
  });
  try {
    // wallets that load after this page announce themselves with this event...
    window.addEventListener("wallet-standard:register-wallet", (event) => {
      const callback = (event as CustomEvent<unknown>).detail;
      if (typeof callback === "function") (callback as (a: typeof api) => void)(api);
    });
    // ...and wallets already loaded are waiting for this one
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
    // Ethereum wallets answer this request by announcing themselves, now and whenever one loads later
    window.addEventListener("eip6963:announceProvider", (event) => addEvm((event as CustomEvent<unknown>).detail));
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // back from the wallet's window (unlocking it, a swap, switching account): pick the connection up again
    window.addEventListener("focus", () => void reconnectQuietly());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void reconnectQuietly();
    });
  } catch {
    // no wallets: the page says so
  }
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The wallets in this browser and the one connected, kept current. */
export function useWallet(): WalletState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
}

const DECLINED = "You declined the request in your wallet.";

/** An Ethereum wallet's error number: 4001 is "the user said no", 4902 "I do not know that network", -32002 "a request is already open". */
const codeOf = (e: unknown): number | null => (isObj(e) && typeof e.code === "number" ? e.code : null);

/** What a wallet says when the visitor closes its window or presses Reject, in this app's words. */
function reasonOf(e: unknown): string {
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : isObj(e) && typeof e.message === "string" ? e.message : "";
  if (codeOf(e) === 4001 || /reject|denied|declin|cancel|closed/i.test(text)) return DECLINED;
  if (codeOf(e) === -32002) return "Your wallet already has a request open. Open the wallet and answer it, then try again.";
  return text ? `Your wallet said: ${text.slice(0, 200)}` : "Your wallet did not answer.";
}

/** How long the page waits for a wallet to answer a connect request before it frees its buttons again. */
const CONNECT_WAIT_MS = 90_000;
const NO_ANSWER = Symbol("no answer");

/**
 * Waits for the wallet, but not for ever: a wallet that is not set up, or whose window was closed without
 * an answer, never replies. The request itself cannot be withdrawn, so `late` still runs if the answer
 * comes afterwards (the visitor approved in the end) and the wallet connects then.
 */
async function answered<T>(request: Promise<T>, late: (value: T) => void): Promise<T | typeof NO_ANSWER> {
  let waiting = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof NO_ANSWER>((resolve) => {
    timer = setTimeout(() => {
      waiting = false;
      resolve(NO_ANSWER);
    }, CONNECT_WAIT_MS);
  });
  request.then(
    (value) => {
      if (!waiting) late(value);
    },
    () => {},
  );
  try {
    return await Promise.race([request, timeout]);
  } finally {
    waiting = false;
    clearTimeout(timer);
  }
}

const noAnswer = (name: string) => `${name} did not answer. Open ${name} and look for a request waiting there. If it is not set up yet, set it up first, then try again.`;

async function connectEvm(w: EvmWallet): Promise<string | null> {
  set({ connecting: w.id });
  try {
    const accounts = await answered(w.provider.request({ method: "eth_requestAccounts" }), (late) => {
      if (!state.connected && firstAddress(late)) {
        adoptEvm(w, late);
        remember(w.id);
      }
    });
    if (accounts === NO_ANSWER) return noAnswer(w.name);
    adoptEvm(w, accounts);
    if (!evm) return `${w.name} shared no account. Unlock it, pick an account, then connect again.`;
    remember(w.id);
    return null;
  } catch (e) {
    const said = reasonOf(e);
    if (said === DECLINED || codeOf(e) === -32002) return said;
    return `${w.name} could not connect. Open ${w.name}, unlock it, then try again. (${said})`;
  } finally {
    set({ connecting: null });
  }
}

/** Asks the wallet with this id to connect. Resolves to the failure in words, or null. */
export async function connectWallet(id: string): Promise<string | null> {
  const ew = evmFound.get(id);
  if (ew) return connectEvm(ew);
  const name = id.startsWith(SOL) ? id.slice(SOL.length) : id;
  const w = found.get(name);
  const connect = w && feature<ConnectFeature>(w, "standard:connect");
  if (!w || !connect) return "That wallet is not available in this browser.";
  set({ connecting: SOL + name });
  try {
    const result = await answered(connect.connect(), (late) => {
      if (!state.connected) {
        adopt(w, late.accounts);
        if (account) remember(SOL + name);
      }
    });
    if (result === NO_ANSWER) return noAnswer(name);
    adopt(w, result.accounts);
    // MetaMask and Coinbase Wallet hold Ethereum accounts first; a Solana account has to exist in the wallet to pay here
    if (!account) return `${name} shared no Solana account. Add or select a Solana account in the wallet, then connect again.`;
    remember(SOL + name);
    return null;
  } catch (e) {
    const said = reasonOf(e);
    // Declined is the visitor's own choice. Anything else came from inside the wallet (a wallet that is locked,
    // not set up, or has no Solana account can fail with an error of its own): say what to check, and keep its words.
    if (said === DECLINED) return said;
    return `${name} could not connect. Open ${name}, unlock it and check that it has a Solana account, then try again. (${said})`;
  } finally {
    set({ connecting: null });
  }
}

export async function disconnectWallet(): Promise<void> {
  const w = state.connected?.kind === "solana" ? found.get(state.connected.wallet) : undefined;
  // an Ethereum wallet has no "disconnect" a site can ask for: it is forgotten here, and its owner can remove the site in the wallet
  account = null;
  evm = null;
  remember(null);
  set({ connected: null });
  try {
    await (w && feature<DisconnectFeature>(w, "standard:disconnect"))?.disconnect();
  } catch {
    // forgotten here either way
  }
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const CHAIN_NAME: Record<WalletChain, string> = { "solana:devnet": "Solana devnet", "solana:mainnet": "Solana mainnet" };

/**
 * Asks the connected wallet to sign one transaction (base64 in, base64 out). The wallet shows the visitor
 * what it does; nothing is sent from here. `address` is the wallet the run was started with: another
 * account is refused before the wallet is asked.
 */
export async function signWithWallet(transactionBase64: string, chain: WalletChain, address: string): Promise<{ ok: true; signed: string } | { ok: false; error: string }> {
  // the wallet may have dropped the connection since the page last looked
  if (!state.connected) await reconnectQuietly();
  const w = state.connected?.kind === "solana" ? found.get(state.connected.wallet) : undefined;
  const sign = w && feature<SignFeature>(w, "solana:signTransaction");
  if (!w || !sign || !account) return { ok: false, error: "Connect your wallet first." };
  if (account.address !== address) return { ok: false, error: "Your wallet is on another account than the one this rental was started with. Switch back to it in the wallet." };
  if (!account.chains.includes(chain)) return { ok: false, error: `${w.name} does not offer ${CHAIN_NAME[chain]} for this account.` };
  try {
    const [out] = await sign.signTransaction({ account, transaction: fromBase64(transactionBase64), chain });
    const raw: ArrayLike<number> | undefined = out?.signedTransaction;
    if (!raw || typeof raw.length !== "number" || raw.length === 0) return { ok: false, error: "Your wallet sent back nothing to send." };
    return { ok: true, signed: toBase64(Uint8Array.from(raw)) };
  } catch (e) {
    return { ok: false, error: reasonOf(e) };
  }
}

const sameEvm = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const OTHER_ACCOUNT = "Your wallet is on another account than the one this rental was started with. Switch back to it in the wallet.";
/** The two networks this app ever asks an Ethereum wallet to sign for: Base and its test network. */
const BASE_CHAIN_IDS = new Set([8453, 84532]);

/** The connected Ethereum wallet, on the account the run was started with; else why not, in words. */
async function evmFor(address: string): Promise<{ ok: true; wallet: EvmWallet } | { ok: false; error: string }> {
  if (!state.connected) await reconnectQuietly();
  if (!evm || state.connected?.kind !== "evm") return { ok: false, error: "Connect your wallet first." };
  // ask the wallet itself which account it is on now, without opening it
  try {
    const now = firstAddress(await evm.wallet.provider.request({ method: "eth_accounts" }));
    if (now && !sameEvm(now, evm.address)) adoptEvm(evm.wallet, [now]);
  } catch {
    // the address the page last saw is checked below
  }
  if (!evm) return { ok: false, error: "Connect your wallet first." };
  if (!sameEvm(evm.address, address)) return { ok: false, error: OTHER_ACCOUNT };
  return { ok: true, wallet: evm.wallet };
}

/**
 * Puts the wallet on the network the payment is for: switches to it, adding it first if the wallet does not
 * know it. Resolves to whether the wallet had to be moved (which can take its owner a while).
 */
async function switchToNetwork(p: EvmProvider, net: EvmNetwork): Promise<boolean> {
  const want = `0x${net.chainId.toString(16)}`;
  const current = await p.request({ method: "eth_chainId" }).catch(() => null);
  if (typeof current === "string" && current.toLowerCase() === want) return false;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e) {
    const text = isObj(e) && typeof e.message === "string" ? e.message : "";
    if (codeOf(e) !== 4902 && !/unrecognized chain|not been added|unknown chain|wallet_addEthereumChain/i.test(text)) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: want, chainName: net.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [net.rpcUrl], blockExplorerUrls: [net.explorer] }],
    });
  }
  return true;
}

/**
 * Gets the connected Ethereum wallet onto the payment's network before the payment is prepared. A prepared
 * payment is good for a few minutes only, and adding or switching a network is where a visitor can spend
 * them; `moved` says the wallet was on another network, so the payment should be prepared afresh.
 */
export async function readyWalletForNetwork(network: EvmNetwork, address: string): Promise<{ ok: true; moved: boolean } | { ok: false; error: string }> {
  const found = await evmFor(address);
  if (!found.ok) return found;
  if (!BASE_CHAIN_IDS.has(network.chainId)) return { ok: false, error: "That payment is not on Base, so your wallet was not asked to sign it." };
  try {
    return { ok: true, moved: await switchToNetwork(found.wallet.provider, network) };
  } catch (e) {
    return { ok: false, error: reasonOf(e) };
  }
}

/**
 * Asks the connected Ethereum wallet to sign one payment message the server prepared (USDC, an exact
 * amount, to the seller). The wallet shows its owner every field first. It is switched to the payment's
 * network if it is on another. Signing costs no network fee, and nothing is sent from here.
 */
export async function signPaymentWithWallet(typedData: unknown, network: EvmNetwork, address: string): Promise<{ ok: true; signature: string } | { ok: false; error: string }> {
  const found = await evmFor(address);
  if (!found.ok) return found;
  if (!BASE_CHAIN_IDS.has(network.chainId)) return { ok: false, error: "That payment is not on Base, so your wallet was not asked to sign it." };
  try {
    await switchToNetwork(found.wallet.provider, network);
    const signature = await found.wallet.provider.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(typedData)] });
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return { ok: false, error: "Your wallet sent back nothing to send." };
    // 65 bytes is an ordinary account. A smart-contract account signs differently, and the seller's sign-in for the machine would not take it.
    if (signature.length !== 132) return { ok: false, error: "This looks like a smart-contract wallet account, which cannot be used here yet: it could pay but not check on its machine. Use an ordinary account." };
    return { ok: true, signature };
  } catch (e) {
    return { ok: false, error: reasonOf(e) };
  }
}

/**
 * Asks the connected Ethereum wallet to sign a few lines of text: the seller's sign-in for the machine
 * that wallet owns, to look at it or destroy it. It moves no money and costs nothing.
 */
export async function signTextWithWallet(message: string, address: string): Promise<{ ok: true; signature: string } | { ok: false; error: string }> {
  const found = await evmFor(address);
  if (!found.ok) return found;
  try {
    const hex = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    const signature = await found.wallet.provider.request({ method: "personal_sign", params: [hex, address] });
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, error: "Your wallet sent back nothing to send." };
    return { ok: true, signature };
  } catch (e) {
    return { ok: false, error: reasonOf(e) };
  }
}
