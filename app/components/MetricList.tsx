import type { Metric } from "@/lib/train";
import { formatMetric } from "@/lib/train/infer";

export function MetricList({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="space-y-0.5">
      {metrics.map((m) => (
        <div key={m.key} className="flex justify-between gap-4">
          <span className="text-muted">{m.label}</span>
          <span>{formatMetric(m.value, m.format)}</span>
        </div>
      ))}
    </div>
  );
}
