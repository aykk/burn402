"use client";

import Link from "next/link";
import type { ReactNode } from "react";

const PAGES = [
  { href: "/", label: "Run" },
  { href: "/records", label: "Records" },
  { href: "/audit", label: "Audit" },
] as const;

export function Nav({ current, children }: { current: "/" | "/audit" | "/records"; children?: ReactNode }) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-8 gap-y-3 pb-5">
      <Link href="/" className="text-[18px] leading-none font-semibold tracking-[-0.01em] text-foreground no-underline">
        burn
        <span className="font-extrabold tabular-nums" style={{ fontStretch: "68%", fontVariationSettings: '"wdth" 68' }}>
          402
        </span>
      </Link>
      <nav aria-label="Pages" className="flex items-center gap-6">
        {PAGES.map((page) => {
          const here = page.href === current;
          return (
            <Link
              key={page.href}
              href={page.href}
              aria-current={here ? "page" : undefined}
              className={`border-b-2 pb-0.5 no-underline transition-colors ${
                here ? "border-foreground font-medium text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {page.label}
            </Link>
          );
        })}
      </nav>
      <span className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:ml-auto">{children}</span>
    </header>
  );
}
