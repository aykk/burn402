"use client";

/** A keyboard-focusable "?" control that reveals a longer explanation on hover or focus. */
export function Help({ id, label, text }: { id: string; label: string; text: string }) {
  return (
    <span className="group relative inline-block align-middle">
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        className="h-[18px] w-[18px] rounded-[3px] border border-rule text-[12px] leading-none text-muted hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground"
      >
        ?
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute top-full left-0 z-10 mt-1 hidden w-64 max-w-[80vw] rounded-[3px] border border-rule bg-surface px-3 py-2 text-[12px] leading-snug font-normal text-foreground group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  );
}
