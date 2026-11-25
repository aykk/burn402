/**
 * One overspend test at a time, and no new purchase while it runs (the test sets the test seller's
 * faults, which a purchase on the test market would see). Kept on globalThis so every route shares it.
 */

export const OVERSPEND_BUSY = "The overspend test is running. Try again when it finishes.";

type Lock = { running: boolean };
const lock = ((globalThis as unknown as { __burn402OverspendLock?: Lock }).__burn402OverspendLock ??= { running: false });

export function overspendRunning(): boolean {
  return lock.running;
}

/** Takes the lock and returns its release, or null when the test is already running. Synchronous. */
export function takeOverspendLock(): (() => void) | null {
  if (lock.running) return null;
  lock.running = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lock.running = false;
  };
}
