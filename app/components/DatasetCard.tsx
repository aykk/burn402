import type { DatasetSource } from "@/lib/train";

export type Detected = { dataset: DatasetSource; labels: string[]; sampleRows: string[] };

export function DatasetCard({ detected }: { detected: Detected }) {
  const d = detected.dataset;
  return (
    <div className="text-muted">
      {d.kind === "classifier" ? "sorts text" : d.kind === "retrieval" ? "answers from documents" : "writes more text"}, {d.note}
    </div>
  );
}
