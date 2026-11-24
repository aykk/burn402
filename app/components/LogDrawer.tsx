"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import { clock } from "./format";

/**
 * The log slides in from the right as a modal dialog. Closed, it is inert: out of the tab order and the
 * accessibility tree while it waits off-screen. Open, focus moves to Close, Tab stays inside, Esc closes,
 * and focus goes back to the button that opened it.
 */
export function LogDrawer({
  open,
  onClose,
  log,
  returnFocus,
}: {
  open: boolean;
  onClose: () => void;
  log: Snapshot["log"];
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log.length, open]);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      closeRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      returnFocus.current?.focus();
    }
  }, [open, returnFocus]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])"));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="log-title"
      inert={!open}
      className={`fixed right-0 top-0 z-10 flex h-full w-full max-w-[620px] flex-col border-l border-rule-strong bg-surface transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}
    >
      <div className="flex items-center border-b border-rule p-3">
        <h2 id="log-title" className="text-[16px] leading-[22px] font-semibold">
          Log
        </h2>
        <button
          ref={closeRef}
          className="ml-auto inline-flex h-8 items-center rounded-[3px] border border-rule-strong px-3 text-foreground hover:border-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          aria-label="Close the log"
          onClick={() => onClose()}
        >
          Close
        </button>
      </div>
      {/* The scrolling log is itself a tab stop so keyboard users can scroll it. */}
      <div ref={logRef} tabIndex={0} aria-label="Log entries" className="flex-1 overflow-y-auto p-3 text-[12px] leading-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground">
        {log.map((l) => (
          <div
            key={l.seq}
            className={`${l.kind === "error" || l.kind === "refused" || l.kind === "breach" ? "text-bad" : l.kind === "step" ? "mt-2 font-semibold" : ""} whitespace-pre-wrap break-all`}
          >
            <span className="text-muted">{clock(l.at)} </span>
            {l.code} {l.text}
            {l.link && (
              <>
                {"  "}
                <a href={l.link.href} target="_blank" rel="noreferrer">
                  {l.link.label}
                </a>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
