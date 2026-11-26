import Link from "next/link";
import type { ReactNode } from "react";
import { Flame } from "@/app/components/Flame";

const PAGES = [
  { href: "/", label: "Rent" },
  { href: "/records", label: "Records" },
  { href: "/audit", label: "Overspend test" },
] as const;

export function Nav({
  current,
  burning = false,
  children,
}: {
  current: "/" | "/audit" | "/records";
  /** True while an agent is at work: the wordmark's flame burns faster. */
  burning?: boolean;
  children?: ReactNode;
}) {
  return (
    // Everything in the header sits on one baseline: the wordmark, the page links and the controls on the right.
    <header className="flex shrink-0 flex-wrap items-baseline gap-x-8 gap-y-3 pb-4">
      {/* A zero-width strut the size of a control (36px, body text centred in it). It sets the row's height and
          baseline, so the header is identical on pages with a button on the right and pages with nothing there. */}
      <span aria-hidden className="-mr-8 inline-flex h-9 w-0 items-center">
        &nbsp;
      </span>
      <div className="flex items-baseline gap-x-8">
        <Link
          href="/"
          className="text-[19px] leading-none font-semibold tracking-[-0.01em] whitespace-nowrap text-foreground no-underline"
        >
          {/* The fire is drawn so it can flicker; it sits on the wordmark's baseline. It is decorative. */}
          <Flame size={20} lit={burning} className="mr-[3px] -translate-y-px align-[-3px]" />
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
        <span className="flex flex-wrap items-baseline gap-x-6 gap-y-2 sm:ml-auto">
          {children}
        </span>
      )}
    </header>
  );
}
