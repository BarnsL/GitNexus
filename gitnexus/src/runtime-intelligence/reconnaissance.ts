import type { RuntimeIntelligenceProfile, RuntimeVisualizationRule } from 'gitnexus-shared';
import { detectNodeComponents, detectOtherComponents, detectPythonComponent } from './detectors.js';

const defaultRules = (): RuntimeVisualizationRule[] => [
  {
    id: 'function-default',
    semanticKind: 'function',
    animation: 'pulse',
    durationMs: 700,
    priority: 10,
    enabled: true,
    edgeAnimation: 'none',
    evidence: [
      { source: 'manifest', detail: 'Default runtime function visualization', confidence: 1 },
    ],
  },
  {
    id: 'ui-handlers',
    semanticKind: 'ui-action',
    animation: 'ripple',
    durationMs: 1100,
    priority: 50,
    enabled: true,
    match: { functionRegex: '^(handle|on)[A-Z_]|click|submit|change|input|keydown|keyup' },
    edgeAnimation: 'flow',
    evidence: [
      {
        source: 'manifest',
        detail: 'Conventional UI handler naming heuristic',
        confidence: 0.72,
      },
    ],
  },
  {
    id: 'render',
    semanticKind: 'render',
    animation: 'glow',
    durationMs: 850,
    priority: 40,
    enabled: true,
    match: { functionRegex: 'render|component|use[A-Z]' },
    edgeAnimation: 'none',
    evidence: [
      {
        source: 'manifest',
        detail: 'Common render and component naming heuristic',
        confidence: 0.62,
      },
    ],
  },
  {
    id: 'http',
    semanticKind: 'http-request',
    animation: 'ripple',
    durationMs: 1200,
    priority: 60,
    enabled: true,
    match: { detailRegex: '\\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\\b|https?://' },
    edgeAnimation: 'flow',
    evidence: [{ source: 'manifest', detail: 'HTTP runtime detail heuristic', confidence: 0.8 }],
  },
  {
    id: 'error',
    semanticKind: 'error',
    animation: 'glow',
    durationMs: 2400,
    priority: 100,
    enabled: true,
    match: { detailRegex: 'error|exception|failed|rejected|panic' },
    edgeAnimation: 'none',
    evidence: [{ source: 'manifest', detail: 'Error runtime detail heuristic', confidence: 0.9 }],
  },
];

export async function buildHeuristicRuntimeProfile(
  repoPath: string,
): Promise<RuntimeIntelligenceProfile> {
  const [nodeComponents, pythonComponent, otherComponents] = await Promise.all([
    detectNodeComponents(repoPath),
    detectPythonComponent(repoPath),
    detectOtherComponents(repoPath),
  ]);
  const components = [
    ...nodeComponents,
    ...(pythonComponent ? [pythonComponent] : []),
    ...otherComponents,
  ];
  const now = Date.now();
  const confidence = components.length
    ? components.reduce((sum, component) => sum + component.confidence, 0) / components.length
    : 0.2;

  return {
    schemaVersion: 1,
    repoPath,
    generatedAt: now,
    updatedAt: now,
    generation: 1,
    source: 'heuristic',
    confidence,
    needsAiReview: true,
    components,
    visualizationRules: defaultRules(),
    hypotheses: components.flatMap((component) =>
      component.launch.slice(0, 1).map((launch) => ({
        id: `launch:${component.id}`,
        statement: `${component.name} likely starts with: ${launch.command}`,
        status: 'proposed' as const,
        confidence: launch.confidence,
        evidence: launch.evidence,
      })),
    ),
    observations: [],
    notes:
      components.length === 0
        ? ['No known runtime manifest detected. AI review should inspect graph entry points.']
        : [
            'Heuristic reconnaissance complete. AI review should validate launch commands, tracing strategy, and semantic visualization.',
          ],
  };
}
