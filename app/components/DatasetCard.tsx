import type { DatasetSource } from "@/lib/train";

export type Detected = { dataset: DatasetSource; labels: string[]; sampleRows: string[] };

export function DatasetCard({ detected }: { detected: Detected }) {
  const d = detected.dataset;
  return (
    <div className="text-[12px] leading-4 text-muted">
      {d.kind === "classifier" ? "Sorts text" : d.kind === "retrieval" ? "Answers from documents" : "Writes more text"}, {d.note}
    </div>
  );
}
