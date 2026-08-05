import { describe, expect, test } from "vitest";
import {
  buildDelegationContextAppend,
  buildLiveSessionPayload,
  buildSessionClose,
  buildSessionContextAppend,
  CONTEXT_CHUNK_BYTES,
  chunkLiveContext,
  LIVE_MODEL,
  parseLiveServerEvent,
} from "../src/live/protocol.ts";

describe("live server events", () => {
  test("parses delegations and keeps only input text", () => {
    expect(
      parseLiveServerEvent(
        JSON.stringify({
          type: "delegation.created",
          item: {
            type: "delegation",
            target: "client",
            id: "delegation-7",
            content: [
              { type: "input_text", text: "Inspect the failing build. " },
              { type: "output_text", text: "ignored" },
              { type: "input_text", text: "Repair the root cause." },
            ],
          },
        }),
      ),
    ).toEqual({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegation-7",
        content: [
          { type: "input_text", text: "Inspect the failing build. " },
          { type: "input_text", text: "Repair the root cause." },
        ],
      },
    });
  });

  test("parses transcripts, completed turns, audio, and errors", () => {
    expect(
      parseLiveServerEvent({ type: "input_transcript.added", item: { text: "What changed?" } }),
    ).toEqual({
      type: "input_transcript.added",
      item: { text: "What changed?" },
    });
    expect(
      parseLiveServerEvent({
        type: "turn.done",
        turn: { role: "assistant", transcript: "The checks pass." },
      }),
    ).toEqual({ type: "turn.done", turn: { role: "assistant", transcript: "The checks pass." } });
    expect(parseLiveServerEvent('{"type":"output_audio.delta","audio":"AAECAw=="}')).toEqual({
      type: "output_audio.delta",
      audio: "AAECAw==",
    });
    expect(parseLiveServerEvent({ type: "error", error: { message: "media rejected" } })).toEqual({
      type: "error",
      message: "media rejected",
    });
  });

  test("classifies unknown events and rejects malformed known events", () => {
    expect(parseLiveServerEvent({ type: "rate_limits.updated", remaining: 3 })).toEqual({
      type: "unknown",
      wireType: "rate_limits.updated",
    });
    expect(parseLiveServerEvent({ type: "output_audio.delta", audio: 12 })).toBeNull();
    expect(
      parseLiveServerEvent({ type: "turn.done", turn: { role: "tool", transcript: "no" } }),
    ).toBeNull();
    expect(parseLiveServerEvent("not json")).toBeNull();
  });
});

describe("live client payloads", () => {
  test("builds the exact session and context JSON", () => {
    expect(LIVE_MODEL).toBe("gpt-live-1-codex");
    expect(JSON.stringify(buildLiveSessionPayload("Be concise.", "sol"))).toBe(
      '{"model":"gpt-live-1-codex","instructions":"Be concise.","audio":{"output":{"voice":"sol"}},"delegation":{"type":"client"}}',
    );
    expect(
      JSON.stringify(buildDelegationContextAppend("delegation-7", "Tests pass.", "commentary")),
    ).toBe(
      '{"type":"delegation.context.append","delegation_item_id":"delegation-7","channel":"commentary","content":[{"type":"input_text","text":"Tests pass."}]}',
    );
  });

  test("omits optional channels and builds session close", () => {
    expect(buildDelegationContextAppend("delegation-8", "Done.")).toEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-8",
      content: [{ type: "input_text", text: "Done." }],
    });
    expect(buildSessionContextAppend("Investigating.", "speakable")).toEqual({
      type: "session.context.append",
      channel: "speakable",
      content: [{ type: "input_text", text: "Investigating." }],
    });
    expect(buildSessionClose()).toEqual({ type: "session.close" });
  });

  test("chunks context on UTF-8 boundaries and perfectly reassembles it", () => {
    const text = `${"a".repeat(497)}🙂${"é漢🙂".repeat(180)}`;
    const chunks = chunkLiveContext(text);
    const encoder = new TextEncoder();
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(encoder.encode(chunk).byteLength).toBeLessThanOrEqual(CONTEXT_CHUNK_BYTES);
    }
  });
});
