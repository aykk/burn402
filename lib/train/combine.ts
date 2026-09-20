import { MAX_DATASET_BYTES } from "./datasets";
import type { DatasetSource, JobKind } from "./types";

export type Part = { dataset: DatasetSource; text: string };

export type Combined = { kind: JobKind; name: string; note: string; body: string; rows: number; charsPerRow: number; labels: string[] };

function splitRow(line: string, sep: string): string[] {
  if (sep === "\t") return line.split("\t");
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

function labelledRows(part: Part): { label: string; text: string }[] {
  const { dataset, text } = part;
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (dataset.format === "jsonl") {
    const rows: { label: string; text: string }[] = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const label = String(value[dataset.labelField ?? "label"] ?? "").trim();
        const body = String(value[dataset.textField ?? "text"] ?? "").trim();
        if (label && body) rows.push({ label, text: body });
      } catch {}
    }
    return rows;
  }
  const sep = dataset.format === "tsv" ? "\t" : ",";
  const body = dataset.header ? lines.slice(1) : lines;
  return body
    .map((line) => splitRow(line, sep))
    .map((cells) => ({
      label: (cells[dataset.labelColumn ?? 0] ?? "").replace(/^"|"$/g, "").trim(),
      text: (cells[dataset.textColumn ?? 1] ?? "").replace(/^"|"$/g, "").trim(),
    }))
    .filter((r) => r.label && r.text);
}

function passages(part: Part): { title: string; url: string; text: string }[] {
  const out: { title: string; url: string; text: string }[] = [];
  for (const line of part.text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const body = String(value[part.dataset.textField ?? "text"] ?? "").trim();
      const url = String(value[part.dataset.urlField ?? "url"] ?? "").trim();
      if (!body || !url) continue;
      out.push({ title: String(value[part.dataset.titleField ?? "title"] ?? "").trim(), url, text: body });
    } catch {}
  }
  return out;
}

export function combine(parts: Part[]): Combined {
  if (parts.length === 0) throw new Error("add at least one file or link");
  const kinds = [...new Set(parts.map((p) => p.dataset.kind))];
  if (kinds.length > 1) {
    throw new Error(`those files do not go together: ${kinds.join(" and ")} data train different kinds of model, so add them one job at a time`);
  }
  const kind = kinds[0];
  const names = parts.map((p) => p.dataset.name);
  const name = parts.length === 1 ? names[0] : `${names[0]} and ${parts.length - 1} more`;

  if (kind === "classifier") {
    const rows = parts.flatMap(labelledRows);
    if (rows.length === 0) throw new Error("none of those files had rows with both a label and some text");
    const labels = [...new Set(rows.map((r) => r.label))];
    const body = rows.map((r) => JSON.stringify({ label: r.label, text: r.text })).join("\n");
    return {
      kind,
      name,
      note: `${rows.length.toLocaleString()} labelled rows across ${labels.length} labels, from ${parts.length} source${parts.length === 1 ? "" : "s"}`,
      body,
      rows: rows.length,
      charsPerRow: Math.round(rows.reduce((sum, r) => sum + r.text.length, 0) / rows.length),
      labels: labels.slice(0, 24),
    };
  }

  if (kind === "retrieval") {
    const found = parts.flatMap(passages);
    if (found.length === 0) throw new Error("none of those files had passages with a link and some text");
    const body = found.map((p) => JSON.stringify(p)).join("\n");
    return {
      kind,
      name,
      note: `${found.length.toLocaleString()} passages from ${new Set(found.map((p) => p.url)).size.toLocaleString()} pages, across ${parts.length} source${parts.length === 1 ? "" : "s"}`,
      body,
      rows: found.length,
      charsPerRow: Math.round(found.reduce((sum, p) => sum + p.text.length, 0) / found.length),
      labels: [],
    };
  }

  const body = parts.map((p) => p.text).join("\n\n");
  return {
    kind,
    name,
    note: `${Math.round(body.length / 1024).toLocaleString()} KB of text, from ${parts.length} source${parts.length === 1 ? "" : "s"}`,
    body,
    rows: 0,
    charsPerRow: 0,
    labels: [],
  };
}

export function withinLimit(body: string): string {
  return body.length > MAX_DATASET_BYTES ? body.slice(0, MAX_DATASET_BYTES) : body;
}
