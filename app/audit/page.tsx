"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";

type Turn = Snapshot["agent"]["transcript"][number];

const TOOL_LABEL: Record<string, string> = {
  read_agent_card: "read the broker's agent card",
  list_plans: "asked for the server plans and prices",
  rent_server: "asked to rent",
};

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function money(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${parseFloat(n.toFixed(6))}`;
}

function plainReason(reason: string): string {
  if (/UNKNOWN_KEY|SIGNATURE_INVALID/.test(reason)) return "the budget's signature doesn't match the agent that supposedly issued it";
  const rate = /plan ([\d.]+)\/hr > mandate rate ([\d.]+)\/hr/.exec(reason);
  if (rate) return `over the hourly limit: this server costs $${rate[1]}/hour, the budget allows $${rate[2]}/hour`;
  if (/BUDGET_EXCEEDED/.test(reason)) return "not enough budget left";
  if (/WINDOW_EXPIRED/.test(reason)) return "the budget has expired";
  if (/SCOPE_ESCALATION/.test(reason)) return "the budget doesn't allow renting servers";
  if (/IDENTITY_UNANCHORED/.test(reason)) return "the agent isn't registered in ANS";
  return reason.replace(/^[A-Z_]+: /, "");
}

function describe(t: Turn): { who: "task" | "agent" | "action" | "reply"; text: string } | null {
  if (t.kind === "task") return { who: "task", text: t.content };
  if (t.kind === "text") return { who: "agent", text: t.content };
  if (t.kind === "tool_call") {
    const name = t.content.split("(")[0];
    const plan = /"plan":"([^"]+)"/.exec(t.content)?.[1];
    return { who: "action", text: `${TOOL_LABEL[name] ?? name}${plan ? ` ${plan}` : ""}` };
  }
  if (t.kind === "tool_result") {
    const status = /"status":(\d{3})/.exec(t.content)?.[1];
    if (status) return { who: "reply", text: status === "200" ? "broker: rented and paid" : status === "403" ? "broker: refused" : `broker: HTTP ${status}` };
    if (t.content.includes('"plans"')) return { who: "reply", text: `broker: ${(t.content.match(/"plan":/g) ?? []).length} plans` };
    if (t.content.includes('"skills"')) return { who: "reply", text: "broker: here is how to rent from me, paid over x402" };
  }
  return null;
}

export default function Page() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const logRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/demo/state", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSnap(body);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const poll = setInterval(load, 1000);
    const tick = setInterval(() => setNow(Date.now() / 1000), 500);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [snap?.log.length, drawer]);

  const post = async (path: string, body?: unknown) => {
    try {
      const res = await fetch(path, { method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSnap(json);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setNetwork = (network: "testnet" | "production") => {
    if (network === "production" && !window.confirm("Records on mainnet are permanent and public. Switch to mainnet?")) return;
    void post("/api/demo/network", { network });
  };

  const agent = snap?.agent;
  const running = snap?.busy ?? false;
  const helperBudget = snap?.budgets.find((b) => b.label === "Your agent → helper");
  const rootBudget = snap?.budgets.find((b) => b.label === "You → your agent");
  const helperServer = snap?.servers.filter((v) => v.rentedBy === "helper").at(-1);
  const helperTx = snap?.transactions.filter((t) => t.subject === snap.helper.ansName).at(-1);
  const described = (agent?.transcript ?? []).map(describe).filter((t): t is NonNullable<ReturnType<typeof describe>> => t !== null);
  const lastSaid = described.findLastIndex((t) => t.who === "agent");
  const turns = described.filter((t, i) => t.who !== "task" && (t.who !== "agent" || i === lastSaid));
  const stage = !agent || agent.status === "idle" ? 0 : helperTx?.storage === "stored" ? 5 : helperTx ? 4 : turns.some((t) => t.who === "reply") ? 3 : 1;

  return (
    <main className="mx-auto flex h-screen w-full max-w-[1280px] flex-col gap-4 overflow-hidden px-6 py-4">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-rule pb-3">
        <Link href="/" className="text-lg font-bold text-foreground no-underline">
          burn402
        </Link>
        <span className="font-bold">ANS, mandates, receipts</span>
        <span className="flex items-center gap-1 text-muted">
          Records go to Arweave
          {(["testnet", "production"] as const).map((n) => (
            <button
              key={n}
              className={`ml-1 border px-2 ${snap?.network === n ? "border-foreground text-foreground" : "border-rule"}`}
              disabled={snap?.network === n}
              onClick={() => setNetwork(n)}
            >
              {n === "production" ? "mainnet" : "testnet"}
            </button>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-7">
          <Link href={`/records?network=${snap?.network ?? "testnet"}`}>Arweave records</Link>
          <button className="underline underline-offset-2" onClick={() => setDrawer(true)}>
            Log
          </button>
          <button className="text-muted underline underline-offset-2" onClick={() => post("/api/demo/reset")}>
            Start over
          </button>
        </span>
      </header>

      <section className="flex flex-wrap items-center gap-4">
        <p className="max-w-[80ch]">
          The machinery under the demo. An agent gets a budget instead of your account key: it can find a server, rent it and pay for it, but it can
          never spend more than you allowed, a second agent tries to break those rules, and every transaction is stored where anyone can check it.
        </p>
        <button
          className="ml-auto border border-foreground px-4 py-2 font-bold hover:bg-foreground hover:text-background disabled:opacity-40"
          disabled={running || !snap?.models.providers.find((p) => p.id === snap.models.selected)?.key}
          onClick={() => post("/api/demo/agent")}
        >
          {agent?.status === "running" ? "Agent is working…" : agent?.status === "done" ? "Run the agent again" : "Run the agent"}
        </button>
      </section>

      {error && <div className="text-bad">Can&apos;t reach the demo server ({error}). Start it with: npm run demo</div>}

      <section className="grid min-h-0 flex-1 gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="min-h-0 space-y-5 overflow-y-auto pr-2">
          <Stage n={1} active={stage >= 1} title="The agent">
            {snap && <ModelPicker models={snap.models} disabled={running} onSave={(provider, key) => post("/api/demo/model", { provider, key })} />}
            <div className="mt-1 text-muted">registered in ANS as {snap?.helper.ansName ?? "…"}</div>
          </Stage>

          <Stage n={2} active={stage >= 1} title="It asks another agent, the broker">
            {turns.length === 0 ? (
              <div className="text-muted">{agent?.status === "running" ? "Starting…" : "Waiting for you to run it."}</div>
            ) : (
              <div className="space-y-1">
                {turns.map((t, i) => (
                  <div key={i} className={t.who === "task" ? "text-muted" : t.who === "reply" ? "pl-4 text-muted" : ""}>
                    {t.who === "task" ? `Task: ${t.text}` : t.who === "agent" ? `helper: "${t.text}"` : t.who === "action" ? `→ ${t.text}` : `← ${t.text}`}
                  </div>
                ))}
                {agent?.status === "running" && <div className="text-muted">…</div>}
                {agent?.error && <div className="text-bad">{agent.error}</div>}
              </div>
            )}
          </Stage>

          <Stage n={3} active={stage >= 3} title="Its budget, handed down">
            <Chain
              links={[
                { who: "You", detail: rootBudget ? money(rootBudget.limit) : "$20" },
                { who: "Your agent", detail: `passes on ${money(snap?.helper.budget ?? 0.0006)}` },
                { who: "helper", detail: `max ${money(snap?.helper.hourlyCap ?? 0.01)}/hour` },
              ]}
            />
            {helperBudget && helperBudget.burn > 0 && (
              <Burn
                remaining={Math.max(0, helperBudget.remaining - (helperBudget.burn * (now - (snap?.now ?? now))) / 3600)}
                limit={helperBudget.limit}
                secondsLeft={helperBudget.effectiveExp - now}
              />
            )}
          </Stage>

          <Stage n={4} active={stage >= 4} title="It rents a server and pays">
            {helperServer ? (
              <div className="space-y-1">
                <div>
                  <b>
                    {helperServer.provider} {helperServer.plan}
                  </b>
                  , {helperServer.specs}, {money(helperServer.hourlyUsd)}/hour
                </div>
                <div>
                  <span className={helperServer.status === "live" ? "text-ok" : helperServer.status === "shut down" ? "text-muted" : "text-burn"}>
                    {helperServer.status === "booting" ? "booting, about 2 minutes" : helperServer.status}
                  </span>
                  {helperServer.shutDownReason && <span className="text-muted">: {helperServer.shutDownReason}</span>}
                  {helperServer.url && helperServer.status !== "shut down" && (
                    <>
                      {" · "}
                      <a href={helperServer.url} target="_blank" rel="noreferrer">
                        open {helperServer.ip}
                      </a>
                    </>
                  )}
                </div>
                {helperTx?.solscan && (
                  <div>
                    Paid {helperTx.usd?.toFixed(6)} test USDC over x402 ·{" "}
                    <a href={helperTx.solscan} target="_blank" rel="noreferrer">
                      view payment on Solscan
                    </a>
                  </div>
                )}
              </div>
            ) : helperTx && helperTx.outcome !== "accepted" ? (
              <div className="text-bad">The broker said no: {plainReason(helperTx.reason ?? "")}</div>
            ) : (
              <div className="text-muted">Nothing rented yet.</div>
            )}
          </Stage>

          <Stage n={5} active={stage >= 5} title="The transaction is stored on Arweave">
            {helperTx ? (
              helperTx.arweaveUrl ? (
                <a href={helperTx.arweaveUrl} target="_blank" rel="noreferrer">
                  View this transaction&apos;s record on Arweave {helperTx.network === "production" ? "mainnet" : "testnet"}
                </a>
              ) : (
                <div className="text-muted">{helperTx.storage === "failed" ? `Could not store it: ${helperTx.storageError}` : "Storing…"}</div>
              )
            ) : (
              <div className="text-muted">Nothing stored yet.</div>
            )}
          </Stage>
        </div>

        <aside className="min-h-0 space-y-5 overflow-y-auto pr-2">
          <div>
            <h2 className="font-bold">Every transaction</h2>
            <div className="mb-2 text-muted">Accepted or refused, each one is signed by the broker and stored on Arweave.</div>
            {snap && snap.transactions.length > 0 ? (
              <div className="space-y-2">
                {[...snap.transactions].reverse().map((t, i) => (
                  <div key={i} className="border-l-2 pl-3" style={{ borderColor: t.outcome === "accepted" ? "var(--ok)" : "var(--bad)" }}>
                    <div>
                      <span className={t.outcome === "accepted" ? "text-ok" : "text-bad"}>{t.outcome}</span> ·{" "}
                      {t.subject.includes("helper") ? "helper" : t.subject.includes("stresstester") ? "stress tester" : t.subject.replace(/^ans:\/\/v[\d.]+\./, "")} · {t.plan}
                      {t.usd !== null && t.outcome === "accepted" ? ` · ${t.usd.toFixed(6)} USDC` : ""}
                      <span className="text-muted"> · {clock(t.at * 1000)}</span>
                    </div>
                    {t.reason && <div className="text-muted">{plainReason(t.reason)}</div>}
                    <div className="flex gap-3">
                      {t.solscan && (
                        <a href={t.solscan} target="_blank" rel="noreferrer">
                          Solscan
                        </a>
                      )}
                      {t.arweaveUrl ? (
                        <a href={t.arweaveUrl} target="_blank" rel="noreferrer">
                          Arweave record
                        </a>
                      ) : (
                        <span className="text-muted">{t.storage === "failed" ? "not stored" : "storing…"}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-muted">None yet.</div>
            )}
          </div>

          <div>
            <h2 className="font-bold">Wallets (Solana devnet, test USDC)</h2>
            {snap?.wallets.map((w) => (
              <div key={w.address} className="flex justify-between gap-3">
                <a href={w.explorer} target="_blank" rel="noreferrer">
                  {w.role === "you (receive)" ? "Broker's wallet" : "Agents' wallet"}
                </a>
                <span>{w.usdc === null ? "…" : `${w.usdc.toFixed(6)} USDC`}</span>
              </div>
            ))}
          </div>

          <div className="border border-rule p-3">
            <div className="flex items-center gap-3">
              <h2 className="font-bold">Stress test</h2>
              <button className="ml-auto border border-foreground px-2 disabled:opacity-40" disabled={running} onClick={() => post("/api/demo/stress")}>
                {snap?.stress.status === "running" ? "Running…" : "Run it"}
              </button>
            </div>
            <div className="text-muted">A second agent tries to break the rules. The details go to the event log.</div>
            {snap && snap.stress.attempts.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {snap.stress.attempts.map((a, i) => (
                  <div key={i}>
                    {a.what}: <span className={a.ok ? "text-ok" : "text-bad"}>{a.result}</span>
                  </div>
                ))}
                {snap.stress.verdictUrl && (
                  <a href={snap.stress.verdictUrl} target="_blank" rel="noreferrer">
                    The verdict on Arweave
                  </a>
                )}
              </div>
            )}
            {snap?.stress.error && <div className="text-bad">{snap.stress.error}</div>}
          </div>
        </aside>
      </section>

      <div
        className={`fixed right-0 top-0 z-10 flex h-full w-full max-w-[620px] flex-col border-l border-rule bg-background shadow-xl transition-transform duration-200 ${drawer ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center border-b border-rule p-3">
          <span className="font-bold">Event log</span>
          <button className="ml-auto border border-rule px-2" onClick={() => setDrawer(false)}>
            Close
          </button>
        </div>
        <div ref={logRef} className="flex-1 overflow-y-auto p-3 text-[12px]">
          {snap?.log.map((l) => (
            <div
              key={l.seq}
              className={`${l.kind === "error" || l.kind === "refused" || l.kind === "breach" ? "text-bad" : l.kind === "step" ? "mt-2 font-bold" : ""} whitespace-pre-wrap break-all`}
            >
              <span className="text-muted">{clock(l.at)} </span>
              {l.code} {l.text}
              {l.link && (
                <>
                  {"  "}
                  <a href={l.link.href} target="_blank" rel="noreferrer">
                    {l.link.label}
                  </a>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

function ModelPicker({ models, disabled, onSave }: { models: Snapshot["models"]; disabled: boolean; onSave: (provider: string, key?: string) => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const selected = models.providers.find((p) => p.id === models.selected)!;
  const open = editing === selected.id || !selected.key;

  const save = async () => {
    await onSave(selected.id, draft);
    setDraft("");
    setEditing(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {models.providers.map((p) => (
          <button
            key={p.id}
            className={`flex items-center gap-2 border px-2 py-1 ${p.id === models.selected ? "border-foreground font-bold" : "border-rule text-muted hover:border-foreground"} ${disabled ? "opacity-40" : ""}`}
            disabled={disabled || p.id === models.selected}
            onClick={() => {
              setDraft("");
              setEditing(null);
              void onSave(p.id);
            }}
          >
            <Image src={`/models/${p.id}.svg`} alt="" width={16} height={16} unoptimized />
            {p.name}
          </button>
        ))}
      </div>
      <div>
        helper, running on <b>{selected.modelName}</b> by {selected.company}
      </div>
      {open ? (
        <form
          className="flex max-w-[460px] gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void save();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            className="min-w-0 flex-1 border border-rule px-2 py-1"
            placeholder={`Paste your ${selected.name} API key`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="border border-foreground px-2 disabled:opacity-40" disabled={disabled || !draft.trim()}>
            Save
          </button>
          {selected.key && (
            <button type="button" className="text-muted underline underline-offset-2" onClick={() => setEditing(null)}>
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="text-muted">
          API key <span className="font-mono text-foreground">{selected.key}</span>{" "}
          <button className="underline underline-offset-2 disabled:opacity-40" disabled={disabled} onClick={() => setEditing(selected.id)}>
            Change
          </button>
        </div>
      )}
    </div>
  );
}

function Stage({ n, title, active, children }: { n: number; title: string; active: boolean; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${active ? "border-foreground bg-foreground text-background" : "border-rule text-muted"}`}>
        {n}
      </div>
      <div className={`min-w-0 flex-1 ${active ? "" : "text-muted"}`}>
        <div className="font-bold">{title}</div>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}

function Chain({ links }: { links: { who: string; detail: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {links.map((l, i) => (
        <div key={l.who} className="flex items-center gap-2">
          <div className="border border-foreground px-2 py-1">
            <div className="font-bold">{l.who}</div>
            <div className="text-muted">{l.detail}</div>
          </div>
          {i < links.length - 1 && <span>→</span>}
        </div>
      ))}
    </div>
  );
}

function Burn({ remaining, limit, secondsLeft }: { remaining: number; limit: number; secondsLeft: number }) {
  const pct = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0;
  return (
    <div className="mt-2">
      <div className="h-2 w-full max-w-[360px] border border-foreground">
        <div className="h-full bg-foreground transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-muted">
        {money(remaining)} of {money(limit)} left · {secondsLeft > 0 ? `the server shuts down in ${duration(secondsLeft)}` : "used up, the server was shut down"}
      </div>
    </div>
  );
}
