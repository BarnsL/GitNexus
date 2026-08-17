import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeActionCard } from '../../src/components/RuntimeActionCard';

const H = vi.hoisted(() => ({ fetchRuns: vi.fn(), start: vi.fn(), stop: vi.fn() }));

const action = {
  id: 'runtime-aaaaaaaaaaaaaaaa',
  componentId: 'web',
  kind: 'trace-app' as const,
  title: 'Start Web app with tracing',
  description: 'Starts the detected app and streams function activity into the dock.',
  commandPreview: 'npm run dev',
  workingDirectory: '.',
  tracers: ['node-v8-coverage' as const],
  enabled: true,
};

const running = {
  id: 'run-ai-1',
  actionId: action.id,
  componentId: action.componentId,
  kind: action.kind,
  state: 'running' as const,
  pid: 321,
  startedAt: 10,
  output: [{ seq: 1, ts: 11, stream: 'stdout' as const, text: 'Ready on 5173' }],
};

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => ({
    currentRepo: 'fixture',
    serverBaseUrl: 'http://127.0.0.1:4759',
  }),
}));

vi.mock('../../src/services/runtime-intelligence-client', () => ({
  fetchRuntimeManagedRuns: (...args: unknown[]) => H.fetchRuns(...args),
  startRuntimeManagedRun: (...args: unknown[]) => H.start(...args),
  stopRuntimeManagedRun: (...args: unknown[]) => H.stop(...args),
}));

describe('RuntimeActionCard', () => {
  beforeEach(() => {
    H.fetchRuns.mockReset().mockResolvedValue({
      profileGeneration: 7,
      actions: [action],
      runs: [],
    });
    H.start.mockReset().mockResolvedValue(running);
    H.stop.mockReset().mockResolvedValue({ ...running, state: 'stopping' });
  });

  it('validates the advertised action and requires confirmation before it runs', async () => {
    render(<RuntimeActionCard actionId={action.id} />);

    expect(await screen.findByText(action.title)).toBeInTheDocument();
    expect(screen.getByText('Before you start')).toBeInTheDocument();
    expect(screen.getByText('Success looks like')).toBeInTheDocument();
    expect(H.start).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Prepare start' }));
    expect(H.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and start' }));

    await waitFor(() =>
      expect(H.start).toHaveBeenCalledWith(
        {
          repo: 'fixture',
          expectedGeneration: 7,
          actionId: action.id,
        },
        'http://127.0.0.1:4759',
      ),
    );
    expect(await screen.findByText(/Ready on 5173/)).toBeInTheDocument();
  });

  it('refuses stale or invented action IDs', async () => {
    render(<RuntimeActionCard actionId="runtime-bbbbbbbbbbbbbbbb" />);
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
    expect(H.start).not.toHaveBeenCalled();
  });
});
