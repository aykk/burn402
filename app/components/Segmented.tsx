/**
 * A joined segmented control: buttons share borders, outer corners 3px, inner corners square.
 * Selected is ink-filled. A `danger` option (Arweave mainnet) carries a 6px bad-red dot before its label
 * and shows a red outline only on hover and focus. With `spends` as well (the real market, which spends
 * real money) the option fills red when chosen; a danger option that only reads stays ink.
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
  className = "",
  id,
  describedBy,
  fill,
}: {
  label: string;
  options: readonly { value: T; label: string; danger?: boolean; spends?: boolean }[];
  /** null selects nothing (the choice is still being worked out). */
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  describedBy?: string;
  /** Fills the width it is given, the options sharing it equally (the filter rail). */
  fill?: boolean;
}) {
  return (
    <div id={id} role="group" aria-label={label} aria-describedby={describedBy} className={`flex ${fill ? "w-full" : ""} ${className}`}>
      {options.map((o, i) => {
        const on = o.value === value;
        // The real-money option turns red when chosen, so the mode that spends real money is never quiet.
        const tone = on
          ? o.danger && o.spends
            ? "z-10 border-bad bg-bad text-white"
            : "z-10 border-foreground bg-foreground text-surface"
          : "border-rule-strong bg-transparent text-foreground hover:z-[5] hover:border-foreground";
        const danger = o.danger ? "hover:z-[11] hover:border-bad focus-visible:z-[11] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bad" : "";
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`relative inline-flex h-9 items-center gap-2 border text-[14px] leading-5 whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${fill ? "min-w-0 flex-1 justify-center px-2" : "shrink-0 px-4"} ${tone} ${danger} ${
              i === 0 ? "rounded-l-[3px] rounded-r-none" : "-ml-px rounded-none"
            } ${i === options.length - 1 ? "rounded-r-[3px]" : ""}`}
          >
            {o.danger && <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${on && o.spends ? "bg-white" : "bg-bad"}`} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
