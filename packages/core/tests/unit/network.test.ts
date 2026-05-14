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

  it("error message points at the recovery command", () => {
    expect.assertions(2);
    try {
      requireOutboundAllowed("model-download");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkBlockedError);
      expect((err as Error).message).toContain("loctx model download");
    }
  });

  it("error message names the specific model when detail is provided (#140)", () => {
    expect.assertions(3);
    try {
      requireOutboundAllowed("model-download", "Xenova/bge-small-en-v1.5");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkBlockedError);
      const msg = (err as Error).message;
      // Must contain the specific model name so users don't end up
      // running `model download` for the wrong one (the #139 paper cut).
      expect(msg).toContain("Xenova/bge-small-en-v1.5");
      expect(msg).toContain("loctx model download Xenova/bge-small-en-v1.5");
    }
  });
});
