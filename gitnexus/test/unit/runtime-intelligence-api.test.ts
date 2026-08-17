import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RuntimeIntelligenceProfile } from 'gitnexus-shared';
import { RuntimeProfileConflictError } from '../../src/runtime-intelligence/coordinator.js';
import type { RuntimeIntelligenceCoordinator } from '../../src/runtime-intelligence/coordinator.js';
import {
  ManagedRuntimeProcessError,
  type ManagedRuntimeProcessManager,
} from '../../src/runtime-intelligence/managed-process-manager.js';
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
  const actions = vi.fn();
  const runs = vi.fn();
  const start = vi.fn();
  const stop = vi.fn();

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    mountRuntimeIntelligenceEndpoints(
      app,
      async () => ({ path: profile.repoPath }),
      { ensure, applyAdvisorDecision } as unknown as RuntimeIntelligenceCoordinator,
      { actions, runs, start, stop } as unknown as ManagedRuntimeProcessManager,
      (req, res, next) => {
        if (req.get('x-test-trusted') === 'yes') next();
        else res.status(403).json({ error: 'untrusted test origin' });
      },
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
    actions.mockReset().mockReturnValue([
      {
        id: 'runtime-aaaaaaaaaaaaaaaa',
        componentId: 'root-node',
        kind: 'trace-app',
        title: 'Start fixture with tracing',
        description: 'Starts the detected app.',
        commandPreview: 'npm run dev',
        workingDirectory: '.',
        tracers: ['node-v8-coverage'],
        enabled: true,
      },
    ]);
    runs.mockReset().mockReturnValue([]);
    start.mockReset().mockResolvedValue({
      id: 'run-1',
      actionId: 'runtime-safe',
      componentId: 'root-node',
      kind: 'trace-app',
      state: 'running',
      startedAt: 10,
      output: [],
    });
    stop.mockReset().mockResolvedValue({
      id: 'run-1',
      actionId: 'runtime-safe',
      componentId: 'root-node',
      kind: 'trace-app',
      state: 'stopping',
      startedAt: 10,
      output: [],
    });
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
      headers: { 'Content-Type': 'application/json', 'x-test-trusted': 'yes' },
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
      headers: { 'Content-Type': 'application/json', 'x-test-trusted': 'yes' },
      body: JSON.stringify({ repo: 'fixture', expectedGeneration: 3, decision: {} }),
    });

    expect(response.status).toBe(409);
  });

  it('lists only server-advertised actions and runs for the registered repository', async () => {
    const response = await fetch(`${baseUrl}/api/runtime-intelligence/runs?repo=fixture`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      profileGeneration: 3,
      actions: [{ id: 'runtime-aaaaaaaaaaaaaaaa' }],
      runs: [],
    });
    expect(actions).toHaveBeenCalledWith(profile);
    expect(runs).toHaveBeenCalledWith(profile.repoPath);
  });

  it('requires the trusted-origin boundary before starting or stopping', async () => {
    const startResponse = await fetch(`${baseUrl}/api/runtime-intelligence/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: 'fixture',
        expectedGeneration: 3,
        actionId: 'runtime-aaaaaaaaaaaaaaaa',
      }),
    });
    const stopResponse = await fetch(`${baseUrl}/api/runtime-intelligence/runs/run-1/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'fixture' }),
    });

    expect(startResponse.status).toBe(403);
    expect(stopResponse.status).toBe(403);
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('starts and stops only opaque server-owned run IDs', async () => {
    const startResponse = await fetch(`${baseUrl}/api/runtime-intelligence/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-trusted': 'yes' },
      body: JSON.stringify({
        repo: 'fixture',
        expectedGeneration: 3,
        actionId: 'runtime-aaaaaaaaaaaaaaaa',
      }),
    });
    const stopResponse = await fetch(`${baseUrl}/api/runtime-intelligence/runs/run-1/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-trusted': 'yes' },
      body: JSON.stringify({ repo: 'fixture' }),
    });

    expect(startResponse.status).toBe(201);
    expect(stopResponse.status).toBe(200);
    expect(start).toHaveBeenCalledWith(profile.repoPath, profile, 3, 'runtime-aaaaaaaaaaaaaaaa');
    expect(stop).toHaveBeenCalledWith(profile.repoPath, 'run-1');
  });

  it('returns stable safe codes for stale and foreign run requests', async () => {
    start.mockRejectedValueOnce(
      new ManagedRuntimeProcessError('STALE_PROFILE', 'Refresh the app list and try again.'),
    );
    stop.mockRejectedValueOnce(
      new ManagedRuntimeProcessError('RUN_NOT_FOUND', 'That run does not belong here.'),
    );

    const stale = await fetch(`${baseUrl}/api/runtime-intelligence/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-trusted': 'yes' },
      body: JSON.stringify({
        repo: 'fixture',
        expectedGeneration: 2,
        actionId: 'runtime-aaaaaaaaaaaaaaaa',
      }),
    });
    const foreign = await fetch(`${baseUrl}/api/runtime-intelligence/runs/foreign/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-trusted': 'yes' },
      body: JSON.stringify({ repo: 'fixture' }),
    });

    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      code: 'STALE_PROFILE',
      error: 'Refresh the app list and try again.',
    });
    expect(foreign.status).toBe(404);
    await expect(foreign.json()).resolves.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });
});
