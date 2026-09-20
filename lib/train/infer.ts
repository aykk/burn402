import type { TrainedModel } from "./types";

const TOKEN = /[a-z0-9']+/g;

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(TOKEN) ?? [];
  const pairs = words.slice(0, -1).map((w, i) => `${w}_${words[i + 1]}`);
  return [...words, ...pairs];
}

export type LabelResult = {
  type: "labels";
  label: string;
  scores: { label: string; probability: number }[];
  evidence: { label: string; items: string[] } | null;
};

export type TextResult = { type: "text"; text: string };

export type PassageResult = {
  type: "passages";
  passages: { title: string; url: string; text: string; score: number }[];
};

export type RunResult = LabelResult | TextResult | PassageResult;

export type Runner = {
  id: string;
  describe: string;
  run(model: TrainedModel, input: string, controls: Record<string, number>): RunResult | null;
};

type LinearBow = { labels: string[]; terms: string[]; idf: number[]; weights: number[][]; bias: number[] };
type CharNgram = { order: number; table: Record<string, [string, number][]>; seed: string };

const linearBow: Runner = {
  id: "linear-bow",
  describe: "bag of words and word pairs, weighted by tf-idf, scored by a linear model",
  run(model, input) {
    const m = model as unknown as LinearBow;
    const index = new Map(m.terms.map((t, i) => [t, i]));
    const counts = new Map<number, number>();
    for (const token of tokenize(input)) {
      const i = index.get(token);
      if (i !== undefined) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    const raw = [...counts].map(([i, c]) => [i, (1 + Math.log(c)) * m.idf[i]] as [number, number]);
    const norm = Math.sqrt(raw.reduce((sum, [, v]) => sum + v * v, 0)) || 1;
    const vector = raw.map(([i, v]) => [i, v / norm] as [number, number]);
    const scores = m.bias.map((bias, c) => bias + vector.reduce((sum, [i, v]) => sum + m.weights[c][i] * v, 0));
    const top = Math.max(...scores);
    const exps = scores.map((s) => Math.exp(s - top));
    const total = exps.reduce((a, b) => a + b, 0);
    const best = scores.indexOf(top);
    const items = vector
      .map(([i, v]) => ({ term: m.terms[i], weight: m.weights[best][i] * v }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, 6)
      .map((t) => t.term.replace("_", " "));
    return {
      type: "labels",
      label: m.labels[best],
      scores: m.labels.map((label, c) => ({ label, probability: exps[c] / total })),
      evidence: items.length > 0 ? { label: "what it leaned on", items } : null,
    };
  },
};

const charNgram: Runner = {
  id: "char-ngram",
  describe: "character n-gram table with backoff to shorter contexts",
  run(model, input, controls) {
    const m = model as unknown as CharNgram;
    const length = Math.min(4000, Math.max(20, Math.round(controls.length ?? 400)));
    let context = (input || m.seed).slice(-m.order);
    let out = input || m.seed;
    for (let n = 0; n < length; n++) {
      let row: [string, number][] | undefined;
      let key = context.slice(-m.order);
      while (key.length > 0 && !row) {
        row = m.table[key];
        key = key.slice(1);
      }
      if (!row) row = m.table[m.seed.slice(0, 1)] ?? Object.values(m.table)[0];
      if (!row) break;
      const total = row.reduce((sum, [, p]) => sum + p, 0);
      let mark = Math.random() * total;
      let next = row[row.length - 1][0];
      for (const [ch, p] of row) {
        mark -= p;
        if (mark <= 0) {
          next = ch;
          break;
        }
      }
      out += next;
      context += next;
    }
    return { type: "text", text: out };
  },
};

type Passage = { title: string; url: string; text: string; vector: [number, number][] };
type TfidfPassages = { terms: string[]; idf: number[]; passages: Passage[] };

const tfidfPassages: Runner = {
  id: "tfidf-passages",
  describe: "tf-idf over passages, ranked by cosine similarity to the question",
  run(model, input, controls) {
    const m = model as unknown as TfidfPassages;
    const index = new Map(m.terms.map((t, i) => [t, i]));
    const counts = new Map<number, number>();
    for (const token of tokenize(input)) {
      const i = index.get(token);
      if (i !== undefined) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    const raw = [...counts].map(([i, c]) => [i, (1 + Math.log(c)) * m.idf[i]] as [number, number]);
    const norm = Math.sqrt(raw.reduce((sum, [, v]) => sum + v * v, 0)) || 1;
    const query = new Map(raw.map(([i, v]) => [i, v / norm]));
    const scored = m.passages
      .map((p) => {
        let score = 0;
        for (const [i, v] of p.vector) {
          const w = query.get(i);
          if (w !== undefined) score += w * v;
        }
        return { title: p.title, url: p.url, text: p.text, score };
      })
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(10, Math.max(1, Math.round(controls.answers ?? 3))));
    return scored.length > 0 ? { type: "passages", passages: scored } : null;
  },
};

export const RUNTIMES: Record<string, Runner> = {
  [linearBow.id]: linearBow,
  [charNgram.id]: charNgram,
  [tfidfPassages.id]: tfidfPassages,
};

export function runnerFor(model: TrainedModel): Runner | null {
  return RUNTIMES[model.runtime] ?? null;
}

export function run(model: TrainedModel, input: string, controls: Record<string, number> = {}): RunResult | null {
  return runnerFor(model)?.run(model, input, controls) ?? null;
}

export function headlineMetric(model: TrainedModel) {
  return model.metrics.find((m) => m.headline) ?? model.metrics[0] ?? null;
}

export function formatMetric(value: number | string, format: string): string {
  if (typeof value === "string") return value;
  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  if (format === "count") return value.toLocaleString();
  if (format === "seconds") return `${value}s`;
  if (format === "bytes") return value > 900000 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;
  return String(Math.round(value * 10000) / 10000);
}
