import type {
  RuntimeIntelligenceProfile,
  RuntimeSemanticKind,
  RuntimeVisualizationRule,
} from 'gitnexus-shared';
import type { RuntimeActivityEvent } from '../../services/runtime-client';

export interface RuntimeVisualizationDecision {
  semanticKind: RuntimeSemanticKind;
  animation: 'pulse' | 'ripple' | 'glow';
  durationMs: number;
  edgeAnimation: 'none' | 'flow';
  label?: string;
  ruleId?: string;
}

const matchesRegex = (source: string | undefined, value: string | undefined): boolean => {
  if (!source || !value) return !source;
  try {
    return new RegExp(source, 'i').test(value);
  } catch {
    return false;
  }
};

const matches = (rule: RuntimeVisualizationRule, event: RuntimeActivityEvent): boolean => {
  const match = rule.match;
  if (!match) return true;
  // graphLabel is reserved for a future adapter that receives the resolved
  // static node. Treat persisted legacy/advisor values as non-matching rather
  // than accidentally turning them into catch-all rules.
  if (match.graphLabel) return false;
  return (
    (!match.runtime || match.runtime === event.runtime) &&
    matchesRegex(match.functionRegex, event.functionName) &&
    matchesRegex(match.pathRegex, event.filePath) &&
    matchesRegex(match.detailRegex, event.detail)
  );
};

export function visualizationForRuntimeEvent(
  profile: RuntimeIntelligenceProfile | null,
  event: RuntimeActivityEvent,
): RuntimeVisualizationDecision {
  const rule = (profile?.visualizationRules ?? [])
    .filter((candidate) => candidate.enabled && matches(candidate, event))
    .sort((left, right) => right.priority - left.priority)[0];
  if (rule) {
    return {
      semanticKind: rule.semanticKind,
      animation: rule.animation,
      durationMs: rule.durationMs,
      edgeAnimation: rule.edgeAnimation ?? 'none',
      label: rule.label,
      ruleId: rule.id,
    };
  }
  return {
    semanticKind: event.kind === 'function' ? 'function' : 'process',
    animation: 'pulse',
    durationMs: 700,
    edgeAnimation: 'none',
  };
}
