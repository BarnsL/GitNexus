import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeActivityPanel } from '../../src/components/RuntimeActivityPanel';

const H = vi.hoisted(() => ({
  connect: vi.fn(),
  animate: vi.fn(),
  onEvent: null as null | ((event: Record<string, unknown>) => void),
}));

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => ({
    viewMode: 'exploring',
    graph: { nodes: [], relationships: [], nodeCount: 0, relationshipCount: 0 },
    currentRepo: 'fixture',
    triggerNodeAnimation: H.animate,
  }),
}));

vi.mock('../../src/services/runtime-client', () => ({
  connectRuntimeActivity: (...args: unknown[]) => {
    H.connect(...args);
    H.onEvent = (args[1] as { onEvent: (event: Record<string, unknown>) => void }).onEvent;
    return vi.fn();
  },
}));

vi.mock('../../src/components/RuntimeIntelligencePanel', () => ({
  RuntimeIntelligencePanel: ({
    onProfileChange,
  }: {
    onProfileChange: (profile: unknown) => void;
  }) => (
    <button
      type="button"
      data-testid="publish-profile"
      onClick={() =>
        onProfileChange({
          schemaVersion: 1,
          repoPath: 'C:/repo',
          generation: 2,
          visualizationRules: [],
        })
      }
    >
      publish profile
    </button>
  ),
}));

describe('Runtime Activity profile updates', () => {
  beforeEach(() => {
    H.connect.mockClear();
    H.animate.mockClear();
    H.onEvent = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not reconnect the runtime event stream when intelligence changes', () => {
    render(<RuntimeActivityPanel />);
    expect(H.connect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('publish-profile'));

    expect(H.connect).toHaveBeenCalledTimes(1);
  });

  it('ages active functions out even when no new events arrive', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00Z'));
    render(<RuntimeActivityPanel />);

    act(() => {
      H.onEvent?.({
        seq: 1,
        ts: Date.now(),
        receivedAt: Date.now(),
        runtime: 'node',
        kind: 'function',
        pid: 1,
        functionName: 'work',
        filePath: 'src/work.ts',
      });
    });
    expect(screen.getByText('1 active')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3_000));

    expect(screen.getByText('0 active')).toBeInTheDocument();
  });
});
