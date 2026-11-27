"use client";

import { useState } from "react";
import { shortAddress } from "./market-copy";
import { BTN, MONO_ID, TEXT_BTN } from "./ui";
import { connectWallet, disconnectWallet, useWallet } from "./wallet";

/**
 * Connect, or the connected wallet with a way to disconnect. One button per wallet found in the browser;
 * when there is none, how to get one. `disabled` freezes it while a run is using the wallet.
 */
export function WalletConnect({ disabled = false, id }: { disabled?: boolean; id?: string }) {
  const wallet = useWallet();
  const [error, setError] = useState<string | null>(null);

  if (wallet.connected) {
    return (
      <p id={id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-muted">{wallet.connected.wallet}</span>
        <span className={MONO_ID} title={wallet.connected.address}>
          {shortAddress(wallet.connected.address)}
        </span>
        <button type="button" className={TEXT_BTN} disabled={disabled} onClick={() => void disconnectWallet()}>
          Disconnect
        </button>
      </p>
    );
  }

  if (wallet.wallets.length === 0) {
    return (
      <p id={id} className="text-foreground">
        No Solana wallet found in this browser. Install one, such as Phantom, then reload this page.
      </p>
    );
  }

  return (
    <div id={id} className="space-y-2">
      <div className="flex flex-col gap-2">
        {wallet.wallets.map((w) => (
          <button
            key={w.name}
            type="button"
            className={`${BTN} w-full gap-2`}
            disabled={disabled || wallet.connecting !== null}
            onClick={async () => {
              setError(null);
              setError(await connectWallet(w.name));
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a wallet's own small embedded icon (a data: image), not a remote file */}
            {w.icon && <img src={w.icon} alt="" className="size-4 rounded-[3px]" />}
            {wallet.connecting === w.name ? "Check your wallet…" : `Connect ${w.name}`}
          </button>
        ))}
      </div>
      {error && (
        <p role="status" className="text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
