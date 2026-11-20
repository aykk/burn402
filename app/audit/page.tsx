"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Nav } from "@/app/nav";
import { BTN_PRIMARY, INPUT, MONO } from "@/app/components/ui";
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

const H2 = "text-[16px] leading-[22px] font-semibold text-foreground";

const BUILT_IN: Record<string, string> = {
  stresstester: "built in, limit tester",
  helper: "built in, limit tester",
  broker: "built in, holds the provider key",
  auditor: "built in, signs the verdicts",
  vultr: "built in, the broker",
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
    <main className="mx-auto flex w-full max-w-[1280px] flex-col px-4 py-5 sm:px-6 lg:h-screen lg:overflow-hidden lg:px-10 lg:py-6">
      <Nav current="/audit" />

      <div className="shrink-0 pt-2">
        <h1 className="text-[20px] leading-[26px] font-semibold">Try to overspend an agent&apos;s budget</h1>
        <p className="mt-3 max-w-[64ch] text-muted">
          Pick an agent that has run a job. A second agent is handed part of its budget and tries to spend more than that budget allows. Every attempt,
          refused or not, is signed and written to Arweave.
        </p>
      </div>

      {error && <div className="mt-3 shrink-0 text-bad">{error}</div>}

      {runs.length === 0 ? (
        <p className="mt-6 text-foreground">
          No agent has run a job yet. <Link href="/" className="font-semibold">Run one on the Run page</Link> and it will appear here.
        </p>
      ) : (
        <section className="mt-6 grid gap-10 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-14">
          <div className="space-y-9 lg:min-h-0 lg:overflow-y-auto lg:pr-4 lg:pb-6">
            <div className="space-y-2">
              <label htmlFor="audit-agent" className="block font-medium">
                Agent to test
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  id="audit-agent"
                  className={`${INPUT} flex-1`}
                  value={target?.id ?? ""}
                  disabled={running}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {shortName(r.agent.ansName)}, {r.request.slice(0, 48)}
                    </option>
                  ))}
                </select>
                <button
                  className={BTN_PRIMARY}
                  disabled={running}
                  onClick={start}
                >
                  {stress?.status === "running" ? "Running…" : "Limit test"}
                </button>
              </div>
              {target && (
                <div className="text-[12px] leading-4 text-muted">
                  <span className={`break-all ${MONO}`}>{target.agent.ansName}</span>, <span className="tabular-nums">{money(target.budgetUsd)}</span> in total,{" "}
                  <span className="tabular-nums">{money(target.rateUsdHr)}</span> an hour at most, expires {target.deadlineMinutes} minutes after it started
                </div>
              )}
            </div>

            {stress && stress.attempts.length > 0 && (
              <div className="space-y-3 border-t border-rule pt-6">
                <h2 className={H2}>
                  Limit test for <span className="font-mono text-[12px] font-normal break-all">{stress.job ? stress.job.agent : "this agent"}</span>
                </h2>
                {stress.attempts
                  .filter((a) => !a.quiet)
                  .map((a, i) => (
                    <div key={i} className="border-l-2 pl-3" style={{ borderColor: toneOf(a) }}>
                      <div>
                        {typeof a.mark === "number" && <span className="text-muted">[{a.mark}] </span>}
                        {a.what}
                      </div>
                      <div style={{ color: toneOf(a) }}>{a.result}</div>
                      <div className="text-muted">{a.proves}</div>
                    </div>
                  ))}
                {stress.verdictUrl && (
                  <a href={stress.verdictUrl} target="_blank" rel="noreferrer">
                    The verdict against it, permanently on Arweave
                  </a>
                )}
              </div>
            )}
            {stress?.error && <div className="text-bad">{stress.error}</div>}

            <div className="border-t border-rule pt-6">
              <h2 className={H2}>Every request to rent a server</h2>
              <div className="mb-3 text-muted">Allowed or refused, each one signed by the broker and written to Arweave.</div>
              {snap && snap.transactions.length > 0 ? (
                <div className="space-y-3">
                  {[...snap.transactions].reverse().map((t, i) => (
                    <div key={i} className="border-l-2 pl-3" style={{ borderColor: t.outcome === "accepted" ? "var(--ok)" : "var(--bad)" }}>
                      <div className="flex flex-wrap items-baseline gap-x-3">
                        {typeof t.mark === "number" && <span className="text-muted">[{t.mark}]</span>}
                        <span className={t.outcome === "accepted" ? "text-ok" : "text-bad"}>{t.outcome === "accepted" ? "Allowed" : t.outcome.charAt(0).toUpperCase() + t.outcome.slice(1)}</span>
                        <span className={MONO}>{shortName(t.subject)}</span>
                        <span>{t.plan}</span>
                        {t.usd !== null && t.outcome === "accepted" && <span className="tabular-nums">{t.usd.toFixed(6)} USDC</span>}
                        <span className="text-[12px] text-muted tabular-nums">{clock(t.at * 1000)}</span>
                      </div>
                      {t.reason && <div className="text-muted">{plainReason(t.reason)}</div>}
                      <div className="flex flex-wrap gap-x-4 text-[12px] leading-4">
                        {t.solscan && (
                          <a href={t.solscan} target="_blank" rel="noreferrer">
                            Payment on Solscan
                          </a>
                        )}
                        {t.arweaveUrl ? (
                          <a href={t.arweaveUrl} target="_blank" rel="noreferrer">
                            Record on Arweave
                          </a>
                        ) : (
                          <span className="text-muted">{t.storage === "failed" ? "Not stored" : "Storing…"}</span>
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

          <aside className="space-y-8 border-t border-rule pt-8 lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:pt-0 lg:pr-2 lg:pb-6 lg:pl-10">
            <div>
              <h2 className={H2}>Registered agents</h2>
              <div className="mb-3 text-muted">Each name resolves to keys sealed in the transparency log. A signature that does not match is refused.</div>
              <div className="space-y-1">
                {(snap?.agents ?? []).map((name) => {
                  const role = BUILT_IN[/^ans:\/\/v[\d.]+\.([^.]+)\./.exec(name)?.[1] ?? ""];
                  return (
                    <div key={name}>
                      <span className={`break-all ${MONO}`}>{name}</span>
                      {role && <span className="text-muted">, {role}</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h2 className={H2}>Wallets</h2>
              <div className="mb-3 text-muted">Solana devnet, test USDC.</div>
              {snap?.wallets.map((w) => (
                <div key={w.address} className="flex justify-between gap-3 border-b border-rule py-1.5">
                  <a href={w.explorer} target="_blank" rel="noreferrer">
                    {w.role === "you (receive)" ? "Broker's wallet" : "Agents' wallet"}
                  </a>
                  <span className="tabular-nums">{w.usdc === null ? "…" : `${w.usdc.toFixed(6)} USDC`}</span>
                </div>
              ))}
            </div>

            <div>
              <h2 className={H2}>Log</h2>
              <div ref={logRef} className="mt-2 max-h-[280px] overflow-y-auto rounded-[3px] border border-rule bg-surface p-3 text-[12px] leading-4">
                {snap?.log.map((l) => (
                  <div
                    key={l.seq}
                    className={`${l.kind === "error" || l.kind === "refused" || l.kind === "breach" ? "text-bad" : l.kind === "step" ? "mt-2 font-semibold" : ""} whitespace-pre-wrap break-all`}
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
