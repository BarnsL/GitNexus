import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeIntelligencePanel } from '../../src/components/RuntimeIntelligencePanel';

const H = vi.hoisted(() => ({
  fetchProfile: vi.fn(),
  refreshProfile: vi.fn(),
  fetchRuns: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

const profile = {
  schemaVersion: 1 as const,
  repoPath: 'C:/repo',
  generatedAt: 1,
  updatedAt: 1,
  generation: 3,
  source: 'heuristic' as const,
  confidence: 0.9,
  needsAiReview: false,
  components: [
    {
      id: 'root-node',
      name: 'Fixture app',
      root: '.',
      kind: 'node' as const,
      framework: 'Express',
      entrypoints: ['src/index.ts'],
      launch: [],
      trace: [],
      confidence: 0.9,
      evidence: [],
    },
  ],
  visualizationRules: [],
  hypotheses: [],
  observations: [],
};

const action = {
  id: 'runtime-aaaaaaaaaaaaaaaa',
  componentId: 'root-node',
  kind: 'trace-app' as const,
  title: 'Start Fixture app with tracing',
  description: 'GitNexus starts the detected app and streams function activity into the dock.',
  commandPreview: 'npm run dev',
  workingDirectory: '.',
  tracers: ['node-v8-coverage' as const],
  enabled: true,
};

const running = {
  id: 'run-1',
  actionId: action.id,
  componentId: action.componentId,
  kind: action.kind,
  state: 'running' as const,
  pid: 123,
  startedAt: 10,
  output: [{ seq: 1, ts: 11, stream: 'stdout' as const, text: 'Server ready on port 3000' }],
};

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => ({
    currentRepo: 'fixture',
    graph: { nodes: [], relationships: [] },
    serverBaseUrl: 'http://127.0.0.1:4759',
  }),
}));

vi.mock('../../src/core/llm/settings-service', () => ({
  getActiveProviderConfig: () => null,
}));

vi.mock('../../src/services/runtime-intelligence-client', () => ({
  fetchRuntimeIntelligenceProfile: (...args: unknown[]) => H.fetchProfile(...args),
  refreshRuntimeIntelligenceProfile: (...args: unknown[]) => H.refreshProfile(...args),
  fetchRuntimeManagedRuns: (...args: unknown[]) => H.fetchRuns(...args),
  startRuntimeManagedRun: (...args: unknown[]) => H.start(...args),
  stopRuntimeManagedRun: (...args: unknown[]) => H.stop(...args),
  saveRuntimeAdvisorDecision: vi.fn(),
  RuntimeIntelligenceRequestError: class RuntimeIntelligenceRequestError extends Error {},
}));

vi.mock('../../src/core/runtime-intelligence/advisor', () => ({ runRuntimeAdvisor: vi.fn() }));

describe('Runtime Intelligence managed controls', () => {
  beforeEach(() => {
    H.fetchProfile.mockReset().mockResolvedValue(profile);
    H.refreshProfile.mockReset().mockResolvedValue(profile);
    H.fetchRuns.mockReset().mockResolvedValue({
      profileGeneration: profile.generation,
      actions: [action],
      runs: [],
    });
    H.start.mockReset().mockResolvedValue(running);
    H.stop.mockReset().mockResolvedValue({ ...running, state: 'stopping' });
  });

  it('explains prerequisites and waits for confirmation before starting', async () => {
    render(<RuntimeIntelligencePanel onProfileChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /1 app/i }));

    expect(await screen.findByText('What this does')).toBeInTheDocument();
    expect(screen.getByText('Before you start')).toBeInTheDocument();
    expect(screen.getByText('Success looks like')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start with tracing' }));
    expect(H.start).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm start' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm start' }));
    await waitFor(() =>
      expect(H.start).toHaveBeenCalledWith(
        {
          repo: 'fixture',
          expectedGeneration: 3,
          actionId: 'runtime-aaaaaaaaaaaaaaaa',
        },
        'http://127.0.0.1:4759',
      ),
    );
    expect(await screen.findByText(/Server ready on port 3000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop managed run' })).toBeInTheDocument();
  });

  it('explains how to recover when managed start fails', async () => {
    H.start.mockRejectedValueOnce(new Error('Runtime Intelligence request failed (500)'));
    render(<RuntimeIntelligencePanel onProfileChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /1 app/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start with tracing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm start' }));

    const recovery = await screen.findByText(
      /Review the app output or refresh discovery, then try again/i,
    );
    expect(recovery).toBeInTheDocument();
    expect(recovery).not.toHaveTextContent('..');
  });
});
