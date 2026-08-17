import type {
  RuntimeAdvisorDecision,
  RuntimeAppKind,
  RuntimeEvidence,
  RuntimeHypothesis,
  RuntimeLaunchCommand,
  RuntimeTracePlan,
  RuntimeVisualizationRule,
} from 'gitnexus-shared';

export class RuntimeAdvisorValidationError extends Error {}

const APP_KINDS = new Set<RuntimeAppKind>([
  'browser',
  'node',
  'python',
  'java',
  'dotnet',
  'go',
  'rust',
  'native',
  'unknown',
]);
const EVIDENCE_SOURCES = new Set<RuntimeEvidence['source']>([
  'manifest',
  'dependency',
  'script',
  'graph',
  'runtime',
  'ai',
  'user',
]);
const LAUNCH_ROLES = new Set<RuntimeLaunchCommand['role']>([
  'dev',
  'start',
  'test',
  'worker',
  'unknown',
]);
const TRACERS = new Set<RuntimeTracePlan['tracer']>([
  'browser-cdp-coverage',
  'node-v8-coverage',
  'python-profile',
  'opentelemetry',
  'custom',
]);
const SEMANTIC_KINDS = new Set<RuntimeVisualizationRule['semanticKind']>([
  'function',
  'ui-action',
  'render',
  'http-request',
  'database',
  'queue',
  'websocket',
  'state-change',
  'error',
  'process',
]);
const ANIMATIONS = new Set<RuntimeVisualizationRule['animation']>(['pulse', 'ripple', 'glow']);
const HYPOTHESIS_STATUSES = new Set<RuntimeHypothesis['status']>([
  'proposed',
  'confirmed',
  'rejected',
  'uncertain',
]);

const fail = (message: string): never => {
  throw new RuntimeAdvisorValidationError(message);
};

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const string = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(`${label} must be a non-empty string no longer than ${max} characters`);
  }
  return value as string;
};

const optionalString = (value: unknown, label: string, max: number): string | undefined =>
  value === undefined ? undefined : string(value, label, max);

const number = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${label} must be a number from ${min} to ${max}`);
  }
  return value as number;
};

const optionalConfidence = (value: unknown, label: string): number | undefined =>
  value === undefined ? undefined : number(value, label, 0, 1);

const array = (value: unknown, label: string, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max)
    fail(`${label} must be an array of at most ${max}`);
  return value as unknown[];
};

const enumValue = <T extends string>(value: unknown, label: string, allowed: Set<T>): T => {
  if (typeof value !== 'string' || !allowed.has(value as T)) fail(`${label} is not supported`);
  return value as T;
};

const parseEvidence = (value: unknown, label: string): RuntimeEvidence => {
  const item = object(value, label);
  enumValue(item.source, `${label}.source`, EVIDENCE_SOURCES);
  return {
    // This parser is the HTTP boundary for advisor output. Even when the
    // advisor cites a manifest or runtime observation, the claim itself came
    // from AI and must not be confused with deterministic server evidence.
    source: 'ai',
    detail: string(item.detail, `${label}.detail`, 2_000),
    confidence: number(item.confidence, `${label}.confidence`, 0, 1),
    ...(item.filePath === undefined
      ? {}
      : { filePath: string(item.filePath, `${label}.filePath`, 500) }),
  };
};

const parseEvidenceList = (value: unknown, label: string): RuntimeEvidence[] =>
  array(value, label, 64).map((item, index) => parseEvidence(item, `${label}[${index}]`));

const parseLaunch = (value: unknown, label: string): RuntimeLaunchCommand => {
  const item = object(value, label);
  return {
    command: string(item.command, `${label}.command`, 1_000),
    ...(item.cwd === undefined ? {} : { cwd: string(item.cwd, `${label}.cwd`, 500) }),
    role: enumValue(item.role, `${label}.role`, LAUNCH_ROLES),
    confidence: number(item.confidence, `${label}.confidence`, 0, 1),
    evidence: parseEvidenceList(item.evidence, `${label}.evidence`),
  };
};

const parseTrace = (value: unknown, label: string): RuntimeTracePlan => {
  const item = object(value, label);
  if (typeof item.enabled !== 'boolean') fail(`${label}.enabled must be a boolean`);
  let options: Record<string, string | number | boolean> | undefined;
  if (item.options !== undefined) {
    const rawOptions = object(item.options, `${label}.options`);
    if (Object.keys(rawOptions).length > 32) fail(`${label}.options has too many keys`);
    options = {};
    for (const [key, option] of Object.entries(rawOptions)) {
      if (key.length > 100 || !['string', 'number', 'boolean'].includes(typeof option)) {
        fail(`${label}.options contains an invalid value`);
      }
      if (typeof option === 'number' && !Number.isFinite(option)) {
        fail(`${label}.options contains a non-finite number`);
      }
      options[key] = option as string | number | boolean;
    }
  }
  return {
    tracer: enumValue(item.tracer, `${label}.tracer`, TRACERS),
    enabled: item.enabled as boolean,
    confidence: number(item.confidence, `${label}.confidence`, 0, 1),
    ...(options ? { options } : {}),
    evidence: parseEvidenceList(item.evidence, `${label}.evidence`),
  };
};

/**
 * Reject the high-risk part of JavaScript's regex grammar used by ReDoS
 * payloads. Runtime rules execute on a hot browser event stream, so bounded
 * source length alone is not enough: `(a+)+$` is short but can still pin the
 * UI. Advisor patterns do not need backreferences, lookarounds, or quantified
 * groups that already contain a quantifier or alternation.
 */
const isUnsafeRuntimeRegex = (source: string): boolean => {
  const groups: Array<{ hasQuantifier: boolean; hasAlternation: boolean }> = [];
  let inCharacterClass = false;
  let lastClosedGroup: { hasQuantifier: boolean; hasAlternation: boolean } | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      if (!inCharacterClass && /[1-9]/.test(source[index + 1] ?? '')) return true;
      index += 1;
      lastClosedGroup = null;
      continue;
    }
    if (inCharacterClass) {
      if (char === ']') inCharacterClass = false;
      continue;
    }
    if (char === '[') {
      inCharacterClass = true;
      lastClosedGroup = null;
      continue;
    }
    if (char === '(') {
      if (source[index + 1] === '?') {
        if (source[index + 2] !== ':') return true;
        index += 2;
      }
      groups.push({ hasQuantifier: false, hasAlternation: false });
      lastClosedGroup = null;
      continue;
    }
    if (char === '|') {
      const group = groups.at(-1);
      if (group) group.hasAlternation = true;
      lastClosedGroup = null;
      continue;
    }
    if (char === ')') {
      const closed = groups.pop();
      if (closed) {
        const parent = groups.at(-1);
        if (parent) {
          parent.hasQuantifier ||= closed.hasQuantifier;
          parent.hasAlternation ||= closed.hasAlternation;
        }
        lastClosedGroup = closed;
      }
      continue;
    }
    if (char === '*' || char === '+' || char === '?' || char === '{') {
      if (lastClosedGroup?.hasQuantifier || lastClosedGroup?.hasAlternation) return true;
      const group = groups.at(-1);
      if (group) group.hasQuantifier = true;
      lastClosedGroup = null;
      continue;
    }
    lastClosedGroup = null;
  }
  return false;
};

const parseRegex = (value: unknown, label: string): string => {
  const source = string(value, label, 256);
  try {
    new RegExp(source, 'i');
  } catch {
    fail(`${label} must be a valid regular expression`);
  }
  if (isUnsafeRuntimeRegex(source)) fail(`${label} contains an unsafe regular expression`);
  return source;
};

const parseRule = (value: unknown, label: string): RuntimeVisualizationRule => {
  const item = object(value, label);
  if (typeof item.enabled !== 'boolean') fail(`${label}.enabled must be a boolean`);
  let match: RuntimeVisualizationRule['match'];
  if (item.match !== undefined) {
    const raw = object(item.match, `${label}.match`);
    match = {
      ...(raw.runtime === undefined
        ? {}
        : { runtime: string(raw.runtime, `${label}.match.runtime`, 50) }),
      ...(raw.functionRegex === undefined
        ? {}
        : { functionRegex: parseRegex(raw.functionRegex, `${label}.match.functionRegex`) }),
      ...(raw.pathRegex === undefined
        ? {}
        : { pathRegex: parseRegex(raw.pathRegex, `${label}.match.pathRegex`) }),
      ...(raw.detailRegex === undefined
        ? {}
        : { detailRegex: parseRegex(raw.detailRegex, `${label}.match.detailRegex`) }),
    };
    if (raw.graphLabel !== undefined) {
      fail(`${label}.match.graphLabel is not supported by the current runtime adapter`);
    }
  }
  return {
    id: string(item.id, `${label}.id`, 128),
    semanticKind: enumValue(item.semanticKind, `${label}.semanticKind`, SEMANTIC_KINDS),
    animation: enumValue(item.animation, `${label}.animation`, ANIMATIONS),
    durationMs: number(item.durationMs, `${label}.durationMs`, 50, 10_000),
    priority: number(item.priority, `${label}.priority`, -1_000, 1_000),
    enabled: item.enabled as boolean,
    ...(match ? { match } : {}),
    ...(item.edgeAnimation === undefined
      ? {}
      : {
          edgeAnimation: enumValue(
            item.edgeAnimation,
            `${label}.edgeAnimation`,
            new Set<RuntimeVisualizationRule['edgeAnimation']>(['none', 'flow']),
          ),
        }),
    ...(item.label === undefined ? {} : { label: string(item.label, `${label}.label`, 200) }),
    evidence: parseEvidenceList(item.evidence, `${label}.evidence`),
  };
};

const parseHypothesis = (value: unknown, label: string): RuntimeHypothesis => {
  const item = object(value, label);
  return {
    id: string(item.id, `${label}.id`, 128),
    statement: string(item.statement, `${label}.statement`, 2_000),
    status: enumValue(item.status, `${label}.status`, HYPOTHESIS_STATUSES),
    confidence: number(item.confidence, `${label}.confidence`, 0, 1),
    evidence: parseEvidenceList(item.evidence, `${label}.evidence`),
  };
};

export function validateRuntimeAdvisorDecision(
  value: unknown,
  componentIds: ReadonlySet<string>,
): RuntimeAdvisorDecision {
  const decision = object(value, 'decision');
  const componentUpdates =
    decision.componentUpdates === undefined
      ? undefined
      : array(decision.componentUpdates, 'decision.componentUpdates', 64).map((value, index) => {
          const label = `decision.componentUpdates[${index}]`;
          const item = object(value, label);
          const componentId = string(item.componentId, `${label}.componentId`, 128);
          if (!componentIds.has(componentId)) fail(`${label} references an unknown component`);
          return {
            componentId,
            ...(item.framework === undefined
              ? {}
              : { framework: string(item.framework, `${label}.framework`, 200) }),
            ...(item.kind === undefined
              ? {}
              : { kind: enumValue(item.kind, `${label}.kind`, APP_KINDS) }),
            ...(item.entrypoints === undefined
              ? {}
              : {
                  entrypoints: array(item.entrypoints, `${label}.entrypoints`, 32).map(
                    (entrypoint, entryIndex) =>
                      string(entrypoint, `${label}.entrypoints[${entryIndex}]`, 500),
                  ),
                }),
            ...(item.launch === undefined
              ? {}
              : {
                  launch: array(item.launch, `${label}.launch`, 16).map((launch, launchIndex) =>
                    parseLaunch(launch, `${label}.launch[${launchIndex}]`),
                  ),
                }),
            ...(item.trace === undefined
              ? {}
              : {
                  trace: array(item.trace, `${label}.trace`, 16).map((trace, traceIndex) =>
                    parseTrace(trace, `${label}.trace[${traceIndex}]`),
                  ),
                }),
            ...(item.confidence === undefined
              ? {}
              : { confidence: optionalConfidence(item.confidence, `${label}.confidence`) }),
            ...(item.evidence === undefined
              ? {}
              : { evidence: parseEvidenceList(item.evidence, `${label}.evidence`) }),
          };
        });

  return {
    ...(decision.summary === undefined
      ? {}
      : { summary: optionalString(decision.summary, 'decision.summary', 4_000) }),
    ...(componentUpdates ? { componentUpdates } : {}),
    ...(decision.visualizationRules === undefined
      ? {}
      : {
          visualizationRules: array(
            decision.visualizationRules,
            'decision.visualizationRules',
            128,
          ).map((rule, index) => parseRule(rule, `decision.visualizationRules[${index}]`)),
        }),
    ...(decision.hypotheses === undefined
      ? {}
      : {
          hypotheses: array(decision.hypotheses, 'decision.hypotheses', 256).map(
            (hypothesis, index) => parseHypothesis(hypothesis, `decision.hypotheses[${index}]`),
          ),
        }),
    ...(decision.confidence === undefined
      ? {}
      : { confidence: optionalConfidence(decision.confidence, 'decision.confidence') }),
  };
}
