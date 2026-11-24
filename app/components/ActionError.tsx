"use client";

import { TEXT_BTN } from "./ui";

/** Every action on the Run page posts through this; it resolves to null on success or to the reason it failed. */
export type Post = (path: string, body?: unknown) => Promise<string | null>;

/** Shown when a request never reached the server (browsers word that failure differently, so it is not passed through). */
export const UNREACHABLE = "The demo server didn't answer. Check that npm run dev is still running, then try again.";

/** A failed request in one sentence: a network failure names the server; anything else keeps the server's own words. */
export function failureMessage(e: unknown): string {
  if (e instanceof TypeError) return UNREACHABLE;
  if (e instanceof SyntaxError) return "The demo server sent back a reply it couldn't read. Check the terminal running npm run dev.";
  return (e as Error)?.message || "Something went wrong.";
}

const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const period = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);

/**
 * An action's failure, shown next to the control that caused it. It stays until it is dismissed
 * or the action is tried again; the 1.5s state poll never clears it.
 */
export function ActionError({ what, message, onDismiss }: { what: string; message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex max-w-[64ch] flex-wrap items-baseline gap-x-3 gap-y-1">
      <p className="min-w-0 break-words text-bad">
        <span className="font-medium">{what}.</span> {period(sentence(message))}
      </p>
      <button type="button" className={`shrink-0 text-[12px] leading-4 ${TEXT_BTN}`} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
