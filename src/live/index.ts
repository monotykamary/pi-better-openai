import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getCodexCredentials } from "../codex-auth.ts";
import type { ResolvedConfig } from "../config.ts";
import { sanitizeDiagnosticError } from "../format.ts";
import {
  LiveSessionController,
  type LiveSessionControllerOptions,
  type LiveTranscript,
} from "./controller.ts";
import { attachFocusReporting, probeFocusReporting, type FocusTerminalHandle } from "./focus.ts";
import {
  LIVE_QUEUE_TICK_MS,
  LiveFloorArbiter,
  type LiveActivationCause,
  type LiveFloorArbiterCallbacks,
  type LiveFloorArbiterLike,
  type LiveFloorArbiterOptions,
} from "./queue.ts";
import { LiveVisualizer, LIVE_VISUALIZER_TOGGLE_KEY } from "./visualizer.ts";

export const LIVE_COMMAND = "live";
export const LIVE_DELEGATION_MESSAGE_TYPE = "better-openai-live-delegation";
export const LIVE_FOCUS_SETTLE_MS = 400;

interface LiveSessionRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  toggleMute(): void;
  handleAgentMessage(message: unknown): void;
  handleAgentSettled(): void;
}

// An enrollment outlives any single realtime session: `/live` opens the
// visualizer and joins the cross-process queue, then the arbiter activates
// (creates the actual mic + WebRTC session) and parks (stops it) as the floor
// comes and goes. Only the floor holder runs a realtime session at all, so a
// dozen enrolled windows cost zero open connections while standby.
interface ActiveLiveRun {
  getSession(): LiveSessionRuntime | undefined;
  finishUi(result: LiveUiResult): void;
  dispose(): Promise<void>;
}

type LiveUiResult = { error?: Error };

type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionRuntime;

type LiveArbiterFactory = (
  options: LiveFloorArbiterOptions,
  callbacks: LiveFloorArbiterCallbacks,
) => LiveFloorArbiterLike;

export interface LiveRegistrationDependencies {
  createSession?: LiveSessionFactory;
  createArbiter?: LiveArbiterFactory;
  probeFocusReporting?: typeof probeFocusReporting;
  attachFocusReporting?: typeof attachFocusReporting;
  notifyActivatedUnfocused?: (handle: FocusTerminalHandle, label: string) => void;
  tickMs?: number;
}

// eslint-disable-next-line no-control-regex -- OSC payloads must not carry raw control characters; matching them is the point
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/g;

export function notifyActivatedUnfocused(handle: FocusTerminalHandle, label: string): void {
  // OSC 9 desktop toast. Reaching this branch means the mic went hot in a
  // window the user is not typing into (FIFO promotion or a vacant-floor
  // background claim), so the toast is the only signal that it happened.
  const safeLabel = label.replace(CONTROL_CHARACTER_PATTERN, " ").trim();
  try {
    handle.write(`\x1b]9;Live voice is now active in ${safeLabel}\x07`);
  } catch {
    // Notification support is optional and terminal-dependent.
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function registerOpenAILive(
  pi: ExtensionAPI,
  getConfig: (ctx: ExtensionContext) => ResolvedConfig,
  dependencies: LiveRegistrationDependencies = {},
): { isActive(): boolean; stop(): Promise<void> } {
  const createSession =
    dependencies.createSession ?? ((options) => new LiveSessionController(options));
  const createArbiter: LiveArbiterFactory =
    dependencies.createArbiter ??
    ((options, callbacks) => new LiveFloorArbiter(options, callbacks));
  const probeFocus = dependencies.probeFocusReporting ?? probeFocusReporting;
  const attachFocus = dependencies.attachFocusReporting ?? attachFocusReporting;
  const notifyUnfocused = dependencies.notifyActivatedUnfocused ?? notifyActivatedUnfocused;
  const tickMs = dependencies.tickMs ?? LIVE_QUEUE_TICK_MS;
  let activeRun: ActiveLiveRun | undefined;
  let settling: Promise<void> | undefined;

  async function stopActive(): Promise<void> {
    const run = activeRun;
    if (!run) {
      if (settling) await settling;
      return;
    }
    run.finishUi({});
    await run.dispose();
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Live voice requires interactive TUI mode.", "warning");
      return;
    }
    const cfg = getConfig(ctx);
    if (!cfg.live.enabled) {
      ctx.ui.notify("Live voice is disabled. Enable it in /openai-settings.", "warning");
      return;
    }
    if (settling) await settling;

    const result = await ctx.ui.custom<LiveUiResult>((tui, theme, _keybindings, done) => {
      let completed = false;
      let disposed = false;
      let session: LiveSessionRuntime | undefined;
      let sessionParked = false;
      let arbiter: LiveFloorArbiterLike | undefined;
      let tickInterval: NodeJS.Timeout | undefined;
      let focusDebounce: NodeJS.Timeout | undefined;
      let disposeFocus: (() => void) | undefined;

      const finishUi = (value: LiveUiResult) => {
        if (completed) return;
        completed = true;
        done(value);
      };

      const visualizer = new LiveVisualizer({
        theme,
        requestRender: () => tui.requestRender(),
        onStop: () => finishUi({}),
        onToggleMute: () => session?.toggleMute(),
      });
      visualizer.setPhase("standby");

      const terminalHandle: FocusTerminalHandle = {
        write: (data) => tui.terminal.write(data),
        addInputListener: (listener) => tui.addInputListener(listener),
      };

      const parkSession = () => {
        const current = session;
        session = undefined;
        sessionParked = true;
        visualizer.setPhase("standby");
        visualizer.setTranscript(undefined);
        if (current) void current.stop().catch(() => undefined);
      };

      const activateSession = () => {
        if (completed || session) return;
        sessionParked = false;
        const created = createSession({
          sessionId: ctx.sessionManager.getSessionId(),
          voice: cfg.live.voice,
          getCredentials: (signal) => getCodexCredentials(ctx, signal),
          delegate: (request) => {
            pi.sendMessage(
              {
                customType: LIVE_DELEGATION_MESSAGE_TYPE,
                content: request,
                display: true,
                details: { source: "live" },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          },
          callbacks: {
            onPhase: (phase) => visualizer.setPhase(phase),
            onLevels: (input) => visualizer.setInputLevel(input),
            onTranscript: (transcript: LiveTranscript | undefined) =>
              visualizer.setTranscript(transcript),
            onTerminal: (error) => {
              if (sessionParked) return;
              finishUi(error ? { error } : {});
            },
          },
        });
        session = created;
        setImmediate(() => {
          if (session !== created) return;
          void created.start().catch((cause) => {
            finishUi({ error: errorFrom(cause) });
          });
        });
      };

      const dispose = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        if (focusDebounce) clearTimeout(focusDebounce);
        if (tickInterval) clearInterval(tickInterval);
        disposeFocus?.();
        arbiter?.leave();
        const current = session;
        session = undefined;
        if (current) await current.stop().catch(() => undefined);
      };

      const run: ActiveLiveRun = {
        getSession: () => session,
        finishUi,
        dispose,
      };
      activeRun = run;

      setImmediate(() => {
        void (async () => {
          try {
            const focusSupported = await probeFocus(terminalHandle);
            if (completed) return;
            const enrolled = createArbiter(
              {
                pid: process.pid,
                sessionId: ctx.sessionManager.getSessionId(),
                cwd: ctx.cwd,
                policy: focusSupported ? "focus" : "fifo",
              },
              {
                onActivated: (cause: LiveActivationCause) => {
                  if (cause !== "focus") notifyUnfocused(terminalHandle, enrolled.label);
                  activateSession();
                },
                onDeactivated: parkSession,
              },
            );
            arbiter = enrolled;
            enrolled.join();
            tickInterval = setInterval(() => {
              try {
                enrolled.tick();
              } catch {
                // A failing tick must not tear down the enrollment.
              }
            }, tickMs);
            tickInterval.unref?.();
            if (!focusSupported) return;
            disposeFocus = attachFocus(terminalHandle, (focused) => {
              if (focusDebounce) clearTimeout(focusDebounce);
              if (!focused) {
                enrolled.setFocused(false);
                return;
              }
              // Debounce focus-in so window-manager focus flicker does not flap
              // floor ownership between two live windows.
              focusDebounce = setTimeout(() => {
                focusDebounce = undefined;
                try {
                  enrolled.setFocused(true);
                } catch {
                  // Focus edges are advisory; a lost race settles next tick.
                }
              }, LIVE_FOCUS_SETTLE_MS);
              focusDebounce.unref?.();
            });
          } catch (cause) {
            finishUi({ error: errorFrom(cause) });
          }
        })();
      });

      return visualizer;
    });

    const run = activeRun;
    if (run) {
      const cleanup = run.dispose().catch(() => undefined);
      settling = cleanup;
      await cleanup;
      if (activeRun === run) activeRun = undefined;
      if (settling === cleanup) settling = undefined;
    }
    if (result.error) ctx.ui.notify(sanitizeDiagnosticError(result.error.message), "error");
  }

  async function toggle(ctx: ExtensionContext): Promise<void> {
    if (activeRun) {
      activeRun.finishUi({});
      return;
    }
    await start(ctx);
  }

  pi.registerMessageRenderer(LIVE_DELEGATION_MESSAGE_TYPE, (message, _options, theme) => {
    const text = messageText(message.content).trim();
    const label = theme.fg("accent", theme.bold("Live request"));
    return new Text(`${label}\n${theme.fg("customMessageText", text)}`, 1, 0);
  });

  pi.registerCommand(LIVE_COMMAND, {
    description: "Start or stop Codex-backed realtime voice mode",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /live", "error");
        return;
      }
      await toggle(ctx);
    },
  });

  pi.registerShortcut(LIVE_VISUALIZER_TOGGLE_KEY, {
    description: "Start or stop Better OpenAI live voice mode",
    handler: toggle,
  });

  pi.on("message_end", (event) => {
    activeRun?.getSession()?.handleAgentMessage(event.message);
  });

  pi.on("agent_settled", () => {
    activeRun?.getSession()?.handleAgentSettled();
  });

  pi.on("session_shutdown", async () => {
    await stopActive();
    activeRun = undefined;
  });

  return {
    isActive: () => activeRun !== undefined || settling !== undefined,
    stop: stopActive,
  };
}
