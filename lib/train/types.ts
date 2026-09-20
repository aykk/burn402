export type JobKind = "classifier" | "generator" | "retrieval";

export type DatasetSource = {
  id: string;
  name: string;
  note: string;
  kind: JobKind;
  origin: "url" | "upload";
  url: string;
  uploadId?: string;
  format?: "tsv" | "csv" | "jsonl";
  header?: boolean;
  labelColumn?: number;
  textColumn?: number;
  labelField?: string;
  textField?: string;
  labels?: string[];
  urlField?: string;
  titleField?: string;
  maxBytes?: number;
  rows: number;
  bytes: number;
  charsPerRow?: number;
};

export type JobSpec = {
  kind: JobKind;
  request: string;
  dataset: DatasetSource;
  folds: number;
  epochs: number;
  maxRows: number;
  maxChars: number;
  lrGrid: number[];
  l2Grid: number[];
  orderGrid: number[];
  smoothingGrid: number[];
  maxTerms: number;
  minCount: number;
  maxWeights: number;
  maxContexts: number;
  maxNext: number;
  maxPassages: number;
  probeCount: number;
  termsGrid: number[];
  minCountGrid: number[];
  maxWeightsPerPassage: number;
};

export type MetricFormat = "percent" | "count" | "number" | "seconds" | "bytes";

export type Metric = {
  key: string;
  label: string;
  value: number | string;
  format: MetricFormat;
  better?: "higher" | "lower";
  headline?: boolean;
  detail?: string;
};

export type Control = { key: string; label: string; value: number; min?: number; max?: number; step?: number };

export type ModelInterface = {
  input: { type: "text"; label: string; placeholder: string; lines?: number };
  output: { type: "labels" | "continuation" | "number" | "passages"; label: string; controls?: Control[] };
};

export type CandidateTable = {
  columns: { key: string; label: string; format: MetricFormat; better?: "higher" | "lower" }[];
  rows: Record<string, number | string>[];
};

export type TrainedModel = {
  schema: string;
  runtime: string;
  kind: string;
  trainedAt: number;
  interface: ModelInterface;
  metrics: Metric[];
  settings?: Metric[];
  candidates?: CandidateTable;
} & Record<string, unknown>;

export type TrainingStatus = {
  phase: "starting" | "waiting" | "downloading" | "training" | "done" | "failed";
  message: string;
  log: { at: number; text: string }[];
  elapsed: number;
  progress: number;
  rows: number;
  vcpus: number;
  configs_total: number;
  configs_done: number;
  metrics: Metric[] | null;
  done: boolean;
  error: string | null;
};
