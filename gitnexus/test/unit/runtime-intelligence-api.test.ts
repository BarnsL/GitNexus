import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RuntimeIntelligenceProfile } from 'gitnexus-shared';
import { RuntimeProfileConflictError } from '../../src/runtime-intelligence/coordinator.js';
import type { RuntimeIntelligenceCoordinator } from '../../src/runtime-intelligence/coordinator.js';
import { mountRuntimeIntelligenceEndpoints } from '../../src/server/runtime-intelligence-api.js';

const profile: RuntimeIntelligenceProfile = {
  schemaVersion: 1,
  repoPath: 'C:/repo',
  generatedAt: 1,
  updatedAt: 1,
  generation: 3,
  source: 'heuristic',
  confidence: 0.8,
  needsAiReview: true,
  components: [
    {
      id: 'root-node',
      name: 'fixture',
      root: '.',
      kind: 'node',
      entrypoints: [],
      launch: [],
      trace: [],
      confidence: 0.8,
      evidence: [],
    },
  ],
  visualizationRules: [],
  hypotheses: [],
  observations: [],
};

describe('Runtime Intelligence API trust boundary', () => {
  let server: Server;
  let baseUrl: string;
  const ensure = vi.fn();
  const applyAdvisorDecision = vi.fn();

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    mountRuntimeIntelligenceEndpoints(
      app,
      async () => ({ path: profile.repoPath }),
      { ensure, applyAdvisorDecision } as unknown as RuntimeIntelligenceCoordinator,
      (_req, _res, next) => next(),
    );
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    ensure.mockReset().mockResolvedValue(profile);
    applyAdvisorDecision.mockReset().mockResolvedValue({ ...profile, generation: 4 });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('returns the generated profile for a registered repository', async () => {
    const response = await fetch(`${baseUrl}/api/runtime-intelligence/profile?repo=fixture`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ generation: 3 });
    expect(ensure).toHaveBeenCalledWith(profile.repoPath);
  });

  it('rejects invalid advisor regexes before invoking the coordinator merge', async () => {
    const response = await fetch(`${baseUrl}/api/runtime-intelligence/profile/advisor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: 'fixture',
        expectedGeneration: 3,
        decision: {
          visualizationRules: [
            {
              id: 'broken',
              semanticKind: 'function',
              animation: 'pulse',
              durationMs: 500,
              priority: 1,
              enabled: true,
              match: { pathRegex: '(' },
              evidence: [],
            },
          ],
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(applyAdvisorDecision).not.toHaveBeenCalled();
  });

  it('returns conflict when a browser submits an obsolete profile generation', async () => {
    applyAdvisorDecision.mockRejectedValueOnce(
      new RuntimeProfileConflictError('Runtime profile generation changed'),
    );
    const response = await fetch(`${baseUrl}/api/runtime-intelligence/profile/advisor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'fixture', expectedGeneration: 3, decision: {} }),
    });

    expect(response.status).toBe(409);
  });
});
