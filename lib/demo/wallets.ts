export const DEVNET_RPC = "https://api.devnet.solana.com";
export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export type WalletView = {
  role: string;
  address: string;
  usdc: number | null;
  sol: number | null;
  explorer: string;
};

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(DEVNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (!body.result) throw new Error(body.error?.message ?? `${method} failed`);
  return body.result;
}

async function balances(address: string): Promise<{ usdc: number; sol: number }> {
  const [lamports, tokens] = await Promise.all([
    rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]),
    rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }[] }>("getTokenAccountsByOwner", [
      address,
      { mint: DEVNET_USDC },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]),
  ]);
  return {
    sol: lamports.value / 1e9,
    usdc: tokens.value.reduce((sum, a) => sum + a.account.data.parsed.info.tokenAmount.uiAmount, 0),
  };
}

export class WalletWatcher {
  readonly wallets: WalletView[];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(entries: { role: string; address: string }[]) {
    this.wallets = entries.map((e) => ({
      ...e,
      usdc: null,
      sol: null,
      explorer: `https://explorer.solana.com/address/${e.address}?cluster=devnet`,
    }));
  }

  async refresh(): Promise<void> {
    await Promise.all(
      this.wallets.map(async (w) => {
        try {
          Object.assign(w, await balances(w.address));
        } catch {}
      }),
    );
  }

  start(everyMs = 5000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
