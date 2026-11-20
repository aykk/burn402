"use client";

import Image from "next/image";
import { useState } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";

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
    <span className="relative">
      <button
        className={`flex items-center gap-2 border px-3 py-1 ${missingKey ? "border-bad text-bad" : "border-foreground bg-foreground text-background hover:opacity-85"}`}
        onClick={() => setOpen(!open)}
      >
        <Image src={`/models/${selected.id}.svg`} alt="" width={14} height={14} unoptimized />
        {selected.modelName}
        {missingKey ? ", needs a key" : ""}
      </button>

      {open && (
        <span className="absolute right-0 top-9 z-20 block w-[380px] space-y-3 border border-rule-strong bg-surface p-4">
          <span className="block">
            <span className="block font-bold">Agent model</span>
            <span className="block text-muted">
              This model will read your request and communicate with the broker to decide what to rent and pay it.
            </span>
          </span>
          <span className="flex flex-wrap gap-2">
            {models.providers.map((p) => (
              <button
                key={p.id}
                className={`flex items-center gap-2 border px-3 py-1.5 ${p.id === models.selected ? "border-foreground" : "border-rule-strong text-muted hover:border-foreground hover:text-foreground"} ${disabled ? "opacity-40" : ""}`}
                disabled={disabled || p.id === models.selected}
                onClick={() => {
                  setDraft("");
                  void onSave(p.id);
                }}
              >
                <Image src={`/models/${p.id}.svg`} alt="" width={16} height={16} unoptimized />
                {p.name}
                {p.key && <span className="text-ok">key set</span>}
              </button>
            ))}
          </span>
          <span className="block">
            {selected.key ? (
              <>
                <span className="text-ok">key loaded</span>{" "}
                <span className="text-muted">
                  <span className="font-mono">{selected.key}</span>, {selected.company} {selected.modelName}
                </span>
              </>
            ) : (
              <span className="text-bad">no {selected.name} key yet, paste one below</span>
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
              className="min-w-0 flex-1 border border-rule bg-surface px-2 py-1"
              placeholder={selected.key ? "paste a different key to replace it" : `paste your ${selected.name} API key`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className="border border-foreground bg-foreground px-3 text-background disabled:opacity-40" disabled={disabled || !draft.trim()}>
              Save key
            </button>
          </form>
          <button className="text-muted underline underline-offset-2" onClick={() => setOpen(false)}>
            close
          </button>
        </span>
      )}
    </span>
  );
}

