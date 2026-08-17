import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeIntelligenceProfile } from 'gitnexus-shared';
import { detectNodeComponent } from '../../src/runtime-intelligence/detectors.js';
import { mergeRuntimeAdvisorDecision } from '../../src/runtime-intelligence/merge-advisor.js';
import {
  loadRuntimeProfile,
  runtimeProfilePath,
  saveRuntimeProfile,
} from '../../src/runtime-intelligence/profile-store.js';
import {
  RuntimeIntelligenceCoordinator,
  RuntimeProfileConflictError,
} from '../../src/runtime-intelligence/coordinator.js';
import { validateRuntimeAdvisorDecision } from '../../src/runtime-intelligence/validation.js';

const tempDirs: string[] = [];
const makeRepo = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-runtime-intelligence-'));
  tempDirs.push(dir);
  return dir;
};

const profileFor = (repoPath: string): RuntimeIntelligenceProfile => ({
  schemaVersion: 1,
  repoPath,
  generatedAt: 1,
  updatedAt: 1,
  generation: 1,
  source: 'heuristic',
  confidence: 0.8,
  needsAiReview: true,
  components: [
    {
      id: 'root-node',
      name: 'fixture',
      root: '.',
      kind: 'node',
      entrypoints: ['src/index.ts'],
      launch: [],
      trace: [],
      confidence: 0.8,
      evidence: [{ source: 'manifest', detail: 'package.json detected', confidence: 1 }],
    },
  ],
  visualizationRules: [],
  hypotheses: [],
  observations: [],
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('runtime reconnaissance', () => {
  it('uses the detected package manager in inferred launch commands', async () => {
    const repo = await makeRepo();
    await fs.writeFile(
      path.join(repo, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { dev: 'vite' },
        dependencies: { react: '*', vite: '*' },
      }),
    );
    await fs.writeFile(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9');

    const component = await detectNodeComponent(repo);

    expect(component?.packageManager).toBe('pnpm');
    expect(component?.launch[0]?.command).toBe('pnpm run dev');
  });
});

describe('runtime profile persistence and advisor merge', () => {
  it('rejects a profile whose embedded repository identity does not match its location', async () => {
    const repo = await makeRepo();
    const profile = profileFor(path.join(repo, 'somewhere-else'));
    await fs.mkdir(path.dirname(runtimeProfilePath(repo)), { recursive: true });
    await fs.writeFile(runtimeProfilePath(repo), JSON.stringify(profile));

    await expect(loadRuntimeProfile(repo)).resolves.toBeNull();
  });

  it('preserves deterministic identity and evidence while applying a constrained update', () => {
    const base = profileFor('C:/repo');
    const rootComponent = base.components[0];
    if (!rootComponent) throw new Error('fixture root component missing');
    rootComponent.entrypoints = ['src/index.ts'];
    rootComponent.launch = [
      {
        command: 'npm run dev',
        role: 'dev',
        confidence: 0.8,
        evidence: [{ source: 'script', detail: 'deterministic launch', confidence: 0.8 }],
      },
    ];
    rootComponent.trace = [
      {
        tracer: 'node-v8-coverage',
        enabled: true,
        confidence: 0.8,
        evidence: [{ source: 'manifest', detail: 'deterministic trace', confidence: 0.8 }],
      },
    ];
    base.visualizationRules = [
      {
        id: 'function-call',
        semanticKind: 'function',
        animation: 'pulse',
        durationMs: 400,
        priority: 10,
        enabled: true,
        evidence: [{ source: 'graph', detail: 'deterministic rule', confidence: 0.8 }],
      },
    ];
    base.hypotheses = [
      {
        id: 'launch:root-node',
        statement: 'Deterministic launch statement',
        status: 'proposed',
        confidence: 0.8,
        evidence: [{ source: 'script', detail: 'deterministic hypothesis', confidence: 0.8 }],
      },
    ];
    const merged = mergeRuntimeAdvisorDecision(base, {
      componentUpdates: [
        {
          componentId: 'root-node',
          framework: 'Express',
          entrypoints: ['src/server.ts'],
          launch: [
            {
              command: 'npm run dev',
              role: 'dev',
              confidence: 0.9,
              evidence: [{ source: 'ai', detail: 'advisor launch', confidence: 0.9 }],
            },
          ],
          trace: [
            {
              tracer: 'node-v8-coverage',
              enabled: false,
              confidence: 0.9,
              evidence: [{ source: 'ai', detail: 'advisor trace', confidence: 0.9 }],
            },
          ],
          confidence: 0.9,
        },
      ],
      visualizationRules: [
        {
          id: 'function-call',
          semanticKind: 'function',
          animation: 'glow',
          durationMs: 900,
          priority: 20,
          enabled: true,
          evidence: [{ source: 'ai', detail: 'advisor rule', confidence: 0.9 }],
        },
      ],
      hypotheses: [
        {
          id: 'launch:root-node',
          statement: 'Advisor launch statement',
          status: 'confirmed',
          confidence: 0.9,
          evidence: [{ source: 'ai', detail: 'advisor hypothesis', confidence: 0.9 }],
        },
      ],
      confidence: 0.9,
    });

    expect(merged.repoPath).toBe(base.repoPath);
    expect(merged.schemaVersion).toBe(1);
    expect(merged.generation).toBe(2);
    expect(merged.components[0]?.evidence[0]).toEqual(base.components[0]?.evidence[0]);
    expect(merged.components[0]?.evidence.some((item) => item.source === 'ai')).toBe(true);
    expect(merged.components[0]?.entrypoints).toEqual(['src/index.ts', 'src/server.ts']);
    expect(merged.components[0]?.launch[0]?.evidence).toHaveLength(2);
    expect(merged.components[0]?.trace[0]).toMatchObject({ enabled: false });
    expect(merged.components[0]?.trace[0]?.evidence).toHaveLength(2);
    expect(merged.visualizationRules).toHaveLength(2);
    expect(merged.visualizationRules[0]).toEqual(base.visualizationRules[0]);
    expect(merged.visualizationRules[1]).toMatchObject({
      id: 'ai:function-call',
      animation: 'glow',
    });
    expect(merged.hypotheses).toHaveLength(2);
    expect(merged.hypotheses[0]).toEqual(base.hypotheses[0]);
    expect(merged.hypotheses[1]).toMatchObject({
      id: 'ai:launch:root-node',
      statement: 'Advisor launch statement',
    });
  });

  it('rejects unknown component IDs and invalid visualization regexes', () => {
    expect(() =>
      validateRuntimeAdvisorDecision(
        { componentUpdates: [{ componentId: 'invented-component' }] },
        new Set(['root-node']),
      ),
    ).toThrow(/unknown component/i);

    expect(() =>
      validateRuntimeAdvisorDecision(
        {
          visualizationRules: [
            {
              id: 'broken',
              semanticKind: 'function',
              animation: 'pulse',
              durationMs: 500,
              priority: 1,
              enabled: true,
              match: { functionRegex: '(' },
              evidence: [],
            },
          ],
        },
        new Set(['root-node']),
      ),
    ).toThrow(/regular expression/i);

    expect(() =>
      validateRuntimeAdvisorDecision(
        {
          visualizationRules: [
            {
              id: 'catastrophic',
              semanticKind: 'function',
              animation: 'pulse',
              durationMs: 500,
              priority: 1,
              enabled: true,
              match: { functionRegex: '(a+)+$' },
              evidence: [],
            },
          ],
        },
        new Set(['root-node']),
      ),
    ).toThrow(/unsafe regular expression/i);

    expect(() =>
      validateRuntimeAdvisorDecision(
        {
          visualizationRules: [
            {
              id: 'unsupported-label',
              semanticKind: 'function',
              animation: 'pulse',
              durationMs: 500,
              priority: 1,
              enabled: true,
              match: { graphLabel: 'Function' },
              evidence: [],
            },
          ],
        },
        new Set(['root-node']),
      ),
    ).toThrow(/graphLabel is not supported/i);
  });

  it('marks all advisor-provided evidence as AI-authored at the HTTP boundary', () => {
    const decision = validateRuntimeAdvisorDecision(
      {
        componentUpdates: [
          {
            componentId: 'root-node',
            evidence: [{ source: 'manifest', detail: 'package.json says React', confidence: 0.9 }],
          },
        ],
      },
      new Set(['root-node']),
    );

    expect(decision.componentUpdates?.[0]?.evidence?.[0]?.source).toBe('ai');
  });

  it('rejects a stale advisor generation instead of overwriting newer reconnaissance', async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture' }));
    const coordinator = new RuntimeIntelligenceCoordinator();
    const base = await coordinator.ensure(repo);

    await expect(
      coordinator.applyAdvisorDecision(repo, base.generation - 1, {}),
    ).rejects.toBeInstanceOf(RuntimeProfileConflictError);
    await expect(
      coordinator.applyAdvisorDecision(repo, base.generation, {}),
    ).resolves.toMatchObject({
      generation: base.generation + 1,
      source: 'heuristic+ai',
    });

    await expect(loadRuntimeProfile(repo)).resolves.toMatchObject({
      generation: base.generation + 1,
    });
  });

  it('round-trips an atomically saved profile', async () => {
    const repo = await makeRepo();
    const profile = profileFor(repo);
    await saveRuntimeProfile(repo, profile);
    await expect(loadRuntimeProfile(repo)).resolves.toEqual(profile);
  });
});
