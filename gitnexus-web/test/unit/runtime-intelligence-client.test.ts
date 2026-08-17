import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchRuntimeIntelligenceProfile,
  fetchRuntimeManagedRuns,
  startRuntimeManagedRun,
  stopRuntimeManagedRun,
} from '../../src/services/runtime-intelligence-client';

vi.mock('../../src/services/backend-client', () => ({
  getBackendUrl: () => 'http://localhost:4747',
  getAuthToken: () => 'test-token',
}));

describe('Runtime Intelligence backend selection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the active app-state server instead of a stale module default', async () => {
    const runResponse = () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          repoPath: 'C:/repo',
          generation: 1,
          components: [],
          visualizationRules: [],
          hypotheses: [],
          observations: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(runResponse())
      .mockResolvedValueOnce(runResponse());
    vi.stubGlobal('fetch', fetchMock);

    await fetchRuntimeIntelligenceProfile('fixture', 'http://127.0.0.1:4759/');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4759/api/runtime-intelligence/profile?repo=fixture',
      expect.any(Object),
    );
  });

  it('lists managed actions and runs from the active authenticated backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ profileGeneration: 3, actions: [], runs: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchRuntimeManagedRuns('fixture repo', 'http://127.0.0.1:4759/');

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4759/api/runtime-intelligence/runs?repo=fixture%20repo');
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token');
  });

  it('starts and stops with opaque IDs instead of client-supplied commands', async () => {
    const runResponse = () =>
      new Response(
        JSON.stringify({
          id: 'run-1',
          actionId: 'runtime-aaaaaaaaaaaaaaaa',
          componentId: 'root-node',
          kind: 'trace-app',
          state: 'running',
          startedAt: 1,
          output: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(runResponse())
      .mockResolvedValueOnce(runResponse());
    vi.stubGlobal('fetch', fetchMock);

    await startRuntimeManagedRun(
      { repo: 'fixture', expectedGeneration: 3, actionId: 'runtime-aaaaaaaaaaaaaaaa' },
      'http://127.0.0.1:4759',
    );
    await stopRuntimeManagedRun('run-1', { repo: 'fixture' }, 'http://127.0.0.1:4759');

    const [startUrl, startOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(startUrl).toBe('http://127.0.0.1:4759/api/runtime-intelligence/runs');
    expect(JSON.parse(String(startOptions.body))).toEqual({
      repo: 'fixture',
      expectedGeneration: 3,
      actionId: 'runtime-aaaaaaaaaaaaaaaa',
    });
    expect(String(startOptions.body)).not.toMatch(/command|cwd|environment|argv/i);

    const [stopUrl, stopOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(stopUrl).toBe('http://127.0.0.1:4759/api/runtime-intelligence/runs/run-1/stop');
    expect(JSON.parse(String(stopOptions.body))).toEqual({ repo: 'fixture' });
    expect(new Headers(stopOptions.headers).get('Authorization')).toBe('Bearer test-token');
  });
});
