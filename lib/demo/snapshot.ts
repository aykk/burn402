import type { OpenPurchase } from "../market/journal";
import { visibleOpenPurchases } from "../market/recover";
import type { MarketRunView } from "../market/run";
import { isLocalHost, marketJournal, walletReady } from "../market/session";
import type { LogLine } from "./log";
import { modelsView, type ModelsView } from "./models";
import type { LedgerEntry, StoredTransaction } from "./runtime";
import { AGENT_BUDGET, HOURLY_CAP, ROOT, TO_HELPER, TO_TESTER, type AgentRunView, type DemoSession, type StressView } from "./script";
import type { ServerView } from "./servers";
import type { TrainingRunView } from "./train";
import type { WalletView } from "./wallets";

export type BudgetView = { label: string; limit: number; rate: number; remaining: number; burn: number; effectiveExp: number; allocated: number };

export type Snapshot = {
  /** seconds */
  now: number;
  /** the same instant in ms, for comparing with MarketRunView times (all ms) */
  nowMs: number;
  busy: boolean;
  network: "testnet" | "production";
  disclosure: "desk-only" | "full";
  helper: { ansName: string; budget: number; hourlyCap: number };
  agent: AgentRunView;
  company: { name: string; ansName: string } | null;
  runs: TrainingRunView[];
  agents: string[];
  job: TrainingRunView | null;
  previous: TrainingRunView | null;
  models: ModelsView;
  budgets: BudgetView[];
  servers: ServerView[];
  transactions: StoredTransaction[];
  wallets: WalletView[];
  ledger: LedgerEntry[];
  stress: StressView;
  log: LogLine[];
  market: MarketRunView | null;
  /** journal purchases that were paid and not released; the current run is left out only while it is still going */
  openPurchases: OpenPurchase[];
  walletReady: { test: boolean; real: boolean };
};

export function snapshot(s: DemoSession): Snapshot {
  const rt = s.rt;
  const budgets: BudgetView[] = [ROOT, TO_HELPER, TO_TESTER]
    .filter((label) => s.hashes[label])
    .map((label) => {
      const st = rt.broker.status(s.hashes[label]);
      return { label, limit: st.limit_usd, rate: st.rate_usd_hr, remaining: st.remaining_usd, burn: st.burn_usd_hr, effectiveExp: st.effective_exp, allocated: st.allocated_usd };
    });
  const market = s.market?.view() ?? null;
  let openPurchases: OpenPurchase[] = [];
  try {
    openPurchases = visibleOpenPurchases(marketJournal(rt.config.root).open(), market);
  } catch {
    // an unreadable journal must not break the page
  }
  const nowMs = Date.now();
  return {
    now: nowMs / 1000,
    nowMs,
    busy: s.busy,
    network: rt.network,
    disclosure: rt.disclosure,
    helper: { ansName: rt.actors.helper.name, budget: AGENT_BUDGET, hourlyCap: HOURLY_CAP },
    agent: s.agent,
    company: s.company ? { name: s.company.name, ansName: s.company.ansName } : null,
    runs: s.finished().map((r) => r.view()),
    agents: Object.keys(s.rt.entries),
    job: s.job?.view() ?? null,
    previous: s.previous,
    models: modelsView(),
    budgets,
    servers: rt.servers.servers,
    transactions: rt.transactions,
    wallets: rt.wallets.wallets,
    ledger: rt.ledger,
    stress: s.stress,
    log: rt.log.lines,
    market,
    openPurchases,
    walletReady: walletReady(),
  };
}

/**
 * The snapshot for one HTTP request. The approval code pays for a purchase, so it is only
 * handed to requests addressed to 127.0.0.1:3000 or localhost:3000; a DNS-rebinding page
 * reaches the app under its own host name and gets `market.approval: null`.
 */
export function snapshotFor(s: DemoSession, request: Request): Snapshot {
  const state = snapshot(s);
  if (!isLocalHost(request) && state.market) state.market = { ...state.market, approval: null };
  return state;
}
