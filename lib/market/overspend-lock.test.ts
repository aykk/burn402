import { describe, expect, it } from "vitest";
import { overspendRunning, takeOverspendLock } from "./overspend-lock";

describe("overspend lock", () => {
  it("is held by one caller at a time and released once", () => {
    expect(overspendRunning()).toBe(false);
    const release = takeOverspendLock();
    expect(release).not.toBeNull();
    expect(overspendRunning()).toBe(true);
    expect(takeOverspendLock()).toBeNull();

    release!();
    expect(overspendRunning()).toBe(false);
    const again = takeOverspendLock();
    expect(again).not.toBeNull();
    release!(); // a stale release must not free the new holder
    expect(overspendRunning()).toBe(true);
    again!();
    expect(overspendRunning()).toBe(false);
  });
});
