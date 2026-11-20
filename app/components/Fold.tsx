"use client";

export function Fold({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button className="text-muted hover:text-foreground" onClick={onToggle} style={{ background: "none", border: "none", padding: 0 }}>
      {label}, {open ? "hide" : "show"}
    </button>
  );
}
