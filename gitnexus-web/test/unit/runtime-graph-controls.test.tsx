import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphCanvas } from '../../src/components/GraphCanvas';

const H = vi.hoisted(() => ({
  stopLayout: vi.fn(),
  startLayout: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../src/components/QueryFAB', () => ({ QueryFAB: () => null }));
vi.mock('../../src/components/RuntimeActivityPanel', () => ({
  RuntimeActivityPanel: () => <div>runtime panel</div>,
}));

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => ({
    graph: { nodes: [], relationships: [] },
    setSelectedNode: vi.fn(),
    selectedNode: null,
    visibleLabels: new Set(),
    visibleEdgeTypes: [],
    openCodePanel: vi.fn(),
    depthFilter: 1,
    highlightedNodeIds: new Set(),
    aiCitationHighlightedNodeIds: new Set(),
    aiToolHighlightedNodeIds: new Set(),
    blastRadiusNodeIds: new Set(),
    isAIHighlightsEnabled: false,
    toggleAIHighlights: vi.fn(),
    clearAIToolHighlights: vi.fn(),
    clearAICitationHighlights: vi.fn(),
    clearBlastRadius: vi.fn(),
    animatedNodes: new Map(),
    graphViewMode: 'runtime',
    setGraphViewMode: vi.fn(),
    graphMode: 'graph',
    chatOnlyNodeCount: 0,
    loadGraphAnyway: vi.fn(),
  }),
}));

vi.mock('../../src/hooks/useSigma', () => ({
  useSigma: () => ({
    containerRef: { current: null },
    sigmaRef: { current: null },
    setGraph: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetZoom: vi.fn(),
    focusNode: vi.fn(),
    isLayoutRunning: false,
    startLayout: H.startLayout,
    stopLayout: H.stopLayout,
    selectedNode: null,
    setSelectedNode: vi.fn(),
  }),
}));

describe('Runtime Activity graph controls', () => {
  it('stops layout and hides the graph layout control in runtime mode', async () => {
    render(<GraphCanvas />);

    await waitFor(() => expect(H.stopLayout).toHaveBeenCalled());
    expect(screen.queryByTitle('canvas.runLayout')).not.toBeInTheDocument();
    expect(screen.getByText('runtime panel')).toBeInTheDocument();
  });
});
