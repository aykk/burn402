"use client";

import { useMemo, useState } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { TrainingRunView } from "@/lib/demo/train";
import type { TrainedModel } from "@/lib/train";
import { formatMetric, headlineMetric, run as runModel, runnerFor } from "@/lib/train/infer";
import { MetricList } from "./MetricList";
import { kb, usd4 } from "./format";
import { BTN, INPUT, TEXT_BTN, TEXTAREA } from "./ui";

/** `bare` drops the top rule when the panel sits directly under the result heading. */
export function TryIt({
  title,
  job,
  model,
  models,
  bare = false,
}: {
  title: string;
  job: TrainingRunView;
  model: TrainedModel;
  models: Snapshot["models"] | undefined;
  bare?: boolean;
}) {
  const [input, setInput] = useState("");
  const [controls, setControls] = useState<Record<string, number>>(() =>
    Object.fromEntries((model.interface.output.controls ?? []).map((c) => [c.key, c.value])),
  );
  const [produced, setProduced] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [answer, setAnswer] = useState<{
    answer: string;
    model: { name: string; company: string };
    cited: { n: number; title: string; url: string }[];
  } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [answerWith, setAnswerWith] = useState<string>("");
  const runner = runnerFor(model);
  const headline = headlineMetric(model);
  const live = model.interface.output.type === "labels" || model.interface.output.type === "passages";
  const result = useMemo(() => (live && runner && input.trim() ? runModel(model, input, controls) : null), [live, runner, model, input, controls]);

  const download = () => {
    const blob = new Blob([JSON.stringify(model)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${job.dataset.name.replace(/\W+/g, "-").toLowerCase()}-${model.kind}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className={`space-y-5 ${bare ? "" : "border-t border-rule pt-6"}`}>
      <div className="space-y-1">
        <h2 className="text-[16px] leading-[22px] font-semibold">{title}</h2>
        {headline && (
          <div className="pt-1">
            <div className="flex flex-wrap items-baseline gap-x-2.5">
              <span
                className="text-[40px] leading-none font-semibold tabular-nums text-foreground"
                style={{ fontStretch: "68%", fontVariationSettings: '"wdth" 68' }}
              >
                {formatMetric(headline.value, headline.format)}
              </span>
              <span className="text-[16px] leading-[22px] text-muted">{headline.label}</span>
            </div>
            {headline.detail && <div className="mt-1 text-[12px] leading-4 text-muted">{headline.detail}</div>}
          </div>
        )}
        <div className="text-[12px] leading-4 text-muted">
          Trained on {[job.dataset.name, job.plan, job.paidUsd !== null ? usd4(job.paidUsd) : null, job.modelBytes !== null ? kb(job.modelBytes) : null].filter(Boolean).join(", ")}
        </div>
      </div>

      {runner ? (
        <div className="space-y-2">
          <div className="font-medium">{model.interface.input.label}</div>
          {model.interface.input.lines && model.interface.input.lines > 1 ? (
            <textarea
              className={`${TEXTAREA} w-full resize-none`}
              rows={model.interface.input.lines}
              placeholder={model.interface.input.placeholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          ) : (
            <input
              className={`${INPUT} w-full`}
              placeholder={model.interface.input.placeholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          )}

          {(model.interface.output.controls ?? []).map((c) => (
            <label key={c.key} className="flex items-center gap-3 text-muted">
              {c.label}
              <input
                type="range"
                min={c.min ?? 0}
                max={c.max ?? 1000}
                step={c.step ?? 1}
                value={controls[c.key] ?? c.value}
                className="flex-1"
                onChange={(e) => setControls((s) => ({ ...s, [c.key]: Number(e.target.value) }))}
              />
              <span className="text-foreground">{controls[c.key] ?? c.value}</span>
            </label>
          ))}

          {!live && (
            <button
              className={BTN}
              onClick={() => {
                const out = runModel(model, input, controls);
                setProduced(out && out.type === "text" ? out.text : null);
              }}
            >
              Run it
            </button>
          )}

          {model.interface.output.type === "passages" && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className={BTN}
                  disabled={asking || !input.trim() || !result || result.type !== "passages" || !runner}
                  onClick={async () => {
                    if (!result || result.type !== "passages") return;
                    setAsking(true);
                    setAskError(null);
                    setAnswer(null);
                    try {
                      const res = await fetch("/api/demo/ask", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ question: input, passages: result.passages, provider: answerWith || undefined }),
                      });
                      const body = await res.json();
                      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
                      setAnswer(body);
                    } catch (e) {
                      setAskError((e as Error).message);
                    } finally {
                      setAsking(false);
                    }
                  }}
                >
                  {asking ? "Asking…" : "Submit"}
                </button>
                <span className="flex items-center gap-2 text-muted">
                  Answered by
                  <select
                    className={INPUT}
                    value={answerWith || (models?.selected ?? "")}
                    onChange={(e) => setAnswerWith(e.target.value)}
                  >
                    {(models?.providers ?? [])
                      .filter((p) => p.key)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.modelName}
                        </option>
                      ))}
                  </select>
                </span>
              </div>
              {askError && <div className="text-bad">{askError}</div>}
              {answer && (
                <div className="border-l-2 pl-3" style={{ borderColor: "var(--foreground)" }}>
                  <div className="whitespace-pre-wrap">{answer.answer}</div>
                </div>
              )}
            </div>
          )}

          {live && result && result.type === "passages" && (
            <div className="space-y-3">
              {result.passages.map((p, i) => (
                <div key={i} className="border-l-2 border-rule pl-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-muted">[{i + 1}]</span>
                    <a href={p.url} target="_blank" rel="noreferrer" className="font-semibold">
                      {p.title || p.url}
                    </a>
                    <span className="text-muted">{(p.score * 100).toFixed(0)}% match</span>
                  </div>
                  <div className="break-words text-muted">{p.text}</div>
                </div>
              ))}
            </div>
          )}

          {live && model.interface.output.type === "passages" && !result && (
            <div className="text-muted">
              {input.trim() ? "None of those words appear in your file, so it found no passage to answer from." : model.interface.output.label}
            </div>
          )}

          {live &&
            model.interface.output.type === "labels" &&
            (result && result.type === "labels" ? (
              <div className="space-y-1">
                <div>
                  {/* The percentage is on the bar right below; the label alone leads. */}
                  <span className="font-semibold">{result.label}</span>
                </div>
                {result.scores
                  .slice()
                  .sort((a, b) => b.probability - a.probability)
                  .slice(0, 8)
                  .map((s) => (
                    <div key={s.label} className="flex items-center gap-2">
                      <span className="w-28 shrink-0 truncate text-muted">{s.label}</span>
                      <span className="h-2 flex-1 border border-rule">
                        <span className="block h-full bg-foreground" style={{ width: `${Math.round(s.probability * 100)}%` }} />
                      </span>
                      <span className="w-12 shrink-0 text-right text-muted">{(s.probability * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                {result.evidence && (
                  <div className="text-muted">
                    {result.evidence.label}: {result.evidence.items.join(", ")}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-muted">
                {input.trim() ? "None of those words appear in your data, so it has nothing to go on." : model.interface.output.label}
              </div>
            ))}

          {!live && produced && <pre className="max-h-[320px] overflow-y-auto whitespace-pre-wrap border-l-2 border-rule pl-3">{produced}</pre>}
        </div>
      ) : (
        <div className="text-muted">
          This model needs a runtime this page does not have ({model.runtime}), so it cannot run here. Its scores are below and you can download it and
          run it yourself.
        </div>
      )}

      <div className="border-t border-rule pt-3">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-[12px] leading-4">
          <button className={TEXT_BTN} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide the details" : "How it scored and what it chose"}
          </button>
          <button className={TEXT_BTN} onClick={download}>
            Download the model
          </button>
        </div>
        {expanded && (
          <div className="mt-2 space-y-3">
            <MetricList metrics={model.metrics} />
            {model.settings && model.settings.length > 0 && (
              <div>
                <div className="text-[12px] leading-4 font-medium text-muted">The settings it landed on</div>
                <MetricList metrics={model.settings} />
              </div>
            )}
            {model.candidates && model.candidates.rows.length > 0 && (
              <div>
                <div className="text-[12px] leading-4 font-medium text-muted">Every setting it tried, and how each scored</div>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-rule-strong text-left text-[12px] leading-4 text-muted">
                      {model.candidates.columns.map((c) => (
                        <th key={c.key} className="py-2 pr-4 font-medium">
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {model.candidates.rows.map((row, i) => (
                      <tr key={i} className="border-b border-rule">
                        {model.candidates!.columns.map((c) => (
                          <td key={c.key} className="py-2 pr-4">
                            {formatMetric(row[c.key], c.format)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
