/** Transient presentation visibility for the Better OpenAI footer.
 *
 * Veil/privacy primitive: hides all Better OpenAI footer pixels (status +
 * widget + replace-footer incl. pets) without touching usage fetching.
 * Always starts visible; never persisted to config.
 */

export type PresentationAction = "hide" | "show" | "toggle";

export interface ParsedPresentationAction {
  action: PresentationAction;
  /** False when input was missing/unknown and we fell back to toggle. */
  valid: boolean;
}

export interface PresentationState {
  visible: boolean;
}

export function createPresentationState(): PresentationState {
  return { visible: true };
}

/** Parse raw command input. Missing/unknown input falls back to toggle. */
export function parsePresentationAction(raw: unknown): ParsedPresentationAction {
  if (typeof raw !== "string") return { action: "toggle", valid: raw === undefined };
  const arg = raw.trim().toLowerCase();
  if (arg === "") return { action: "toggle", valid: true };
  if (arg === "hide" || arg === "hidden" || arg === "off") return { action: "hide", valid: true };
  if (arg === "show" || arg === "shown" || arg === "on") return { action: "show", valid: true };
  if (arg === "toggle") return { action: "toggle", valid: true };
  return { action: "toggle", valid: false };
}

export function resolvePresentationVisible(
  action: PresentationAction,
  currentVisible: boolean,
): boolean {
  if (action === "hide") return false;
  if (action === "show") return true;
  return !currentVisible;
}
