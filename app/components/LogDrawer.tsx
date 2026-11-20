"use client";

import { useEffect, useRef } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import { clock } from "./format";

export function LogDrawer({ open, onClose, log }: { open: boolean; onClose: () => void; log: Snapshot["log"] }) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log.length, open]);

  return (
    <div
      className={`fixed right-0 top-0 z-10 flex h-full w-full max-w-[620px] flex-col border-l border-rule-strong bg-surface transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}
    >
      <div className="flex items-center border-b border-rule p-3">
        <span className="text-[16px] leading-[22px] font-semibold">Log</span>
        <button
          className="ml-auto inline-flex h-8 items-center rounded-[3px] border border-rule-strong px-3 text-foreground hover:border-foreground"
          aria-label="Close the log"
          onClick={() => onClose()}
        >
          Close
        </button>
      </div>
      <div ref={logRef} className="flex-1 overflow-y-auto p-3 text-[12px] leading-4">
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
