import { afterEach, describe, expect, it } from "vitest";
import {
  NetworkBlockedError,
  requireOutboundAllowed,
  setAllowedOutboundReasons,
} from "../../src/network.js";

afterEach(() => {
  // Reset allowlist between tests so leakage between cases is impossible.
  setAllowedOutboundReasons([]);
});

describe("network outbound guard", () => {
  it("blocks model-download by default", () => {
    expect(() => requireOutboundAllowed("model-download")).toThrow(NetworkBlockedError);
  });

  it("allows model-download once explicitly enabled", () => {
    setAllowedOutboundReasons(["model-download"]);
    expect(() => requireOutboundAllowed("model-download")).not.toThrow();
  });

  it("blocks again after the allowlist is cleared", () => {
    setAllowedOutboundReasons(["model-download"]);
    setAllowedOutboundReasons([]);
    expect(() => requireOutboundAllowed("model-download")).toThrow(NetworkBlockedError);
  });

  it("error message names the reason and points at the recovery command", () => {
    try {
      requireOutboundAllowed("model-download");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkBlockedError);
      expect((err as Error).message).toContain("model-download");
      expect((err as Error).message).toContain("loctx model download");
    }
  });
});
