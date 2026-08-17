import { describe, expect, it } from 'vitest';
import type { RuntimeIntelligenceProfile } from 'gitnexus-shared';
import { visualizationForRuntimeEvent } from '../../src/core/runtime-intelligence/visualizer';

const profile: RuntimeIntelligenceProfile = {
  schemaVersion: 1,
  repoPath: 'C:/repo',
  generatedAt: 1,
  updatedAt: 1,
  generation: 1,
  source: 'heuristic',
  confidence: 0.8,
  needsAiReview: false,
  components: [],
  visualizationRules: [
    {
      id: 'checkout',
      semanticKind: 'ui-action',
      animation: 'ripple',
      durationMs: 1200,
      priority: 50,
      enabled: true,
      match: { functionRegex: '^handleCheckout$' },
      edgeAnimation: 'flow',
      evidence: [],
    },
    {
      id: 'fallback',
      semanticKind: 'function',
      animation: 'glow',
      durationMs: 700,
      priority: 1,
      enabled: true,
      evidence: [],
    },
  ],
  hypotheses: [],
  observations: [],
};

describe('visualizationForRuntimeEvent', () => {
  it('chooses the highest-priority matching semantic rule', () => {
    const decision = visualizationForRuntimeEvent(profile, {
      seq: 1,
      ts: 1,
      receivedAt: 1,
      runtime: 'browser',
      kind: 'function',
      pid: 1,
      functionName: 'handleCheckout',
      filePath: 'src/Checkout.tsx',
    });

    expect(decision).toMatchObject({
      ruleId: 'checkout',
      semanticKind: 'ui-action',
      animation: 'ripple',
      edgeAnimation: 'flow',
    });
  });

  it('falls back safely when no profile exists', () => {
    expect(
      visualizationForRuntimeEvent(null, {
        seq: 1,
        ts: 1,
        receivedAt: 1,
        runtime: 'node',
        kind: 'function',
        pid: 1,
      }),
    ).toMatchObject({ semanticKind: 'function', animation: 'pulse', durationMs: 700 });
  });

  it('does not treat an unsupported graph-label constraint as a catch-all', () => {
    const fallbackRule = profile.visualizationRules[1];
    if (!fallbackRule) throw new Error('fixture fallback rule missing');
    const graphLabelProfile: RuntimeIntelligenceProfile = {
      ...profile,
      visualizationRules: [
        {
          id: 'unsupported-label',
          semanticKind: 'error',
          animation: 'glow',
          durationMs: 2_000,
          priority: 100,
          enabled: true,
          match: { graphLabel: 'Function' },
          evidence: [],
        },
        fallbackRule,
      ],
    };

    expect(
      visualizationForRuntimeEvent(graphLabelProfile, {
        seq: 1,
        ts: 1,
        receivedAt: 1,
        runtime: 'node',
        kind: 'function',
        pid: 1,
        functionName: 'ordinaryFunction',
      }),
    ).toMatchObject({ ruleId: 'fallback', semanticKind: 'function' });
  });
});
