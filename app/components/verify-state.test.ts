import { describe, expect, it } from "vitest";
import { isUnreachable } from "./verify-state";

describe("isUnreachable", () => {
  it("fetch step with a bare network error is unreachable", () => {
    expect(isUnreachable({ name: "verdict record", detail: "fetch failed" })).toBe(true);
  });
  it("fetch step with an HTTP error is unreachable", () => {
    expect(isUnreachable({ name: "arweave item", detail: "fetch https://x/y: HTTP 504" })).toBe(true);
  });
  it("signature step is never unreachable", () => {
    expect(isUnreachable({ name: "verdict signature", detail: "timed out" })).toBe(false);
    expect(isUnreachable({ name: "record signature", detail: "fetch failed" })).toBe(false);
  });
  it("fetch step with extra text is not unreachable", () => {
    expect(isUnreachable({ name: "verdict record", detail: "signature bad; timed out" })).toBe(false);
  });
});
