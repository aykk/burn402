/** How a purchase ended, as the signed transaction record on Arweave says it. */
export type TransactionOutcome = "accepted" | "refused" | "payment rejected" | "failed";

/** One purchase as it is signed and stored on Arweave. */
export type TransactionRecord = {
  at: number;
  subject: string;
  mandate: string | null;
  mandateJti: string | null;
  plan: string;
  region: string;
  outcome: TransactionOutcome;
  reason: string | null;
  usd: number | null;
  tx: string | null;
  server: string | null;
  /** Which Solana cluster `tx` is on; set by market purchases, absent on older records. */
  cluster?: "devnet" | "mainnet";
};
