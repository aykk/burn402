import type { ReactNode } from "react";

/**
 * The label text itself is the trigger: a keyboard-focusable button with a dotted underline that
 * reveals a longer explanation on hover or focus. No box, no "?".
 */
export function Help({ id, text, children, className = "" }: { id: string; text: string; children: ReactNode; className?: string }) {
  return (
    <span className="group relative inline-block">
      <button
        type="button"
        aria-describedby={id}
        className={`cursor-help text-left underline decoration-dotted decoration-rule-strong decoration-1 underline-offset-4 hover:decoration-foreground focus-visible:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${className}`}
      >
        {children}
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute top-full left-0 z-30 mt-1.5 hidden w-max max-w-[min(280px,80vw)] rounded-[3px] border border-rule-strong bg-surface px-3 py-2.5 text-[13.5px] leading-5 font-normal text-foreground group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  );
}
