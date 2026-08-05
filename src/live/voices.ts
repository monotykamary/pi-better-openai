export const LIVE_VOICE_OPTIONS = [
  { value: "arbor", label: "Arbor" },
  { value: "breeze", label: "Breeze" },
  { value: "cove", label: "Cove" },
  { value: "ember", label: "Ember" },
  { value: "juniper", label: "Juniper" },
  { value: "maple", label: "Maple" },
  { value: "sol", label: "Sol" },
  { value: "spruce", label: "Spruce" },
  { value: "vale", label: "Vale" },
] as const;

export const LIVE_VOICE_VALUES = LIVE_VOICE_OPTIONS.map(({ value }) => value);

export type LiveVoice = (typeof LIVE_VOICE_OPTIONS)[number]["value"];

export const DEFAULT_LIVE_VOICE: LiveVoice = "sol";

export function isLiveVoice(value: unknown): value is LiveVoice {
  return typeof value === "string" && (LIVE_VOICE_VALUES as readonly string[]).includes(value);
}
