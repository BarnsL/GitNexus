import type {
  RuntimeAdvisorDecision,
  RuntimeEvidence,
  RuntimeIntelligenceProfile,
  RuntimeLaunchCommand,
  RuntimeTracePlan,
} from 'gitnexus-shared';

const clamp = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

const aiEvidence = (confidence: number): RuntimeEvidence => ({
  source: 'ai',
  detail: 'Runtime advisor reviewed this component',
  confidence,
});

const mergedEvidence = (
  deterministic: RuntimeEvidence[],
  advisor: RuntimeEvidence[],
): RuntimeEvidence[] => [...deterministic, ...advisor].slice(0, 64);

const mergeLaunchCommands = (
  deterministic: RuntimeLaunchCommand[],
  advisor: RuntimeLaunchCommand[],
): RuntimeLaunchCommand[] => {
  const commands = new Map(
    deterministic.map((item) => [JSON.stringify([item.command, item.cwd ?? '', item.role]), item]),
  );
  for (const item of advisor) {
    const key = JSON.stringify([item.command, item.cwd ?? '', item.role]);
    const existing = commands.get(key);
    commands.set(key, {
      ...existing,
      ...item,
      evidence: mergedEvidence(existing?.evidence ?? [], item.evidence),
    });
  }
  return [...commands.values()].slice(0, 16);
};

const mergeTracePlans = (
  deterministic: RuntimeTracePlan[],
  advisor: RuntimeTracePlan[],
): RuntimeTracePlan[] => {
  const plans = new Map(deterministic.map((item) => [item.tracer, item]));
  for (const item of advisor) {
    const existing = plans.get(item.tracer);
    plans.set(item.tracer, {
      ...existing,
      ...item,
      evidence: mergedEvidence(existing?.evidence ?? [], item.evidence),
    });
  }
  return [...plans.values()].slice(0, 16);
};

const advisorId = (id: string): string => (id.startsWith('ai:') ? id : `ai:${id}`);

export function mergeRuntimeAdvisorDecision(
  base: RuntimeIntelligenceProfile,
  decision: RuntimeAdvisorDecision,
): RuntimeIntelligenceProfile {
  const updates = new Map(
    (decision.componentUpdates ?? []).map((item) => [item.componentId, item]),
  );
  const components = base.components.map((component) => {
    const update = updates.get(component.id);
    if (!update) return component;
    const confidence = clamp(update.confidence, component.confidence);
    return {
      ...component,
      ...(update.framework ? { framework: update.framework } : {}),
      ...(update.kind ? { kind: update.kind } : {}),
      ...(update.entrypoints
        ? {
            entrypoints: [...new Set([...component.entrypoints, ...update.entrypoints])].slice(
              0,
              32,
            ),
          }
        : {}),
      ...(update.launch ? { launch: mergeLaunchCommands(component.launch, update.launch) } : {}),
      ...(update.trace ? { trace: mergeTracePlans(component.trace, update.trace) } : {}),
      confidence,
      evidence: mergedEvidence(component.evidence, [
        ...(update.evidence ?? []),
        aiEvidence(confidence),
      ]),
    };
  });

  const rules = new Map(base.visualizationRules.map((rule) => [rule.id, rule]));
  for (const rule of decision.visualizationRules ?? []) {
    const id = advisorId(rule.id);
    const existingAdvisorRule = rules.get(id);
    rules.set(id, {
      ...existingAdvisorRule,
      ...rule,
      id,
      evidence: mergedEvidence(existingAdvisorRule?.evidence ?? [], rule.evidence),
    });
  }
  const hypotheses = new Map(base.hypotheses.map((item) => [item.id, item]));
  for (const hypothesis of decision.hypotheses ?? []) {
    const id = advisorId(hypothesis.id);
    const existingAdvisorHypothesis = hypotheses.get(id);
    hypotheses.set(id, {
      ...existingAdvisorHypothesis,
      ...hypothesis,
      id,
      evidence: mergedEvidence(existingAdvisorHypothesis?.evidence ?? [], hypothesis.evidence),
    });
  }

  return {
    ...base,
    updatedAt: Date.now(),
    generation: base.generation + 1,
    source: 'heuristic+ai',
    needsAiReview: false,
    confidence: clamp(decision.confidence, Math.max(base.confidence, 0.6)),
    components,
    visualizationRules: [...rules.values()].slice(0, 128),
    hypotheses: [...hypotheses.values()].slice(0, 256),
    notes: [
      ...(base.notes ?? []),
      decision.summary ? `AI review: ${decision.summary}` : 'AI runtime review completed.',
    ].slice(-32),
  };
}
