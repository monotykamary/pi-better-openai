import type { AutocompleteItem } from "@earendil-works/pi-tui";

const TIERS: AutocompleteItem[] = [
  { value: "standard", label: "standard", description: "Use the standard service tier" },
  { value: "fast", label: "fast", description: "Request priority processing" },
  {
    value: "ultrafast",
    label: "ultrafast",
    description: "Astra/Sol; API keys or subscription OAuth; API pricing 6x Standard",
  },
];

const DECISIONS: AutocompleteItem[] = [
  { value: "models", label: "models", description: "List registered native classifiers" },
  { value: "use ", label: "use", description: "Select a classifier and enable the decision tool" },
  { value: "off", label: "off", description: "Disable the optional decision tool" },
];

function matching(items: AutocompleteItem[], prefix: string): AutocompleteItem[] | null {
  const matches = items.filter((item) => item.value.startsWith(prefix));
  return matches.length ? matches : null;
}

export function openAITierArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  return matching(TIERS, prefix.trimStart().toLowerCase());
}

export function openAIDecisionsArgumentCompletions(
  prefix: string,
  getClassifiers: () => readonly { provider: string; id: string; name?: string }[],
): AutocompleteItem[] | null {
  const normalized = prefix.trimStart();
  const use = /^use\s+(\S*)$/i.exec(normalized);
  if (!use) return matching(DECISIONS, normalized.toLowerCase());
  const items = getClassifiers()
    .map((model) => {
      const key = `${model.provider}/${model.id}`;
      return {
        value: `use ${key}`,
        label: key,
        description: model.name ?? "Registered classifier; credentials and entitlement required",
      };
    })
    .sort((a, b) => a.value.localeCompare(b.value));
  return matching(items, `use ${use[1]}`);
}
