"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The label text itself is the trigger: a dotted underline that reveals a longer explanation on hover
 * or focus. No box, no "?". Esc hides it (WCAG 1.4.13) and focus stays where it was; the tooltip can be
 * hovered without vanishing.
 *
 * With `forId`, the help belongs to that field: the trigger leaves the tab order (one stop per field,
 * not two), the field carries the text as its description (pass the same `id` in its aria-describedby),
 * and tabbing into the field shows the tooltip above the label so it never covers what is being typed.
 */
export function Help({
  id,
  text,
  children,
  className = "",
  forId,
}: {
  id: string;
  text: string;
  children: ReactNode;
  className?: string;
  forId?: string;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [fieldFocus, setFieldFocus] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (hover || focus || fieldFocus) && !dismissed;

  // Esc hides the tooltip wherever focus is; the next hover or focus brings it back.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Field-linked help opens on keyboard focus only; a click into the field is not asking for it.
  const pointer = useRef(false);
  useEffect(() => {
    if (!forId) return;
    const field = document.getElementById(forId);
    if (!field) return;
    const down = () => {
      pointer.current = true;
    };
    const on = () => {
      if (!pointer.current) {
        setDismissed(false);
        setFieldFocus(true);
      }
      pointer.current = false;
    };
    const off = () => setFieldFocus(false);
    field.addEventListener("pointerdown", down);
    // focusin/focusout so a group (the plan picker) works as well as a single field.
    field.addEventListener("focusin", on);
    field.addEventListener("focusout", off);
    return () => {
      field.removeEventListener("pointerdown", down);
      field.removeEventListener("focusin", on);
      field.removeEventListener("focusout", off);
    };
  }, [forId]);

  const above = fieldFocus && !hover && !focus;

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => {
        setDismissed(false);
        setHover(true);
      }}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-describedby={id}
        tabIndex={forId ? -1 : undefined}
        onFocus={() => {
          setDismissed(false);
          setFocus(true);
        }}
        onBlur={() => setFocus(false)}
        className={`cursor-help text-left underline decoration-dotted decoration-rule-strong decoration-1 underline-offset-4 hover:decoration-foreground focus-visible:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${className}`}
      >
        {children}
      </button>
      {/* The padding bridges the gap to the trigger so the pointer can move onto the tooltip. */}
      <span
        id={id}
        role="tooltip"
        className={`absolute left-0 z-30 w-max max-w-[min(280px,80vw)] ${above ? "bottom-full pb-1.5" : "top-full pt-1.5"} ${open ? "block" : "hidden"}`}
      >
        <span className="block rounded-[3px] border border-rule-strong bg-surface px-3 py-2.5 text-[13.5px] leading-5 font-normal text-foreground">
          {text}
        </span>
      </span>
    </span>
  );
}
