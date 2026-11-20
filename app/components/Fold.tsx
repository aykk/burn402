"use client";

/** A text toggle that reads "show …" or "hide …" before its label. */
export function Fold({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      className="text-muted underline underline-offset-2 hover:text-foreground"
      aria-expanded={open}
      onClick={onToggle}
      style={{ background: "none", border: "none", padding: 0 }}
    >
      {open ? "hide" : "show"} {label}
    </button>
  );
}
