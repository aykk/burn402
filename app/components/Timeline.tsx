"use client";

import { useState } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { TrainingRunView } from "@/lib/demo/train";
import type { TrainedModel } from "@/lib/train";
import { Fold } from "./Fold";
import { PHASE_TEXT, REGIONS, collapseLog, duration, kb, money } from "./format";
import { StressTest } from "./StressTest";

function BurnMeter({ spent, budget }: { spent: number | null; budget: number }) {
  const used = spent === null || budget <= 0 ? 0 : Math.min(1, spent / budget);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-block h-1.5 w-24 shrink-0 border border-rule-strong align-middle">
        <span
          className="block h-full transition-all"
          style={{ width: `${Math.max(used > 0 ? 3 : 0, Math.round(used * 100))}%`, background: "var(--amber)" }}
        />
      </span>
      <span className="text-muted">
        {money(spent ?? 0)} of {money(budget)} spent
      </span>
    </span>
  );
}

export function Timeline({
  job,
  model,
  snap,
  post,
}: {
  job: TrainingRunView;
  model: TrainedModel | null;
  snap: Snapshot | null;
  post: (path: string, body?: unknown) => Promise<void>;
}) {
  const status = job.status;
  const progress = status?.progress ?? 0;
  const elapsed = status?.elapsed ?? null;
  const settled = job.phase === "done" || job.phase === "failed";
  const [openTalk, setOpenTalk] = useState(false);
  const [openPlans, setOpenPlans] = useState(false);
  const live = job.handle !== null && !settled;
  const lastDesk = [...job.messages].reverse().find((m) => m.fromLabel === "vultr") ?? null;
  const talk = settled ? openTalk : true;
  const plans = settled ? openPlans : job.plan === null;
  const near = job.quotes
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.plan !== (job.plan ?? job.chosen?.plan))
    .slice(0, 2)
    .map(({ q }) => q);
  const marked = job.plan ?? job.chosen?.plan ?? null;
  const shownQuotes = plans ? job.quotes : job.quotes.filter((q) => q.plan === marked || near.includes(q));
  return (
    <div className="space-y-9 border-t border-rule pt-8">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h2 className="text-[15px] font-bold">{PHASE_TEXT[job.phase]}</h2>
        <span className="text-muted">
          <span className="font-mono">{job.agent.ansName}</span>, running on {job.model.name}, mandate <span className="font-mono">{job.mandateJti}</span>, {money(job.rateUsdHr)}/hour cap, expires in {job.deadlineMinutes} min
        </span>
        <span className="ml-auto">
          <BurnMeter spent={job.paidUsd} budget={job.budgetUsd} />
        </span>
      </div>
      {job.error && <div className="text-bad">{job.error}</div>}
      <div className="text-muted">
        what you asked for: <span className="text-foreground">{job.request}</span>
      </div>

      {job.messages.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-4">
            <span className="text-muted">Agents have signed both ways, ANS keys verified.</span>
            {settled && (
              <span className="ml-auto">
                <Fold label={`read the full exchange (${job.messages.length} messages)`} open={openTalk} onToggle={() => setOpenTalk(!openTalk)} />
              </span>
            )}
          </div>
          {!talk && lastDesk && (
            <div className="border-l-2 border-rule pl-3 text-muted">
              <div>
                broker, {lastDesk.kind.replace(/_/g, " ")}, sig <span className="font-mono">{lastDesk.signed}…</span>{" "}
                <span className="text-ok">verified</span>
              </div>
              <div className="whitespace-pre-wrap">{lastDesk.text}</div>
            </div>
          )}
          {talk &&
            job.messages.map((m) => (
              <div key={m.seq} className={`flex ${m.fromLabel === "company" ? "justify-start" : "justify-end"}`}>
                <div className={`max-w-[80%] border-l-2 pl-3 ${m.fromLabel === "company" ? "border-foreground text-foreground" : "border-rule text-muted"}`}>
                  <div className="text-muted">
                    {m.fromLabel === "company" ? "your agent" : "broker"}, {m.kind.replace(/_/g, " ")}, sig <span className="font-mono">{m.signed}…</span>{" "}
                    {m.verified ? <span className="text-ok">verified</span> : <span className="text-bad">unverified</span>}
                  </div>
                  <div className="whitespace-pre-wrap">{m.text}</div>
                </div>
              </div>
            ))}
          {job.conversation?.url && (
            <div className="text-muted">
              <a href={job.conversation.url} target="_blank" rel="noreferrer">
                this exchange on Arweave
              </a>
              {job.conversation.withheld > 0 && `, ${job.conversation.withheld} of ${job.conversation.messages} stored as hash`}
            </div>
          )}
        </div>
      )}

      {job.quotes.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-4">
            <span className="text-muted">Recommended plans with budget of {money(job.budgetUsd)}:</span>
            {job.quotes.length > shownQuotes.length || plans ? (
              <span className="ml-auto">
                <Fold
                  label={plans ? `${job.quotes.length} plans the broker quoted` : `all ${job.quotes.length} plans the broker quoted`}
                  open={plans}
                  onToggle={() => setOpenPlans(!openPlans)}
                />
              </span>
            ) : null}
          </div>
          <table className="w-full border-collapse">
            <thead className="text-muted">
              <tr className="border-b border-rule-strong text-left">
                <th className="py-2 pr-4 font-normal">plan</th>
                <th className="py-2 pr-4 font-normal">cores</th>
                <th className="py-2 pr-4 font-normal">RAM</th>
                <th className="py-2 pr-4 text-right font-normal">$/hour</th>
                <th className="py-2 pr-4 text-right font-normal">model ready in</th>
                <th className="py-2 pr-4 text-right font-normal">cost of this run</th>
                <th className="py-2 text-right font-normal">hours your budget covers</th>
              </tr>
            </thead>
            <tbody>
              {shownQuotes.map((q) => {
                const chosen = q.plan === marked;
                return (
                  <tr key={q.plan} className={`border-b border-rule ${chosen ? "font-bold" : q.enoughRam && q.withinDeadline ? "" : "text-muted"}`}>
                    <td className="py-1.5 pr-4">
                      {chosen ? <span className="font-normal text-muted">chosen </span> : ""}
                      {q.plan}
                    </td>
                    <td className="py-1.5 pr-4">
                      {q.vcpus} {q.familyLabel}
                    </td>
                    <td className="py-1.5 pr-4">
                      {q.ramGb} GB{q.enoughRam ? "" : " (too small)"}
                    </td>
                    <td className="py-1.5 pr-4 text-right">{q.hourlyUsd.toFixed(4)}</td>
                    <td className="py-1.5 pr-4 text-right">
                      {duration(q.totalSeconds)}
                      {q.withinDeadline ? "" : " (over the limit)"}
                    </td>
                    <td className="py-1.5 pr-4 text-right">{q.jobUsd.toFixed(4)}</td>
                    <td className="py-1.5 text-right">{q.budgetHours} h</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {job.plan && job.chosen && job.plan !== job.chosen.plan ? (
            <div>
              {job.chosen.plan} is what the broker recommended; your agent rented {job.plan}
            </div>
          ) : (
            job.chosenReason && <div>{job.chosenReason}</div>
          )}
        </div>
      )}

      {job.plan && (
        <div className="space-y-1 border-l-2 pl-3" style={{ borderColor: live ? "var(--foreground)" : "var(--rule)" }}>
          <div className="text-muted">Rented and paid</div>
          <div>
            <b>{job.plan}</b> in {REGIONS[job.region] ?? job.region},{" "}
            <span className="text-ok">{job.paidUsd !== null ? `${money(job.paidUsd)} USDC settled` : "paid over x402"}</span>
            {job.boxUrl && job.phase !== "done" && (
              <>
                {", "}
                <a href={job.boxUrl} target="_blank" rel="noreferrer">
                  open the box {job.ip}
                </a>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-4">
            {job.solscan && (
              <a href={job.solscan} target="_blank" rel="noreferrer">
                the payment on Solscan
              </a>
            )}
            {job.arweaveUrl && (
              <a href={job.arweaveUrl} target="_blank" rel="noreferrer">
                the receipt on Arweave
              </a>
            )}
          </div>
        </div>
      )}

      {(job.phase === "booting" || job.phase === "training" || job.phase === "publishing" || job.phase === "done") && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-4">
            <span className="text-muted">Training</span>
            <span>
              predicted {duration(job.predictedSeconds)}
              {job.actualSeconds !== null
                ? `, took ${duration(job.actualSeconds)}`
                : elapsed !== null
                  ? `, ${duration(Math.round(elapsed))} on the box so far`
                  : ""}
            </span>
            {status?.vcpus ? <span className="text-muted">{status.vcpus} workers</span> : null}
          </div>
          <div className="h-2 w-full max-w-[520px] border border-foreground">
            <div
              className="h-full transition-all"
              style={{
                width: `${Math.round(progress * 100)}%`,
                background: job.phase === "done" ? "var(--ok)" : "var(--foreground)",
              }}
            />
          </div>
          <div className="space-y-0.5 text-muted">
            {collapseLog(status?.log ?? [])
              .slice(-4)
              .map((l, i) => (
                <div key={i}>
                  {l.at.toFixed(1)}s {l.text}
                </div>
              ))}
            {job.phase === "booting" && !status && <div>waiting for the box to answer, usually under two minutes</div>}
          </div>
        </div>
      )}

      {job.phase === "done" && <StressTest snap={snap} post={post} />}

      {job.phase === "done" && model && (
        <div className="text-ok">The model is {kb(job.modelBytes)} and the server was shut down. It is on the right, running in your browser.</div>
      )}
    </div>
  );
}
