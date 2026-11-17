import { describe, expect, it } from "vitest";
import { servedSource } from "./model";
import { LOCAL_RELAY_ORIGIN, localRelayOrigin } from "./wire/relay";

describe("loopback relay bootstrap", () => {
  it("preserves the default and canonicalizes explicit ports", () => {
    expect(localRelayOrigin()).toBe(LOCAL_RELAY_ORIGIN);
    expect(localRelayOrigin("")).toBe(LOCAL_RELAY_ORIGIN);
    expect(localRelayOrigin("80")).toBe("http://127.0.0.1");
    expect(localRelayOrigin("17391")).toBe("http://127.0.0.1:17391");
    expect(localRelayOrigin("0")).toBe("http://127.0.0.1:0");
  });

  it("uses the configured endpoint for model sources without discovering credentials", () => {
    expect(
      servedSource(
        {
          upstream: { kind: "codex", transport: "ws" },
          choice: { upstream: "codex", model: "test-model" },
        },
        localRelayOrigin("17391"),
      ).baseUrl,
    ).toBe("http://127.0.0.1:17391/codex/v1");
  });

  it.each(["-1", "65536", "1.5", "localhost:7391", "7391/path", " "])(
    "rejects invalid port %s without changing the loopback host",
    (port) => expect(() => localRelayOrigin(port)).toThrow("ROOK_RELAY_PORT"),
  );
});
