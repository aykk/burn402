"use client";

import Image from "next/image";
import { useState } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import { BTN_PRIMARY, INPUT, MONO, TEXT_BTN } from "./ui";

/** Provider marks render monochrome in ink so the picker stays inside the palette. */
const MONO_MARK = { filter: "grayscale(1) brightness(0.3)" } as const;

export function ModelPicker({
  models,
  disabled,
  onSave,
}: {
  models: Snapshot["models"];
  disabled: boolean;
  onSave: (provider: string, key?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const selected = models.providers.find((p) => p.id === models.selected)!;
  const missingKey = !selected.key;

  const save = async () => {
    await onSave(selected.id, draft);
    setDraft("");
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
                onClick={() => {
                  setDraft("");
                  void onSave(p.id);
                }}
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
              type="password"
              autoComplete="off"
              className={`${INPUT} flex-1`}
              placeholder={selected.key ? "Paste a different key to replace it" : `Paste your ${selected.name} API key`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className={BTN_PRIMARY} disabled={disabled || !draft.trim()}>
              Save key
            </button>
          </form>
          <button className={`text-[12px] leading-4 ${TEXT_BTN}`} onClick={() => setOpen(false)}>
            Close
          </button>
        </span>
      )}
    </span>
  );
}
