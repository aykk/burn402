// Shared control classes. One control height (36px) for inputs, buttons and toggles; Start run is the
// only larger control (40px). Radius 3px everywhere. Exactly one filled ink button per view.

export const INPUT =
  "h-9 min-w-0 rounded-[3px] border border-rule-strong bg-surface px-3 py-[7px] text-[13.5px] leading-5 text-foreground disabled:opacity-60";

export const TEXTAREA =
  "min-w-0 rounded-[3px] border border-rule-strong bg-surface px-3 py-2 text-[13.5px] leading-5 text-foreground disabled:opacity-60";

export const BTN =
  "inline-flex h-9 shrink-0 items-center justify-center rounded-[3px] border border-rule-strong bg-transparent px-4 text-[13.5px] leading-5 text-foreground hover:border-foreground enabled:hover:bg-surface disabled:cursor-not-allowed disabled:border-rule disabled:text-muted disabled:hover:border-rule";

export const BTN_PRIMARY =
  "inline-flex h-9 shrink-0 items-center justify-center rounded-[3px] border border-foreground bg-foreground px-4 text-[13.5px] leading-5 font-medium text-surface enabled:hover:bg-[#2B3644] disabled:cursor-not-allowed disabled:border-segment disabled:bg-segment disabled:text-muted";

/** A text button that reads as a link: ink, 1px underline that thickens on hover. */
export const TEXT_BTN =
  "text-foreground underline decoration-1 underline-offset-[3px] enabled:hover:decoration-2 disabled:cursor-not-allowed disabled:text-muted";

/** Mono for machine strings: ANS names, tx ids, signatures, JSON. */
export const MONO = "font-mono text-[12px] leading-4";
