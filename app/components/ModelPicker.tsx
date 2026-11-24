"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import { ActionError } from "./ActionError";
import { BTN_PRIMARY, INPUT, MONO, TEXT_BTN } from "./ui";

/** Provider marks render monochrome in ink so the picker stays inside the palette. */
const MONO_MARK = { filter: "grayscale(1) brightness(0.3)" } as const;

export function ModelPicker({
  models,
  disabled,
  onSave,
  open,
  onOpenChange: setOpen,
}: {
  models: Snapshot["models"];
  disabled: boolean;
  onSave: (provider: string, key?: string) => Promise<string | null>;
  /** Owned by the page so a blocked Start run can open the picker too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const keyRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // What failed and why: saving a key or switching model. Shown inside the panel until dismissed or retried.
  const [error, setError] = useState<{ what: string; message: string } | null>(null);
  const selected = models.providers.find((p) => p.id === models.selected)!;
  const missingKey = !selected.key;

  // Opened without a key (from Add key or from the Start run hint), the cursor goes straight to the
  // key field; focusing it also scrolls the panel into view when the page is scrolled down.
  useEffect(() => {
    if (open && missingKey) keyRef.current?.focus();
  }, [open, missingKey]);

  const save = async () => {
    setError(null);
    setSaving(true);
    const failed = await onSave(selected.id, draft);
    setSaving(false);
    // A refused key stays in the field so it can be corrected instead of pasted again.
    if (failed) setError({ what: "The key wasn't saved", message: failed });
    else setDraft("");
  };

  const choose = async (id: string, name: string) => {
    setError(null);
    setDraft("");
    const failed = await onSave(id);
    if (failed) setError({ what: `Couldn't switch to ${name}`, message: failed });
  };

  return (
    <span className="relative flex items-center gap-3">
      <button
        className="flex h-8 items-center gap-2 rounded-[3px] border border-rule-strong px-3 text-foreground hover:border-foreground"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Image src={`/models/${selected.id}.svg`} alt="" width={14} height={14} unoptimized style={MONO_MARK} />
        {selected.modelName}
      </button>
      {missingKey && (
        <button className={TEXT_BTN} onClick={() => setOpen(true)}>
          Add key
        </button>
      )}

      {open && (
        <span className="absolute top-10 right-0 z-20 block w-[min(380px,calc(100vw-32px))] space-y-4 rounded-[3px] border border-rule-strong bg-surface p-4">
          <span className="block space-y-1">
            <span className="block text-[16px] leading-[22px] font-semibold">Agent model</span>
            <span className="block text-muted">
              This model reads your request, talks to the broker, decides what to rent and pays for it.
            </span>
          </span>
          <span className="flex flex-wrap gap-2">
            {models.providers.map((p) => (
              <button
                key={p.id}
                aria-pressed={p.id === models.selected}
                className={`flex h-9 items-center gap-2 rounded-[3px] border px-3 disabled:cursor-not-allowed ${
                  p.id === models.selected ? "border-foreground text-foreground" : "border-rule-strong text-foreground hover:border-foreground"
                } ${disabled ? "opacity-50" : ""}`}
                disabled={disabled || p.id === models.selected}
                onClick={() => void choose(p.id, p.name)}
              >
                <Image src={`/models/${p.id}.svg`} alt="" width={14} height={14} unoptimized style={MONO_MARK} />
                {p.name}
                {p.key && <span className="text-[12px] text-ok">Key set</span>}
              </button>
            ))}
          </span>
          <span className="block text-[12px] leading-4">
            {selected.key ? (
              <>
                <span className="font-medium text-ok">Key loaded</span>{" "}
                <span className="text-muted">
                  <span className={MONO}>{selected.key}</span>, {selected.company} {selected.modelName}
                </span>
              </>
            ) : (
              <span className="text-muted">No {selected.name} key yet. Paste one below.</span>
            )}
          </span>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) void save();
            }}
          >
            <input
              ref={keyRef}
              type="password"
              autoComplete="off"
              className={`${INPUT} flex-1`}
              placeholder={selected.key ? "Paste a different key to replace it" : `Paste your ${selected.name} API key`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className={BTN_PRIMARY} disabled={disabled || saving || !draft.trim()}>
              {saving ? "Saving…" : "Save key"}
            </button>
          </form>
          <ActionError what={error?.what ?? ""} message={error?.message ?? null} onDismiss={() => setError(null)} />
          <button className={`text-[12px] leading-4 ${TEXT_BTN}`} onClick={() => setOpen(false)}>
            Close
          </button>
        </span>
      )}
    </span>
  );
}
