import type { DatasetSource, JobKind, JobSpec } from "./types";

export const CLASSIFIER_SIZING = {
  folds: 5,
  epochs: 12,
  maxRows: 20000,
  maxTerms: 30000,
  minCount: 2,
  lrGrid: [0.8, 0.5, 0.2],
  l2Grid: [0, 0.00001, 0.0001],
  maxWeights: 6000,
};

export const RETRIEVAL_SIZING = {
  folds: 4,
  maxPassages: 4000,
  probeCount: 600,
  termsGrid: [20000, 40000],
  minCountGrid: [1, 2],
  maxWeightsPerPassage: 60,
};

export const GENERATOR_SIZING = {
  folds: 5,
  maxChars: 1050000,
  orderGrid: [4, 5, 6, 7],
  smoothingGrid: [0.02, 0.1, 0.5],
  maxContexts: 24000,
  maxNext: 8,
};

export const MAX_DATASET_BYTES = 8000000;
export const PROBE_BYTES = 200000;

export type SniffResult = { dataset: DatasetSource; sampleRows: string[]; labels: string[] };

function splitCsv(line: string, sep: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === sep && !quoted) {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

function looksLikeLabel(value: string): boolean {
  return value.length > 0 && value.length <= 24 && !/\s{2}/.test(value) && value.split(/\s+/).length <= 3;
}

export function detect(
  head: string,
  options: { name: string; bytes: number; origin: "url" | "upload"; url: string; uploadId?: string; want?: JobKind | null },
): SniffResult {
  const lines = head.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("there is no readable text in that file");
  const bytes = Math.max(options.bytes, head.length);
  const maxBytes = Math.min(bytes, MAX_DATASET_BYTES);
  const base = { id: "dataset", name: options.name.slice(0, 60), origin: options.origin, url: options.url, uploadId: options.uploadId, maxBytes, bytes };
  const scale = head.length > 0 ? maxBytes / head.length : 1;

  if (lines[0].trimStart().startsWith("{")) {
    const parsed: Record<string, unknown>[] = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value && typeof value === "object") parsed.push(value);
      } catch {}
    }
    if (parsed.length === 0) throw new Error("those lines are not readable JSON objects");
    const keys = Object.keys(parsed[0]);
    const urlField = keys.find((k) => /^(url|link|source|href)$/i.test(k));
    const passageField = keys.find((k) => /text|body|content|passage|chunk/i.test(k));
    if (urlField && passageField) {
      const titleField = keys.find((k) => /title|heading|name|page/i.test(k));
      const texts = parsed.map((r) => String(r[passageField] ?? ""));
      const sources = new Set(parsed.map((r) => String(r[urlField] ?? "")));
      return {
        dataset: {
          ...base,
          kind: "retrieval",
          note: `passages with a link back to the page each came from, ${sources.size > 1 ? "several pages" : "one page"} in the sample`,
          format: "jsonl",
          textField: passageField,
          urlField,
          titleField,
          rows: Math.max(parsed.length, Math.round(parsed.length * scale)),
          charsPerRow: Math.round(texts.reduce((sum, t) => sum + t.length, 0) / Math.max(1, texts.length)),
        },
        sampleRows: texts.slice(0, 3).map((t) => t.slice(0, 200)),
        labels: [],
      };
    }
    const labelField = keys.find((k) => /label|class|category|sentiment|target|topic|intent/i.test(k)) ?? keys[0];
    const textField = keys.find((k) => /text|body|content|review|message|sentence|title|question/i.test(k)) ?? keys.find((k) => k !== labelField) ?? keys[0];
    const labels = [...new Set(parsed.map((r) => String(r[labelField] ?? "")))].filter(Boolean);
    const texts = parsed.map((r) => String(r[textField] ?? ""));
    return {
      dataset: {
        ...base,
        kind: "classifier",
        note: `JSONL, ${labels.length} labels in "${labelField}", text in "${textField}"`,
        format: "jsonl",
        labelField,
        textField,
        labels: labels.slice(0, 24),
        rows: Math.max(parsed.length, Math.round(parsed.length * scale)),
        charsPerRow: Math.round(texts.reduce((sum, t) => sum + t.length, 0) / Math.max(1, texts.length)),
      },
      sampleRows: texts.slice(0, 3).map((t) => t.slice(0, 200)),
      labels: labels.slice(0, 24),
    };
  }

  const sample = lines.slice(0, 40);
  const tabbed = sample.filter((l) => l.includes("\t")).length > sample.length / 2;
  const commas = sample.filter((l) => l.includes(",")).length > sample.length / 2;

  if (tabbed || commas) {
    const sep = tabbed ? "\t" : ",";
    const parsed = lines.map((l) => (sep === "\t" ? l.split("\t") : splitCsv(l, sep)));
    const width = Math.min(...parsed.slice(0, 40).map((p) => p.length));
    if (width >= 2) {
      const header = parsed[0].every((c) => looksLikeLabel(c.replace(/"/g, "")));
      const body = parsed.slice(header ? 1 : 0);
      const columns = Array.from({ length: width }, (_, i) => body.map((p) => (p[i] ?? "").replace(/^"|"$/g, "").trim()));
      const distinct = columns.map((c) => new Set(c).size);
      const avgLength = columns.map((c) => c.reduce((sum, v) => sum + v.length, 0) / Math.max(1, c.length));
      let textColumn = 0;
      for (let i = 0; i < width; i++) if (avgLength[i] > avgLength[textColumn]) textColumn = i;
      const candidates = Array.from({ length: width }, (_, i) => i).filter(
        (i) => i !== textColumn && distinct[i] > 1 && distinct[i] <= Math.max(12, body.length / 50) && columns[i].every(looksLikeLabel),
      );
      candidates.sort((a, b) => distinct[a] - distinct[b] || avgLength[a] - avgLength[b]);
      if (candidates.length > 0) {
        const labelColumn = candidates[0];
        const labels = [...new Set(columns[labelColumn])].filter(Boolean);
        const names = header ? parsed[0].map((c) => c.replace(/"/g, "").trim()) : [];
        const where = (i: number) => (names[i] ? `"${names[i]}"` : `column ${i + 1}`);
        return {
          dataset: {
            ...base,
            kind: "classifier",
            note: `${sep === "\t" ? "TSV" : "CSV"}, ${labels.length} labels in ${where(labelColumn)}, text in ${where(textColumn)}`,
            format: sep === "\t" ? "tsv" : "csv",
            header,
            labelColumn,
            textColumn,
            labels: labels.slice(0, 24),
            rows: Math.max(body.length, Math.round(body.length * scale)),
            charsPerRow: Math.round(avgLength[textColumn]),
          },
          sampleRows: columns[textColumn].slice(0, 3).map((v) => v.slice(0, 200)),
          labels: labels.slice(0, 24),
        };
      }
    }
  }

  if (options.want === "classifier") throw new Error("that file has no label column, so it can only train a language model");
  return {
    dataset: { ...base, kind: "generator", note: `plain text, ${Math.round(bytes / 1024).toLocaleString()} KB to learn a style from`, rows: 0, charsPerRow: 0 },
    sampleRows: [head.slice(0, 200)],
    labels: [],
  };
}

export async function sniff(url: string, want: JobKind | null = null): Promise<SniffResult> {
  if (!/^https?:\/\//.test(url)) throw new Error("the dataset URL has to start with http:// or https://");
  const response = await fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES}` }, signal: AbortSignal.timeout(20000) });
  if (!response.ok && response.status !== 206) throw new Error(`that URL answered HTTP ${response.status}`);
  const head = await response.text();
  const total = response.headers.get("content-range")?.split("/")[1] ?? response.headers.get("content-length");
  const name = decodeURIComponent(url.split("/").pop() ?? "your dataset");
  return detect(head, { name, bytes: Number(total) || head.length, origin: "url", url, want });
}

export function suggestRequest(dataset: DatasetSource): string {
  if (dataset.kind === "retrieval") return `answer questions from ${dataset.name} and show me the page it came from`;
  if (dataset.kind === "generator") return `write more text in the style of ${dataset.name}`;
  const labels = dataset.labels ?? [];
  if (labels.length === 0) return `sort the text in ${dataset.name} into its labels`;
  if (labels.length <= 3) return `sort text into ${labels.join(", ")}`;
  return `sort text into one of the ${labels.length} labels in ${dataset.name}`;
}

export function jobSpec(request: string, dataset: DatasetSource): JobSpec {
  const shared = { kind: dataset.kind, request, dataset, ...CLASSIFIER_SIZING, ...GENERATOR_SIZING, ...RETRIEVAL_SIZING };
  const folds = dataset.kind === "classifier" ? CLASSIFIER_SIZING.folds : dataset.kind === "generator" ? GENERATOR_SIZING.folds : RETRIEVAL_SIZING.folds;
  return { ...shared, folds };
}

export function gridSize(spec: JobSpec): number {
  if (spec.kind === "classifier") return spec.lrGrid.length * spec.l2Grid.length;
  if (spec.kind === "generator") return spec.orderGrid.length * spec.smoothingGrid.length;
  return spec.termsGrid.length * spec.minCountGrid.length;
}

export function foldJobs(spec: JobSpec): number {
  return gridSize(spec) * spec.folds;
}
