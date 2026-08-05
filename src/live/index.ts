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
import { LiveVisualizer, LIVE_VISUALIZER_TOGGLE_KEY } from "./visualizer.ts";

export const LIVE_COMMAND = "live";
export const LIVE_DELEGATION_MESSAGE_TYPE = "better-openai-live-delegation";

interface LiveSessionRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  toggleMute(): void;
  handleAgentMessage(message: unknown): void;
  handleAgentSettled(): void;
}

interface ActiveLiveRun {
  session: LiveSessionRuntime;
  finishUi(result: LiveUiResult): void;
}

type LiveUiResult = { error?: Error };

type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionRuntime;

export interface LiveRegistrationDependencies {
  createSession?: LiveSessionFactory;
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

export function registerOpenAILive(
  pi: ExtensionAPI,
  getConfig: (ctx: ExtensionContext) => ResolvedConfig,
  dependencies: LiveRegistrationDependencies = {},
): { isActive(): boolean; stop(): Promise<void> } {
  const createSession =
    dependencies.createSession ?? ((options) => new LiveSessionController(options));
  let activeRun: ActiveLiveRun | undefined;
  let settling: Promise<void> | undefined;

  async function stopRun(run: ActiveLiveRun): Promise<void> {
    run.finishUi({});
    await run.session.stop();
  }

  async function stopActive(): Promise<void> {
    const run = activeRun;
    if (!run) {
      if (settling) await settling;
      return;
    }
    await stopRun(run);
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
      let session: LiveSessionRuntime;
      const finishUi = (value: LiveUiResult) => {
        if (completed) return;
        completed = true;
        done(value);
      };
      const visualizer = new LiveVisualizer({
        theme,
        requestRender: () => tui.requestRender(),
        onStop: () => finishUi({}),
        onToggleMute: () => session.toggleMute(),
      });
      const updateTranscript = (transcript: LiveTranscript | undefined) => {
        visualizer.setTranscript(transcript);
      };
      session = createSession({
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
          onTranscript: updateTranscript,
          onTerminal: (error) => finishUi(error ? { error } : {}),
        },
      });
      activeRun = { session, finishUi };
      setImmediate(() => {
        void session.start().catch((cause) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          finishUi({ error });
        });
      });
      return visualizer;
    });

    const run = activeRun;
    if (run) {
      const cleanup = stopRun(run).catch(() => undefined);
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
    activeRun?.session.handleAgentMessage(event.message);
  });

  pi.on("agent_settled", () => {
    activeRun?.session.handleAgentSettled();
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
