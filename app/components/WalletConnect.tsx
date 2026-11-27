"use client";

import { useState } from "react";
import { shortAddress } from "./market-copy";
import { Segmented } from "./Segmented";
import { BTN, MONO_ID, TEXT_BTN } from "./ui";
import { connectWallet, disconnectWallet, useWallet, type WalletKind } from "./wallet";

const NETWORKS = [
  { value: "solana" as const, label: "Solana" },
  { value: "evm" as const, label: "Base" },
];

/**
 * Connect, or the connected wallet with a way to disconnect. First which network the wallet pays on (USDC
 * on Solana, or USDC on Base for Ethereum wallets such as MetaMask), then one button per wallet of that
 * kind found in the browser; when there is none, how to get one. `only` fixes the kind (a run already under
 * way pays on one network). `disabled` freezes it while a run is using the wallet.
 */
export function WalletConnect({ disabled = false, id, only }: { disabled?: boolean; id?: string; only?: WalletKind }) {
  const wallet = useWallet();
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<WalletKind | null>(null);
  const kind: WalletKind = only ?? picked ?? "solana";
  const shown = wallet.wallets.filter((w) => w.kind === kind);

  if (wallet.connected && (!only || wallet.connected.kind === only)) {
    return (
      <p id={id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-muted">
          {wallet.connected.wallet}, {wallet.connected.kind === "evm" ? "Base" : "Solana"}
        </span>
        <span className={MONO_ID} title={wallet.connected.address}>
          {shortAddress(wallet.connected.address)}
        </span>
        <button type="button" className={TEXT_BTN} disabled={disabled} onClick={() => void disconnectWallet()}>
          Disconnect
        </button>
      </p>
    );
  }

  return (
    <div id={id} className="space-y-2">
      {!only && (
        <Segmented
          label="Pay in USDC on"
          options={NETWORKS}
          value={kind}
          onChange={(k) => {
            setError(null);
            setPicked(k);
          }}
          disabled={disabled}
          fill
        />
      )}
      {shown.length === 0 ? (
        <p className="text-foreground">
          {kind === "evm"
            ? "No Ethereum wallet found in this browser. Install one (MetaMask, Coinbase Wallet, Rabby and Rainbow all work), then reload this page."
            : "No Solana wallet found in this browser. Install one (Phantom, Solflare, Backpack and MetaMask all work), then reload this page."}{" "}
          On a phone, open this page in your wallet app&apos;s built-in browser.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((w) => (
            <button
              key={w.id}
              type="button"
              className={`${BTN} w-full gap-2`}
              disabled={disabled || wallet.connecting !== null}
              onClick={async () => {
                setError(null);
                setError(await connectWallet(w.id));
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a wallet's own small embedded icon (a data: image), not a remote file */}
              {w.icon && <img src={w.icon} alt="" className="size-4 rounded-[3px]" />}
              {wallet.connecting === w.id ? "Check your wallet…" : `Connect ${w.name}`}
            </button>
          ))}
        </div>
      )}
      {/* What is different about paying on Base, said once where the choice is made. */}
      {kind === "evm" && !only && (
        <p className="text-[12px] leading-4 text-muted">
          On Base your wallet pays the seller itself, with no network fee, so the machine is your wallet&apos;s: you sign once to pay, and again each time you check on it
          or destroy it.
        </p>
      )}
      {error && (
        <p role="status" className="text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
