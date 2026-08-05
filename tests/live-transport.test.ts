import { describe, expect, test } from "vitest";
import { buildLiveHeaders, buildLiveSidebandUrl, parseLiveCallId } from "../src/live/transport.ts";

describe("live transport helpers", () => {
  test("extracts only rtc call IDs and builds an encoded sideband URL", () => {
    expect(parseLiveCallId("https://api.openai.com/v1/live/rtc_call-7?foo=bar")).toBe("rtc_call-7");
    expect(parseLiveCallId("https://example.com/live/not-a-call")).toBeUndefined();
    expect(buildLiveSidebandUrl("rtc_call-7")).toBe("wss://api.openai.com/v1/live/rtc_call-7");
  });

  test("builds the Codex Desktop headers required by signaling and sideband", () => {
    const headers = buildLiveHeaders(
      { accessToken: "secret-token", accountId: "acct_test" },
      "pi-session",
      "realtime-session",
      "attestation",
    );
    expect(headers).toMatchObject({
      Authorization: "Bearer secret-token",
      "OpenAI-Alpha": "quicksilver=v2",
      "x-session-id": "realtime-session",
      "session-id": "pi-session",
      "thread-id": "pi-session",
      "chatgpt-account-id": "acct_test",
      "x-oai-attestation": "attestation",
      originator: "Codex Desktop",
    });
  });
});
