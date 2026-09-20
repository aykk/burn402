"use client";

import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

const PAGES = [
  { href: "/audit", label: "ANS, mandates, receipts" },
  { href: "/records", label: "Arweave records" },
] as const;

export function Nav({ current, children }: { current: "/" | "/audit" | "/records"; children?: ReactNode }) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-7 gap-y-2 pb-4">
      <Link href="/" className="flex items-center gap-2 text-lg font-bold text-foreground no-underline hover:opacity-70" style={{ textDecoration: "none" }}>
        <Image src="/mark.png" alt="" width={13} height={20} priority className="shrink-0" />
        <span>
          burn<span style={{ color: "var(--mark)" }}>402</span>
        </span>
      </Link>
      <nav className="flex items-center gap-7">
        {PAGES.map((page) =>
          page.href === current ? (
            <span
              key={page.href}
              className="font-bold"
              style={{ boxShadow: "inset 0 -2px 0 0 var(--mark)", paddingBottom: "2px" }}
            >
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
