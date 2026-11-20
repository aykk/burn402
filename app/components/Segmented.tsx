/**
 * A joined segmented control: buttons share borders, outer corners 3px, inner corners square.
 * Selected is ink-filled; an option can ask for the bad fill instead (Arweave mainnet).
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
  className = "",
}: {
  label: string;
  options: readonly { value: T; label: string; danger?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={`flex ${className}`}>
      {options.map((o, i) => {
        const on = o.value === value;
        const tone = on
          ? o.danger
            ? "z-10 border-bad bg-bad text-surface"
            : "z-10 border-foreground bg-foreground text-surface"
          : "border-rule-strong bg-transparent text-foreground hover:z-[5] hover:border-foreground";
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`relative h-9 shrink-0 border px-4 text-[13.5px] leading-5 whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${tone} ${
              i === 0 ? "rounded-l-[3px] rounded-r-none" : "-ml-px rounded-none"
            } ${i === options.length - 1 ? "rounded-r-[3px]" : ""}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
