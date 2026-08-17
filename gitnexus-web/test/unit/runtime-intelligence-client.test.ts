import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRuntimeIntelligenceProfile } from '../../src/services/runtime-intelligence-client';

vi.mock('../../src/services/backend-client', () => ({
  getBackendUrl: () => 'http://localhost:4747',
  getAuthToken: () => '',
}));

describe('Runtime Intelligence backend selection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the active app-state server instead of a stale module default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
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
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchRuntimeIntelligenceProfile('fixture', 'http://127.0.0.1:4759/');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4759/api/runtime-intelligence/profile?repo=fixture',
      expect.any(Object),
    );
  });
});
