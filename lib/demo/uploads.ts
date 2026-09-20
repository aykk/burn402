import { combine, detect, MAX_DATASET_BYTES, PROBE_BYTES, withinLimit, type DatasetSource, type Part, type SniffResult } from "../train";

export type Upload = { id: string; name: string; bytes: Buffer; at: number };

type Store = { uploads: Map<string, Upload> };

const store = ((globalThis as unknown as { __burn402Uploads?: Store }).__burn402Uploads ??= { uploads: new Map() });

export function keep(name: string, bytes: Buffer): SniffResult {
  if (bytes.length === 0) throw new Error("that file is empty");
  if (bytes.length > MAX_DATASET_BYTES) throw new Error(`that file is ${Math.round(bytes.length / 1048576)} MB; the limit is ${MAX_DATASET_BYTES / 1000000} MB`);
  const id = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const head = bytes.subarray(0, PROBE_BYTES).toString("utf8");
  const result = detect(head, { name, bytes: bytes.length, origin: "upload", url: `upload://${id}`, uploadId: id });
  store.uploads.set(id, { id, name, bytes, at: Date.now() });
  for (const [key, upload] of store.uploads) if (Date.now() - upload.at > 6 * 60 * 60 * 1000) store.uploads.delete(key);
  return result;
}

export function merge(parts: { dataset: DatasetSource; bytes: Buffer }[]): SniffResult {
  const combined = combine(parts.map((p) => ({ dataset: p.dataset, text: p.bytes.toString("utf8") }) as Part));
  const body = withinLimit(combined.body);
  const id = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const bytes = Buffer.from(body, "utf8");
  store.uploads.set(id, { id, name: combined.name, bytes, at: Date.now() });
  const sample = body.split("\n").slice(0, 3);
  return {
    dataset: {
      id: "dataset",
      name: combined.name,
      note: combined.note,
      kind: combined.kind,
      origin: "upload",
      url: `upload://${id}`,
      uploadId: id,
      format: combined.kind === "generator" ? undefined : "jsonl",
      labelField: combined.kind === "classifier" ? "label" : undefined,
      textField: combined.kind === "generator" ? undefined : "text",
      urlField: combined.kind === "retrieval" ? "url" : undefined,
      titleField: combined.kind === "retrieval" ? "title" : undefined,
      labels: combined.labels,
      maxBytes: bytes.length,
      rows: combined.rows,
      bytes: bytes.length,
      charsPerRow: combined.charsPerRow,
    },
    sampleRows: sample.map((line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        return String(value.text ?? line).slice(0, 200);
      } catch {
        return line.slice(0, 200);
      }
    }),
    labels: combined.labels,
  };
}

export function uploaded(id: string): Upload | null {
  return store.uploads.get(id) ?? null;
}

export function bytesFor(dataset: DatasetSource): Buffer | null {
  return dataset.uploadId ? (uploaded(dataset.uploadId)?.bytes ?? null) : null;
}
