import Link from "next/link";
import type { ReactNode } from "react";

const PAGES = [
  { href: "/", label: "Run" },
  { href: "/records", label: "Records" },
  { href: "/audit", label: "Overspend test" },
] as const;

export function Nav({
  current,
  children,
}: {
  current: "/" | "/audit" | "/records";
  children?: ReactNode;
}) {
  return (
    // min-h-13 keeps the header the same height on pages with nothing on the right (36px row + 16px padding).
    <header className="flex min-h-13 shrink-0 flex-wrap items-center gap-x-8 gap-y-3 pb-4">
      {/* Wordmark and page links share one baseline; the group is centred against the controls on the right. */}
      <div className="flex items-baseline gap-x-8">
        <Link
          href="/"
          className="text-[18px] leading-none font-semibold tracking-[-0.01em] whitespace-nowrap text-foreground no-underline"
        >
          {/* The fire is the one emoji allowed in the UI (owner override). It is decorative. */}
          <span aria-hidden className="mr-[3px] text-[16px]">
            🔥
          </span>
          burn
          <span className="font-extrabold" style={{ fontStretch: "68%" }}>
            402
          </span>
        </Link>
        <nav aria-label="Pages" className="flex items-baseline gap-6">
          {PAGES.map((page) => {
            const here = page.href === current;
            return (
              <Link
                key={page.href}
                href={page.href}
                aria-current={here ? "page" : undefined}
                className={`border-b-2 pb-0.5 no-underline transition-colors ${
                  here
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                {page.label}
              </Link>
            );
          })}
        </nav>
      </div>
      {children && (
        <span className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:ml-auto">
          {children}
        </span>
      )}
    </header>
  );
}
