import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  defaultIsProcessAlive,
  LIVE_QUEUE_STALE_MS,
  LiveFloorArbiter,
  liveQueueLabel,
  type LiveActivationCause,
  type LiveFloorPolicy,
} from "../src/live/queue.ts";

type ArbiterEvents = {
  activations: LiveActivationCause[];
  deactivations: number;
};

function makeHarness(initialTime = 1_000_000) {
  const directory = mkdtempSync(join(tmpdir(), "pi-live-queue-"));
  let currentTime = initialTime;
  const alivePids = new Set<number>();
  const make = (
    pid: number,
    sessionId: string,
    policy: LiveFloorPolicy,
  ): { arbiter: LiveFloorArbiter; events: ArbiterEvents } => {
    alivePids.add(pid);
    const events: ArbiterEvents = { activations: [], deactivations: 0 };
    const arbiter = new LiveFloorArbiter(
      {
        pid,
        sessionId,
        cwd: "/worktrees/alpha",
        policy,
        directory,
        now: () => currentTime,
        isProcessAlive: (candidate) => alivePids.has(candidate),
      },
      {
        onActivated: (cause) => events.activations.push(cause),
        onDeactivated: () => {
          events.deactivations += 1;
        },
      },
    );
    return { arbiter, events };
  };
  return {
    directory,
    make,
    kill: (pid: number) => alivePids.delete(pid),
    advance: (ms: number) => {
      currentTime += ms;
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const harnesses: Array<{ cleanup(): void }> = [];
function harness(initialTime?: number) {
  const h = makeHarness(initialTime);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()!.cleanup();
});

describe("LiveFloorArbiter", () => {
  test("claims a vacant floor on join when focus is unknown", () => {
    const h = harness();
    const alpha = h.make(1001, "session-a", "focus");
    alpha.arbiter.join();

    expect(alpha.arbiter.hasFloor).toBe(true);
    expect(alpha.events.activations).toEqual(["background"]);
  });

  test("grants the floor to the oldest member only under fifo", () => {
    const h = harness();
    const alpha = h.make(1001, "session-a", "fifo");
    alpha.arbiter.join();
    h.advance(50);
    const beta = h.make(1002, "session-b", "fifo");
    beta.arbiter.join();

    expect(alpha.arbiter.hasFloor).toBe(true);
    expect(beta.arbiter.hasFloor).toBe(false);
    expect(beta.events.activations).toEqual([]);

    alpha.arbiter.leave();
    beta.arbiter.tick();
    expect(beta.arbiter.hasFloor).toBe(true);
    expect(beta.events.activations).toEqual(["fifo"]);
    expect(alpha.events.deactivations).toBe(1);
  });

  test("a focused challenger preempts the holder, which steps down on its next tick", () => {
    const h = harness();
    const alpha = h.make(1001, "session-a", "focus");
    alpha.arbiter.join();
    expect(alpha.arbiter.hasFloor).toBe(true);

    const beta = h.make(1002, "session-b", "focus");
    beta.arbiter.join();
    expect(beta.arbiter.hasFloor).toBe(false);

    // Merely joining does not preempt — only a real focus edge does.
    beta.arbiter.tick();
    expect(beta.arbiter.hasFloor).toBe(false);

    beta.arbiter.setFocused(true);
    expect(beta.arbiter.hasFloor).toBe(true);
    expect(beta.events.activations).toEqual(["focus"]);

    alpha.arbiter.tick();
    expect(alpha.arbiter.hasFloor).toBe(false);
    expect(alpha.events.deactivations).toBe(1);
  });

  test("losing focus never yields the floor", () => {
    const h = harness();
    const alpha = h.make(1001, "session-a", "focus");
    alpha.arbiter.join();
    alpha.arbiter.setFocused(false);
    alpha.arbiter.tick();

    expect(alpha.arbiter.hasFloor).toBe(true);
    expect(alpha.events.deactivations).toBe(0);
  });

  test("reclaims the floor from a crashed holder", () => {
    const h = harness();
    mkdirSync(join(h.directory, "members"), { recursive: true });
    const deadPid = 987_654;
    writeFileSync(
      join(h.directory, "members", `${deadPid}-ghost.json`),
      JSON.stringify({
        id: `${deadPid}-ghost`,
        pid: deadPid,
        sessionId: "ghost",
        label: "ghost",
        joinedAt: 1,
        heartbeatAt: 1,
      }),
    );
    writeFileSync(
      join(h.directory, "floor.json"),
      JSON.stringify({ holderId: `${deadPid}-ghost`, pid: deadPid, token: "old", claimedAt: 1 }),
    );

    const alpha = h.make(1001, "session-a", "fifo");
    alpha.arbiter.join();

    expect(alpha.arbiter.hasFloor).toBe(true);
    expect(alpha.events.activations).toEqual(["fifo"]);
    const remaining = readdirSync(join(h.directory, "members"));
    expect(remaining.some((file) => file.includes("ghost"))).toBe(false);
  });

  test("sweeps members whose heartbeats went stale", () => {
    const h = harness();
    const beta = h.make(1002, "session-b", "fifo");
    beta.arbiter.join();

    const alpha = h.make(1001, "session-a", "fifo");
    h.advance(LIVE_QUEUE_STALE_MS + 1);
    alpha.arbiter.join();

    expect(alpha.arbiter.hasFloor).toBe(true);
    const remaining = readdirSync(join(h.directory, "members"));
    expect(remaining).toHaveLength(1);
  });

  test("removes corrupt member files during sweep", () => {
    const h = harness();
    mkdirSync(join(h.directory, "members"), { recursive: true });
    const corruptPath = join(h.directory, "members", "corrupt.json");
    writeFileSync(corruptPath, "{not json");

    const alpha = h.make(1001, "session-a", "fifo");
    alpha.arbiter.join();

    expect(alpha.arbiter.hasFloor).toBe(true);
    expect(readdirSync(join(h.directory, "members"))).toHaveLength(1);
  });

  test("refreshes its heartbeat so a fresh floor is not reclaimed", () => {
    const h = harness();
    const alpha = h.make(1001, "session-a", "fifo");
    alpha.arbiter.join();
    h.advance(LIVE_QUEUE_STALE_MS * 2);
    alpha.arbiter.tick();

    const beta = h.make(1002, "session-b", "fifo");
    beta.arbiter.join();

    expect(alpha.arbiter.hasFloor).toBe(true);
    expect(beta.arbiter.hasFloor).toBe(false);

    const memberFile = readdirSync(join(h.directory, "members")).find((file) =>
      file.includes("session-a"),
    )!;
    const heartbeat = JSON.parse(
      readFileSync(join(h.directory, "members", memberFile), "utf8"),
    ) as { heartbeatAt: number };
    expect(heartbeat.heartbeatAt).toBeGreaterThan(1_000_000 + LIVE_QUEUE_STALE_MS);
  });

  test("leave removes both the member file and the floor claim", () => {
    const h = harness();
    const alpha = h.make(1001, "session-a", "fifo");
    alpha.arbiter.join();
    expect(alpha.arbiter.hasFloor).toBe(true);

    alpha.arbiter.leave();

    expect(alpha.arbiter.hasFloor).toBe(false);
    expect(alpha.events.deactivations).toBe(1);
    expect(readdirSync(join(h.directory, "members"))).toHaveLength(0);
  });
});

describe("live queue helpers", () => {
  test("defaultIsProcessAlive distinguishes live and dead pids", () => {
    expect(defaultIsProcessAlive(process.pid)).toBe(true);
    expect(defaultIsProcessAlive(2 ** 22 + 12345)).toBe(false);
    expect(defaultIsProcessAlive(-1)).toBe(false);
  });

  test("liveQueueLabel compresses cwd and session id", () => {
    expect(liveQueueLabel("/worktrees/api-refactor", "session-123456789")).toBe(
      "api-refactor · session-",
    );
    expect(liveQueueLabel("/", "ab")).toBe("/ · ab");
  });
});
