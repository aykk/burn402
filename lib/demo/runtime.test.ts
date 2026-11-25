import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultNetwork } from "./runtime";

describe("defaultNetwork (I3)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is testnet unless BURN402_ARWEAVE_NETWORK is production", () => {
    vi.stubEnv("BURN402_ARWEAVE_NETWORK", "");
    expect(defaultNetwork()).toBe("testnet");
    vi.stubEnv("BURN402_ARWEAVE_NETWORK", "testnet");
    expect(defaultNetwork()).toBe("testnet");
    vi.stubEnv("BURN402_ARWEAVE_NETWORK", "mainnet");
    expect(defaultNetwork()).toBe("testnet");
    vi.stubEnv("BURN402_ARWEAVE_NETWORK", "production");
    expect(defaultNetwork()).toBe("production");
  });
});
