const RUNTIME_ACTION_MARKER = /\[\[runtime-action:(runtime-[a-f0-9]{16})\]\]/g;

export interface RuntimeActionMarkerResult {
  content: string;
  actionIds: string[];
}

/** Extract trusted-looking runtime action IDs without interpreting fenced examples. */
export function extractRuntimeActionMarkers(content: string): RuntimeActionMarkerResult {
  const actionIds: string[] = [];
  const seen = new Set<string>();
  const parts = content.split('```');

  for (let index = 0; index < parts.length; index += 2) {
    parts[index] = parts[index].replace(RUNTIME_ACTION_MARKER, (_marker, actionId: string) => {
      if (!seen.has(actionId)) {
        seen.add(actionId);
        actionIds.push(actionId);
      }
      return '';
    });
  }

  return {
    content: parts
      .join('```')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    actionIds,
  };
}
