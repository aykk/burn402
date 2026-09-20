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



const TONE: { [K in Outcome["tone"]]: string } = { good: "var(--ok)", bad: "var(--bad)", warn: "var(--warn)" };

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

  return (
    <main className="mx-auto flex h-screen w-full max-w-[1280px] flex-col overflow-hidden px-10 py-6">
      <Nav current="/records">
        <span className="flex items-center gap-2">
          <span className="text-muted">Arweave</span>
          {(["testnet", "production"] as const).map((n) => (
            <button
              key={n}
              className={`border px-3 py-1 ${network === n ? "border-charcoal bg-charcoal text-background" : "border-rule-strong text-muted hover:border-charcoal"}`}
              onClick={() => setNetwork(n)}
            >
              {n === "production" ? "mainnet" : "testnet"}
            </button>
          ))}
        </span>
      </Nav>

      <p className="mt-4 max-w-[80ch] shrink-0">
        All records (successful handshakes, transactions, failures) are written to Arweave. You can toggle between
        Testnet and Mainnet (Mainnet is truly permanent and public). Refresh page to reload.
      </p>

      <div className="mt-4 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-rule pb-4">
        <span className="flex items-center gap-2">
          {(
            [
              ["all", "everything"],
              ["good", "allowed"],
              ["warn", "refused"],
              ["bad", "broken rules"],
              ["negotiation", "negotiations"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`border px-3 py-1 ${outcome === key ? "border-charcoal bg-charcoal text-background" : "border-rule-strong text-muted hover:border-charcoal"}`}
              onClick={() => setOutcome(key)}
            >
              {label}
            </button>
          ))}
        </span>
        <select className="min-w-0 border border-rule px-2.5 py-1.5" value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">every agent</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a.replace(/^ans:\/\/v[\d.]+\./, "")}
            </option>
          ))}
        </select>
        <input
          className="min-w-0 flex-1 border border-rule px-2.5 py-1.5"
          placeholder="search"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
        />
      </div>

      {loading && <div className="mt-4 shrink-0 text-muted">Reading from Arweave and checking each record…</div>}
      {data?.error && <div className="mt-4 shrink-0 text-bad">{data.error}</div>}
      {data?.records && !loading && (
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
          <div className="shrink-0">
            {shown.length === records.length
              ? `${records.length} record${records.length === 1 ? "" : "s"}`
              : `${shown.length} of ${records.length} records`}{" "}
            on Arweave {data.network === "production" ? "mainnet" : "testnet"}. <span className="text-muted">Gateway: {data.gatewayUrl}</span>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-4 pr-3">
          {shown.length === 0 && <div className="text-muted">Nothing matches those filters.</div>}
          {shown.map((r) => (
            <div
              key={r.id}
              className="space-y-1.5 rounded-lg border border-rule p-4"
              style={{ borderLeftWidth: "2px", borderLeftColor: data.network === "production" ? "var(--mark)" : "var(--rule-strong)" }}
            >
              <div className="flex flex-wrap items-baseline gap-x-4">
                <span className="text-muted">{r.kind}</span>
                <span>{r.headline}</span>
                <span className="text-muted">{when(r.issuedAt) ?? when(r.anchoredAt) ?? "date not on record"}</span>
                <span className="text-muted">{(r.subject ?? "").replace(/^ans:\/\/v[\d.]+\./, "")}</span>
                <span className="ml-auto flex items-baseline gap-3">
                  <span className="font-bold" style={{ color: TONE[r.outcome.tone] }}>
                    {r.outcome.tone === "good" ? "✓" : r.outcome.tone === "bad" ? "✗" : "!"} {r.outcome.label}
                  </span>
                  <span className={r.verified ? "text-muted" : "text-bad"}>{r.verified ? "signature verified" : "signature not verified"}</span>
                </span>
              </div>
              {r.reason && <div className="text-muted">{r.reason}</div>}
              <div className="break-all">
                <a href={r.rawUrl} target="_blank" rel="noreferrer">
                  raw record {r.id}
                </a>
                {r.explorerUrl && (
                  <>
                    {" · "}
                    <a href={r.explorerUrl} target="_blank" rel="noreferrer">
                      explorer
                    </a>
                  </>
                )}
              </div>
              <details>
                <summary className="cursor-pointer text-muted">What was checked</summary>
                {r.steps.map((s) => (
                  <div key={s.name} className={s.ok ? "text-ok" : "text-bad"}>
                    {s.ok ? "✓" : "✗"} {s.name}: <span className="text-muted break-all">{s.detail}</span>
                  </div>
                ))}
                <div className="text-muted mt-1">Run it yourself: npm run burn402 -- verify {r.id}{data.network === "production" ? " --network production" : ""}</div>
              </details>
            </div>
          ))}
          </div>
        </div>
      )}
    </main>
  );
}
