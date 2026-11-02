import type { TSchema } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface OptionalTool {
  setEnabled(enabled: boolean): void;
}

/** Hidden exposure withdraws both native calls and Fabric capture, unlike deactivation alone. */
export function registerOptionalTool<TParams extends TSchema, TDetails>(
  pi: ExtensionAPI,
  definition: ToolDefinition<TParams, TDetails>,
): OptionalTool {
  let enabled: boolean | undefined;
  const tool: OptionalTool = {
    setEnabled(next) {
      if (enabled === next) return;
      pi.registerTool({
        ...definition,
        exposure: next ? (definition.exposure ?? "direct") : "hidden",
      });
      enabled = next;
    },
  };
  // The factory has no session cwd yet. Stay unreachable until config is resolved.
  tool.setEnabled(false);
  return tool;
}
