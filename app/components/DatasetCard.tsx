import type { DatasetSource } from "@/lib/train";

export type Detected = { dataset: DatasetSource; labels: string[]; sampleRows: string[] };

/** What the combined dataset trains, in one line: "Sorts text, 400 labelled rows across 2 labels". */
export function datasetSummary(detected: Detected): string {
  const d = detected.dataset;
  return `${d.kind === "classifier" ? "Sorts text" : d.kind === "retrieval" ? "Answers from documents" : "Writes more text"}, ${d.note}`;
}

export function DatasetCard({ detected }: { detected: Detected }) {
  return <div className="text-[12px] leading-4 text-muted">{datasetSummary(detected)}</div>;
}
