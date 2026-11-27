"use client";

import { useSyncExternalStore } from "react";

/**
 * The visitor's own Solana wallet, found through the Wallet Standard that browser wallets announce themselves
 * with: Phantom, MetaMask (its Solana accounts), Solflare, Backpack, Coinbase Wallet, Trust, OKX and any other
 * that follows it show up without this app naming them. Payments here are in USDC on Solana, so an
 * Ethereum-only connector (RainbowKit, wagmi) does not apply: it cannot sign a Solana transaction. This page never sees a key: it asks the wallet to connect
 * (which gives an address) and, at the approval stop, to sign one transaction the server prepared.
 */

type StdAccount = { address: string; chains: readonly string[] };
type StdWallet = { name: string; icon?: string; chains: readonly string[]; features: Record<string, unknown>; accounts: readonly StdAccount[] };
type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StdAccount[] }> };
type DisconnectFeature = { disconnect(): Promise<void> };
type EventsFeature = { on(event: "change", listener: (change: { accounts?: readonly StdAccount[] }) => void): () => void };
type SignFeature = { signTransaction(...inputs: { account: StdAccount; transaction: Uint8Array; chain?: string }[]): Promise<readonly { signedTransaction: Uint8Array }[]> };

export type WalletChain = "solana:devnet" | "solana:mainnet";
export type WalletState = {
  /** wallets in this browser that can sign Solana transactions */
  wallets: { name: string; icon: string | null }[];
  connected: { wallet: string; address: string } | null;
  /** the wallet being connected right now, if any */
  connecting: string | null;
};

const REMEMBER = "b402_wallet";
const EMPTY: WalletState = { wallets: [], connected: null, connecting: null };

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
const iconOf = (w: StdWallet) => (typeof w.icon === "string" && /^data:image\/(png|svg\+xml|webp|gif);base64,/.test(w.icon) && w.icon.length < 200_000 ? w.icon : null);

function remembered(): string | null {
  try {
    return window.localStorage.getItem(REMEMBER);
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
    if (state.connected?.wallet === w.name) {
      account = null;
      set({ connected: null });
    }
    return;
  }
  account = first;
  set({ connected: { wallet: w.name, address: first.address } });
}

function add(w: unknown) {
  if (!usable(w) || found.has(w.name)) return;
  found.set(w.name, w);
  set({ wallets: [...found.values()].map((x) => ({ name: x.name, icon: iconOf(x) })) });
  // the wallet tells us when the visitor switches account or disconnects from inside it
  try {
    feature<EventsFeature>(w, "standard:events")?.on("change", (change) => {
      if (change.accounts && state.connected?.wallet === w.name) adopt(w, change.accounts);
    });
  } catch {
    // a wallet without change events still works; the address is checked again when it signs
  }
  // the wallet used last time connects again without a prompt, if it still trusts this site
  if (remembered() === w.name) void reconnectQuietly();
}

let reconnecting: Promise<void> | null = null;

/**
 * Connects again to the wallet used last, without a prompt. A wallet drops its connection whenever it
 * locks or its owner looks at another account, and says nothing when it is unlocked again; so this is
 * tried when the wallet is found, when the visitor comes back to the page, and before a signature is
 * asked for. A wallet that is locked or no longer trusts the site simply stays disconnected.
 */
function reconnectQuietly(): Promise<void> {
  const name = remembered();
  const w = name ? found.get(name) : undefined;
  const connect = w && feature<ConnectFeature>(w, "standard:connect");
  if (!w || !connect || state.connected || state.connecting) return Promise.resolve();
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

/** What a wallet says when the visitor closes its window or presses Reject, in this app's words. */
function reasonOf(e: unknown): string {
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (/reject|denied|declin|cancel|closed/i.test(text)) return DECLINED;
  return text ? `Your wallet said: ${text.slice(0, 200)}` : "Your wallet did not answer.";
}

/** Asks the named wallet to connect. Resolves to the failure in words, or null. */
export async function connectWallet(name: string): Promise<string | null> {
  const w = found.get(name);
  const connect = w && feature<ConnectFeature>(w, "standard:connect");
  if (!w || !connect) return "That wallet is not available in this browser.";
  set({ connecting: name });
  try {
    const { accounts } = await connect.connect();
    adopt(w, accounts);
    // MetaMask and Coinbase Wallet hold Ethereum accounts first; a Solana account has to exist in the wallet to pay here
    if (!account) return `${name} shared no Solana account. Add or select a Solana account in the wallet, then connect again.`;
    remember(name);
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
  const w = state.connected ? found.get(state.connected.wallet) : undefined;
  account = null;
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
  const w = state.connected ? found.get(state.connected.wallet) : undefined;
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
