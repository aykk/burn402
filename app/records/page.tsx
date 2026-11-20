"use client";

import { Nav } from "@/app/nav";
import { useEffect, useState } from "react";

type Step = { name: string; ok: boolean; detail: string };
type Outcome = { label: string; tone: "good" | "bad" | "warn" };

type Record = {
  id: string;
  schema: string;
  kind: "verdict" | "transaction" | "conversation";
  headline: string;
  rawUrl: string;
  explorerUrl: string | null;
  issuedAt: number | null;
  anchoredAt: number | null;
  subject: string | null;
  reason: string | null;
  outcome: Outcome;
  verified: boolean;
  steps: Step[];
};
type Response = { network: string; fqdn: string | null; gatewayUrl?: string; records?: Record[]; error?: string };

const TONE: { [K in Outcome["tone"]]: string } = { good: "var(--ok)", bad: "var(--bad)", warn: "var(--muted)" };

const KIND: { [K in Record["kind"]]: string } = { verdict: "Verdict", transaction: "Transaction", conversation: "Negotiation" };

const TOGGLE = "rounded-[3px] border px-3 py-1";
const TOGGLE_ON = "border-foreground bg-foreground text-surface";
const TOGGLE_OFF = "border-rule-strong text-muted hover:border-foreground hover:text-foreground";
const FIELD = "min-w-0 rounded-[3px] border border-rule bg-surface px-2.5 py-1.5";

function when(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const at = new Date(seconds * 1000);
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 19)} UTC`;
}

export default function RecordsPage() {
  const [network, setNetwork] = useState<"testnet" | "production">("production");
  const [outcome, setOutcome] = useState<"all" | "good" | "warn" | "bad" | "negotiation">("all");
  const [agent, setAgent] = useState("");
  const [needle, setNeedle] = useState("");
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const n = new URLSearchParams(window.location.search).get("network");
    if (n === "testnet") setTimeout(() => setNetwork("testnet"), 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/records?network=${network}`, { cache: "no-store" });
        const body = (await res.json()) as Response;
        if (!cancelled) setData(body);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const t = setTimeout(run, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [network]);

  const records = data?.records ?? [];
  const agents = [...new Set(records.map((r) => r.subject ?? "").filter(Boolean))].sort();
  const shown = records.filter(
    (r) =>
      (outcome === "all" || (outcome === "negotiation" ? r.kind === "conversation" : r.outcome.tone === outcome && r.kind !== "conversation")) &&
      (agent === "" || r.subject === agent) &&
      (needle === "" ||
        `${r.headline} ${r.outcome.label} ${r.reason ?? ""} ${r.subject ?? ""} ${r.kind} ${r.id} ${when(r.issuedAt) ?? ""}`.toLowerCase().includes(needle.toLowerCase())),
  );
  const mainnet = data?.network === "production";

  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-col px-4 py-5 sm:px-6 lg:h-screen lg:overflow-hidden lg:px-10 lg:py-6">
      <Nav current="/records">
        <span className="flex items-center gap-2">
          <span className="text-muted">Arweave</span>
          {(["testnet", "production"] as const).map((n) => {
            const on = network === n;
            // Mainnet is permanent, so it is marked with the bad red outline rather than the ink fill.
            const style = n === "production" ? (on ? "border-bad bg-surface font-medium text-bad" : "border-rule-strong text-muted hover:border-bad hover:text-bad") : on ? TOGGLE_ON : TOGGLE_OFF;
            return (
              <button key={n} aria-pressed={on} className={`${TOGGLE} ${style}`} onClick={() => setNetwork(n)}>
                {n === "production" ? "Mainnet" : "Testnet"}
              </button>
            );
          })}
        </span>
      </Nav>

      <p className="max-w-[72ch] shrink-0 text-muted">
        Every handshake, transaction and failure is written to Arweave. Testnet is for trying things out; mainnet is permanent and public.
        Reload the page to read them again.
      </p>

      <div className="mt-5 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-3 border-b border-rule pb-4">
        <span className="flex flex-wrap items-center gap-2">
          {(
            [
              ["all", "Everything"],
              ["good", "Allowed"],
              ["warn", "Refused"],
              ["bad", "Broken rules"],
              ["negotiation", "Negotiations"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} aria-pressed={outcome === key} className={`${TOGGLE} ${outcome === key ? TOGGLE_ON : TOGGLE_OFF}`} onClick={() => setOutcome(key)}>
              {label}
            </button>
          ))}
        </span>
        <select aria-label="Agent" className={FIELD} value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">Every agent</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a.replace(/^ans:\/\/v[\d.]+\./, "")}
            </option>
          ))}
        </select>
        <input type="text" aria-label="Search records" className={`${FIELD} flex-1`} placeholder="Search" value={needle} onChange={(e) => setNeedle(e.target.value)} />
      </div>

      {loading && <div className="mt-4 shrink-0 text-muted">Reading from Arweave and checking each record…</div>}
      {data?.error && <div className="mt-4 shrink-0 text-bad">{data.error}</div>}
      {data?.records && !loading && (
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-medium">
              {shown.length === records.length
                ? `${records.length} record${records.length === 1 ? "" : "s"}`
                : `${shown.length} of ${records.length} records`}{" "}
              on Arweave <span className={mainnet ? "text-bad" : ""}>{mainnet ? "mainnet" : "testnet"}</span>
            </span>
            <span className="text-muted">
              Gateway <span className="font-mono text-[12.5px]">{data.gatewayUrl}</span>
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-3 pb-4">
            {shown.length === 0 && <div className="pt-3 text-muted">Nothing matches those filters.</div>}
            {shown.map((r) => (
              <article key={r.id} className="space-y-1.5 border-b border-rule py-4">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-muted">{KIND[r.kind] ?? r.kind}</span>
                  <span className="font-medium">{r.headline}</span>
                  <span className="text-muted">{when(r.issuedAt) ?? when(r.anchoredAt) ?? "date not on record"}</span>
                  {r.subject && <span className="font-mono text-[12.5px] text-muted">{r.subject.replace(/^ans:\/\/v[\d.]+\./, "")}</span>}
                  <span className="flex items-baseline gap-4 sm:ml-auto">
                    <span className="font-semibold" style={{ color: TONE[r.outcome.tone] }}>
                      {r.outcome.tone === "good" ? "✓" : r.outcome.tone === "bad" ? "✗" : "!"} {r.outcome.label}
                    </span>
                    <span className={r.verified ? "text-muted" : "text-bad"}>{r.verified ? "signature verified" : "signature not verified"}</span>
                  </span>
                </div>
                {r.reason && <div className="text-muted">{r.reason}</div>}
                <div className="flex flex-wrap gap-x-4 break-all">
                  <a href={r.rawUrl} target="_blank" rel="noreferrer">
                    raw record <span className="font-mono text-[12.5px]">{r.id}</span>
                  </a>
                  {r.explorerUrl && (
                    <a href={r.explorerUrl} target="_blank" rel="noreferrer">
                      explorer
                    </a>
                  )}
                </div>
                <details>
                  <summary className="cursor-pointer text-muted hover:text-foreground">What was checked</summary>
                  <div className="mt-1.5 space-y-0.5 border-l-2 border-rule pl-3">
                    {r.steps.map((s) => (
                      <div key={s.name} className={s.ok ? "text-ok" : "text-bad"}>
                        {s.ok ? "✓" : "✗"} {s.name}: <span className="break-all text-muted">{s.detail}</span>
                      </div>
                    ))}
                    <div className="mt-1 text-muted">
                      Run it yourself:{" "}
                      <span className="font-mono text-[12.5px] text-foreground">
                        npm run burn402 -- verify {r.id}
                        {data.network === "production" ? " --network production" : ""}
                      </span>
                    </div>
                  </div>
                </details>
              </article>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
