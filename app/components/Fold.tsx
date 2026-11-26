"use client";

/** A text toggle that reads "Show …" or "Hide …" before its label. */
export function Fold({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      className="text-[12px] leading-4 text-muted underline decoration-1 underline-offset-[3px] hover:text-foreground"
      aria-expanded={open}
      onClick={onToggle}
      style={{ background: "none", border: "none", padding: 0 }}
    >
      {open ? "Hide" : "Show"} {label}
    </button>
  );
}
