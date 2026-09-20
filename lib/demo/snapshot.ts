import type { LogLine } from "./log";
import { modelsView, type ModelsView } from "./models";
import type { LedgerEntry, StoredTransaction } from "./runtime";
import { AGENT_BUDGET, HOURLY_CAP, ROOT, TO_HELPER, TO_TESTER, type AgentRunView, type DemoSession, type StressView } from "./script";
import type { ServerView } from "./servers";
import type { TrainingRunView } from "./train";
import type { WalletView } from "./wallets";

export type BudgetView = { label: string; limit: number; rate: number; remaining: number; burn: number; effectiveExp: number; allocated: number };

export type Snapshot = {
  now: number;
  busy: boolean;
  network: "testnet" | "production";
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
};

export function snapshot(s: DemoSession): Snapshot {
  const rt = s.rt;
  const budgets: BudgetView[] = [ROOT, TO_HELPER, TO_TESTER]
    .filter((label) => s.hashes[label])
    .map((label) => {
      const st = rt.broker.status(s.hashes[label]);
      return { label, limit: st.limit_usd, rate: st.rate_usd_hr, remaining: st.remaining_usd, burn: st.burn_usd_hr, effectiveExp: st.effective_exp, allocated: st.allocated_usd };
    });
  return {
    now: Date.now() / 1000,
    busy: s.busy,
    network: rt.network,
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
  };
}
