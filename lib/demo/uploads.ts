import { detect, MAX_DATASET_BYTES, PROBE_BYTES, type DatasetSource, type SniffResult } from "../train";

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

export function uploaded(id: string): Upload | null {
  return store.uploads.get(id) ?? null;
}

export function bytesFor(dataset: DatasetSource): Buffer | null {
  return dataset.uploadId ? (uploaded(dataset.uploadId)?.bytes ?? null) : null;
}
