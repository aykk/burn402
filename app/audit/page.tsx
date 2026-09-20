"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Nav } from "@/app/nav";
import type { Snapshot } from "@/lib/demo/snapshot";

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function money(n: number | null): string {
  if (n === null) return "-";
  return n >= 1 ? `$${n.toFixed(2)}` : `$${parseFloat(n.toFixed(6))}`;
}

function shortName(ans: string): string {
  return ans.replace(/^ans:\/\/v[\d.]+\./, "");
}

function plainReason(reason: string): string {
  if (/UNKNOWN_KEY|SIGNATURE_INVALID/.test(reason)) return "the budget was signed by a key that does not belong to the agent named on it";
  const rate = /plan ([\d.]+)\/hr > mandate rate ([\d.]+)\/hr/.exec(reason);
  if (rate) return `the server costs $${rate[1]} an hour and the budget allows $${rate[2]}`;
  if (/BUDGET_EXCEEDED/.test(reason)) return "the budget has no money left in it";
  if (/WINDOW_EXPIRED/.test(reason)) return "the budget expired before this was asked for";
  if (/SCOPE_ESCALATION/.test(reason)) return "the budget does not cover renting servers";
  if (/IDENTITY_UNANCHORED/.test(reason)) return "the agent is not registered in ANS";
  return reason.replace(/^[A-Z_]+: /, "");
}

function toneOf(a: { ok: boolean; blocked: boolean | null }): string {
  if (a.blocked === null) return a.ok ? "var(--ok)" : "var(--bad)";
  return a.blocked ? "var(--bad)" : "var(--ok)";
}

const BUILT_IN: Record<string, string> = {
  stresstester: "built in, limit tester",
  helper: "built in, limit tester",
  broker: "built in, holds the provider key",
  auditor: "built in, signs the verdicts",
  vultr: "built in, the Vultr desk",
  ops: "built in, sample agent",
};

export default function AuditPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>("");
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
    const poll = setInterval(load, 1500);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [load]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [snap?.log.length]);

  const runs = snap?.runs ?? [];
  const target = runs.find((r) => r.id === picked) ?? runs[0] ?? null;
  const stress = snap?.stress;
  const running = snap?.busy ?? false;

  const start = async () => {
    if (!target) return;
    try {
      const res = await fetch("/api/demo/stress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: target.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <main className="mx-auto flex h-screen w-full max-w-[1280px] flex-col overflow-hidden px-10 py-6">
      <Nav current="/audit" />

      <p className="mt-4 max-w-[80ch] shrink-0">
        Pick an agent that has run a job. A second agent is handed part of its budget and tries to spend more than that budget allows. Every attempt,
        refused or not, is signed and written to Arweave.
      </p>

      {error && <div className="mt-3 text-bad">{error}</div>}

      {runs.length === 0 ? (
        <div className="mt-8 rounded-lg border border-rule bg-surface p-5 text-muted">
          No agent has run a job yet. <Link href="/">Run one on the front page</Link> and it will appear here.
        </div>
      ) : (
        <section className="mt-6 grid min-h-0 flex-1 gap-14 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="min-h-0 space-y-9 overflow-y-auto pb-6 pr-4">
            <div className="space-y-3">
              <div className="text-muted">Agent to test</div>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  className="min-w-0 flex-1 border border-rule px-2.5 py-1.5"
                  value={target?.id ?? ""}
                  disabled={running}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {shortName(r.agent.ansName)} — {r.request.slice(0, 48)}
                    </option>
                  ))}
                </select>
                <button className="border border-charcoal bg-charcoal px-3.5 py-1.5 text-background hover:opacity-85 disabled:opacity-40" disabled={running} onClick={start}>
                  {stress?.status === "running" ? "Running…" : "Limit test"}
                </button>
              </div>
              {target && (
                <div className="text-muted">
                  {target.agent.ansName} · {money(target.budgetUsd)} in total · {money(target.rateUsdHr)} an hour at most · expires{" "}
                  {target.deadlineMinutes} minutes after it started
                </div>
              )}
            </div>

            {stress && stress.attempts.length > 0 && (
              <div className="space-y-3">
                <h2 className="font-bold">
                  Limit test for: <span className="break-all font-normal">{stress.job ? stress.job.agent : "this agent"}</span>
                </h2>
                {stress.attempts
                  .filter((a) => !a.quiet)
                  .map((a, i) => (
                    <div key={i} className="border-l-2 pl-3" style={{ borderColor: toneOf(a) }}>
                      <div>
                        {a.mark !== null && <span className="text-muted">[{a.mark}] </span>}
                        {a.what}
                      </div>
                      <div style={{ color: toneOf(a) }}>{a.result}</div>
                      <div className="text-muted">{a.proves}</div>
                    </div>
                  ))}
                {stress.verdictUrl && (
                  <a href={stress.verdictUrl} target="_blank" rel="noreferrer">
                    the verdict against it, permanently on Arweave
                  </a>
                )}
              </div>
            )}
            {stress?.error && <div className="text-bad">{stress.error}</div>}

            <div>
              <h2 className="font-bold">Every request to rent a server</h2>
              <div className="mb-2 text-muted">Allowed or refused, each one signed by the broker and written to Arweave.</div>
              {snap && snap.transactions.length > 0 ? (
                <div className="space-y-2">
                  {[...snap.transactions].reverse().map((t, i) => (
                    <div key={i} className="border-l-2 pl-3" style={{ borderColor: t.outcome === "accepted" ? "var(--ok)" : "var(--bad)" }}>
                      <div>
                        {t.mark !== null && <span className="text-muted">[{t.mark}] </span>}
                        <span className={t.outcome === "accepted" ? "text-ok" : "text-bad"}>{t.outcome === "accepted" ? "allowed" : t.outcome}</span> ·{" "}
                        {shortName(t.subject)} · {t.plan}
                        {t.usd !== null && t.outcome === "accepted" ? ` · ${t.usd.toFixed(6)} USDC` : ""}
                        <span className="text-muted"> · {clock(t.at * 1000)}</span>
                      </div>
                      {t.reason && <div className="text-muted">{plainReason(t.reason)}</div>}
                      <div className="flex gap-3">
                        {t.solscan && (
                          <a href={t.solscan} target="_blank" rel="noreferrer">
                            the payment on Solscan
                          </a>
                        )}
                        {t.arweaveUrl ? (
                          <a href={t.arweaveUrl} target="_blank" rel="noreferrer">
                            the record on Arweave
                          </a>
                        ) : (
                          <span className="text-muted">{t.storage === "failed" ? "not stored" : "storing…"}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-muted">Nothing yet.</div>
              )}
            </div>
          </div>

          <aside className="min-h-0 space-y-8 overflow-y-auto pb-6 pr-2">
            <div>
              <h2 className="font-bold">Registered agents</h2>
              <div className="mb-2 text-muted">Each name resolves to keys sealed in the transparency log. A signature that does not match is refused.</div>
              <div className="space-y-0.5">
                {(snap?.agents ?? []).map((name) => {
                  const role = BUILT_IN[/^ans:\/\/v[\d.]+\.([^.]+)\./.exec(name)?.[1] ?? ""];
                  return (
                    <div key={name} className="break-all">
                      {name}
                      {role && <span className="text-muted"> · {role}</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h2 className="font-bold">Wallets</h2>
              <div className="mb-2 text-muted">Solana devnet, test USDC.</div>
              {snap?.wallets.map((w) => (
                <div key={w.address} className="flex justify-between gap-3">
                  <a href={w.explorer} target="_blank" rel="noreferrer">
                    {w.role === "you (receive)" ? "the broker's wallet" : "the agents' wallet"}
                  </a>
                  <span>{w.usdc === null ? "…" : `${w.usdc.toFixed(6)} USDC`}</span>
                </div>
              ))}
            </div>

            <div>
              <h2 className="font-bold">Log</h2>
              <div ref={logRef} className="mt-2 max-h-[280px] overflow-y-auto rounded-lg border border-rule bg-surface p-3 text-[12px]">
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
          </aside>
        </section>
      )}
    </main>
  );
}
