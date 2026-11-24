"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Nav } from "@/app/nav";
import { ActionError, failureMessage } from "@/app/components/ActionError";
import { AttemptLedger, testCopy } from "@/app/components/AttemptLedger";
import { Swatch } from "@/app/components/BudgetMeter";
import { clock, usd2, usd4 } from "@/app/components/format";
import { BTN_PRIMARY, INPUT, MONO } from "@/app/components/ui";
import type { Snapshot } from "@/lib/demo/snapshot";

function shortName(ans: string): string {
  return ans.replace(/^ans:\/\/v[\d.]+\./, "");
}

function plainReason(reason: string): string {
  if (/UNKNOWN_KEY|SIGNATURE_INVALID/.test(reason)) return "The budget was signed by a key that does not belong to the agent named on it.";
  const rate = /plan ([\d.]+)\/hr > mandate rate ([\d.]+)\/hr/.exec(reason);
  if (rate) return `The server costs ${usd4(Number(rate[1]))} an hour and the budget allows ${usd2(Number(rate[2]))}.`;
  if (/BUDGET_EXCEEDED/.test(reason)) return "The budget has no money left in it.";
  if (/WINDOW_EXPIRED/.test(reason)) return "The budget expired before this was asked for.";
  if (/SCOPE_ESCALATION/.test(reason)) return "The budget does not cover renting servers.";
  if (/IDENTITY_UNANCHORED/.test(reason)) return "The agent is not registered in ANS.";
  const rest = reason.replace(/^[A-Z_]+: /, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** "Allowed" is the one green; a refusal is the broker doing its job, so it is ink. */
function txOutcome(outcome: string): { word: string; className: string } {
  if (outcome === "accepted") return { word: "Allowed", className: "text-ok" };
  if (outcome === "failed") return { word: "Failed", className: "text-bad" };
  return { word: outcome.charAt(0).toUpperCase() + outcome.slice(1), className: "text-foreground" };
}

const H2 = "text-[16px] leading-[22px] font-semibold text-foreground";

const BUILT_IN: Record<string, string> = {
  stresstester: "built in, the second agent in the overspend test",
  helper: "built in, the second agent in the overspend test",
  broker: "built in, holds the provider key",
  auditor: "built in, signs the verdicts",
  vultr: "built in, the broker",
  ops: "built in, sample agent",
};

export default function AuditPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  // Only the 1.5s state poll writes this: the page has lost the server. A refused start lives by its button.
  const [error, setError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
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
  const attempts = stress?.attempts ?? [];
  // A broker record carries the mark of the overspend-test attempt that produced it; name that step,
  // numbered as the ledger numbers it (every row, the one that went around the broker included).
  const stepOf = (mark: number | null) => {
    if (typeof mark !== "number") return null;
    const i = attempts.findIndex((a) => a.mark === mark);
    return i >= 0 ? i + 1 : null;
  };

  // A refused start stays by the button until it is dismissed or tried again; the poll never clears it.
  const start = async () => {
    if (!target) return;
    setStartError(null);
    try {
      const res = await fetch("/api/demo/stress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: target.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server answered HTTP ${res.status}`);
      await load();
    } catch (e) {
      setStartError(failureMessage(e));
    }
  };

  return (
    // The document scrolls, as on the Run and Records pages.
    <main className="mx-auto flex w-full max-w-[1280px] flex-col px-4 py-5 sm:px-6 lg:px-10 lg:py-6">
      <Nav current="/audit" />

      <div className="shrink-0 pt-2">
        <h1 className="text-[20px] leading-[26px] font-semibold">Overspend test</h1>
        <p className="mt-3 max-w-[64ch] text-muted">
          Pick an agent that has run a job. A second agent gets part of its budget and tries every way it can to spend more than that budget allows.
          Every attempt, blocked or not, is signed and written to Arweave.
        </p>
      </div>

      {/* The connection banner: only the state poll sets it, and the next good poll clears it. */}
      {error && (
        <div role="status" className="mt-3 shrink-0 text-bad">
          The demo server couldn&apos;t report its state ({error}). Check that npm run dev is still running.
        </div>
      )}

      {runs.length === 0 ? (
        <p className="mt-6 text-foreground">
          No agent has run a job yet. <Link href="/" className="font-semibold">Run one on the Run page</Link> and it will appear here.
        </p>
      ) : (
        <section className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-14">
          <div className="min-w-0 space-y-9 lg:pr-4 lg:pb-6">
            <div className="space-y-2">
              <label htmlFor="audit-agent" className="block font-medium">
                Agent to test
              </label>
              <div className="flex items-center gap-3">
                <select
                  id="audit-agent"
                  className={`${INPUT} min-w-0 flex-1 basis-0`}
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
                {/* The only filled button on this page. Same name as on the Run page. */}
                <button className={BTN_PRIMARY} disabled={running} onClick={start}>
                  {stress?.status === "running" ? "Trying…" : "Try to overspend"}
                </button>
              </div>
              {target && (
                <div className="text-[12px] leading-4 text-muted">
                  <span className={`break-all ${MONO}`}>{target.agent.ansName}</span>, <span className="tabular-nums">{usd2(target.budgetUsd)}</span> in total,{" "}
                  <span className="tabular-nums">{usd2(target.rateUsdHr)}</span> an hour at most, expires {target.deadlineMinutes} minutes after it started
                </div>
              )}
              <ActionError what="The overspend test didn't start" message={startError} onDismiss={() => setStartError(null)} />
            </div>

            {attempts.length > 0 && stress && (
              <div className="space-y-4 border-t border-rule pt-6">
                <h2 className={H2}>
                  Overspend test against <span className="font-mono text-[12px] font-normal break-all">{stress.job ? stress.job.agent : "this agent"}</span>
                </h2>
                <AttemptLedger attempts={attempts} status={stress.status} />
                {stress.verdictUrl && (
                  <a href={stress.verdictUrl} target="_blank" rel="noreferrer" className="inline-block">
                    The auditor&apos;s verdict, stored on Arweave
                  </a>
                )}
              </div>
            )}
            {stress?.error && <div className="text-bad">{testCopy(stress.error)}</div>}

            <div className="border-t border-rule pt-6">
              <h2 className={H2}>Every request to rent a server</h2>
              <div className="mt-1 text-muted">Allowed or refused, each one signed by the broker and written to Arweave.</div>
              {snap && snap.transactions.length > 0 ? (
                <div className="mt-3">
                  {[...snap.transactions].reverse().map((t, i) => {
                    const o = txOutcome(t.outcome);
                    const step = stepOf(t.mark);
                    return (
                      // Below 640px the amount and time move under the details, so the plan and agent keep the width.
                      <div
                        key={i}
                        className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-4 gap-y-1 border-b border-rule py-3 last:border-b-0 sm:grid-cols-[72px_minmax(0,1fr)_auto] sm:gap-y-0 lg:last:border-b"
                      >
                        <div className={`font-semibold ${o.className}`}>{o.word}</div>
                        <div className="min-w-0 break-words">
                          <div className="text-foreground">{t.plan}</div>
                          <div className={`text-muted ${MONO} [overflow-wrap:anywhere]`}>{shortName(t.subject)}</div>
                          {t.reason && <div className="mt-0.5 text-muted">{plainReason(t.reason)}</div>}
                          <div className="mt-1 flex flex-wrap gap-x-4 text-[12px] leading-4">
                            {step !== null && <span className="text-muted">Overspend test, step {step}</span>}
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
                        <div className="col-start-2 flex flex-wrap items-baseline gap-x-4 sm:col-start-3 sm:block sm:text-right">
                          {t.usd !== null && t.outcome === "accepted" && (
                            <div className="flex items-center gap-x-2 whitespace-nowrap sm:justify-end">
                              <Swatch />
                              <span className="font-semibold tabular-nums">{usd4(t.usd)} USDC</span>
                            </div>
                          )}
                          <div className="text-[12px] leading-5 text-muted tabular-nums">{clock(t.at * 1000)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-3 text-muted">Nothing yet.</div>
              )}
            </div>
          </div>

          <aside className="min-w-0 space-y-8 border-t border-rule pt-8 lg:border-t-0 lg:border-l lg:pt-0 lg:pr-2 lg:pb-6 lg:pl-10">
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
                  <span className="tabular-nums">{w.usdc === null ? "…" : `${usd4(w.usdc)} USDC`}</span>
                </div>
              ))}
            </div>

            <div>
              <h2 className={H2}>Log</h2>
              {/* The log is a real log viewer, so it keeps its own scroll box. Refusals are the guard working, so only errors and breaches are red. */}
              <div ref={logRef} className="mt-2 max-h-[280px] overflow-y-auto rounded-[3px] border border-rule bg-surface p-3 text-[12px] leading-4">
                {snap?.log.map((l) => (
                  <div
                    key={l.seq}
                    className={`${l.kind === "error" || l.kind === "breach" ? "text-bad" : l.kind === "step" ? "mt-2 font-semibold" : ""} whitespace-pre-wrap break-words`}
                  >
                    <span className="text-muted tabular-nums">{clock(l.at)} </span>
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
