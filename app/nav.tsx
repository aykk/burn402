"use client";

import Link from "next/link";
import type { ReactNode } from "react";

const PAGES = [
  { href: "/audit", label: "ANS, mandates, receipts" },
  { href: "/records", label: "Arweave records" },
] as const;

export function Nav({ current, children }: { current: "/" | "/audit" | "/records"; children?: ReactNode }) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-7 gap-y-2 pb-4">
      <Link href="/" className="text-lg font-bold text-foreground no-underline hover:opacity-70" style={{ textDecoration: "none" }}>
        burn<span style={{ color: "var(--mark)" }}>402</span>
      </Link>
      <nav className="flex items-center gap-7">
        {PAGES.map((page) =>
          page.href === current ? (
            <span key={page.href} className="font-bold">
              {page.label}
            </span>
          ) : (
            <Link key={page.href} href={page.href}>
              {page.label}
            </Link>
          ),
        )}
      </nav>
      <span className="ml-auto flex items-center gap-7">{children}</span>
    </header>
  );
}
