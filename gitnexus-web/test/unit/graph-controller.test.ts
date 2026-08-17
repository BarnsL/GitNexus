import { describe, expect, it, vi } from 'vitest';
import {
  createGraphController,
  createNoopGraphController,
  MAX_TARGETS,
  type GraphControllerDeps,
} from '../../src/core/llm/graph-controller';

const graph = {
  nodes: [
    {
      id: 'File:src/a.ts',
      label: 'File',
      properties: { name: 'a.ts', filePath: 'src/a.ts' },
    },
    {
      id: 'Function:src/a.ts:run',
      label: 'Function',
      properties: { name: 'run', filePath: 'src/a.ts', startLine: 5, endLine: 9 },
    },
    {
      id: 'Function:src/a.ts:helper',
      label: 'Function',
      properties: { name: 'helper', filePath: 'src/a.ts', startLine: 12, endLine: 14 },
    },
  ],
  relationships: [],
} as any;

const makeDeps = (overrides: Partial<GraphControllerDeps> = {}) => {
  const canvas = {
    focusNode: vi.fn(),
    frameNodes: vi.fn(),
    getCameraState: vi.fn(() => ({ x: 1, y: 2, ratio: 0.5, angle: 0 })),
    getNeighbors: vi.fn(() => [
      {
        nodeId: 'Function:src/a.ts:helper',
        name: 'helper',
        label: 'Function',
        filePath: 'src/a.ts',
        relationship: 'CALLS',
        direction: 'out' as const,
        depth: 1,
        rendered: true,
      },
    ]),
  };

  const deps: GraphControllerDeps = {
    getGraph: () => graph,
    getCanvas: () => canvas,
    setHighlightChannel: vi.fn(),
    triggerNodeAnimation: vi.fn(),
    getViewMode: () => 'force',
    setViewMode: vi.fn(),
    setVisibleEdgeTypes: vi.fn(),
    getVisibleEdgeTypes: () => ['CALLS'],
    setVisibleLabels: vi.fn(),
    setDepthFilter: vi.fn(),
    getDepthFilter: () => null,
    addCodeReference: vi.fn(),
    resolveFilePath: (p: string) => p,
    getSelectedNode: () => null,
    setSelectedNode: vi.fn(),
    pushViewHistory: vi.fn(),
    getHistoryDepth: () => 0,
    getHighlightCounts: () => ({ 'ai-tool': 0, 'blast-radius': 0, query: 0 }),
    isEditingEnabled: () => false,
    clearHighlights: vi.fn(),
    clearAnimations: vi.fn(),
    resetFilters: vi.fn(),
    ...overrides,
  };

  return { deps, canvas };
};

describe('focusNode', () => {
  it('resolves the target, captures history, and drives the canvas', async () => {
    const { deps, canvas } = makeDeps();
    const controller = createGraphController(deps);

    const output = await controller.focusNode('run');

    expect(canvas.focusNode).toHaveBeenCalledWith('Function:src/a.ts:run', { zoom: undefined });
    expect(deps.pushViewHistory).toHaveBeenCalledWith(
      'Before focusing run',
      expect.objectContaining({ viewMode: 'force' }),
    );
    expect(output).toContain('Function:run');
  });

  it('opens the source, converting 1-based graph lines to 0-based references', async () => {
    const { deps } = makeDeps();
    const controller = createGraphController(deps);

    await controller.focusNode('run');

    expect(deps.addCodeReference).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'src/a.ts', startLine: 4, endLine: 8, source: 'ai' }),
    );
  });

  it('skips opening the inspector when openCode is false', async () => {
    const { deps } = makeDeps();
    const controller = createGraphController(deps);

    await controller.focusNode('run', { openCode: false });

    expect(deps.addCodeReference).not.toHaveBeenCalled();
  });

  it('reports ambiguity with candidates and does not navigate', async () => {
    const ambiguousGraph = {
      nodes: [
        ...graph.nodes,
        {
          id: 'Function:src/b.ts:run',
          label: 'Function',
          properties: { name: 'run', filePath: 'src/b.ts' },
        },
      ],
    } as any;
    const { deps, canvas } = makeDeps({ getGraph: () => ambiguousGraph });
    const controller = createGraphController(deps);

    const output = await controller.focusNode('run');

    expect(canvas.focusNode).not.toHaveBeenCalled();
    expect(output).toContain('ambiguous');
    expect(output).toContain('src/b.ts');
  });

  it('reports a miss and does not navigate', async () => {
    const { deps, canvas } = makeDeps();
    const controller = createGraphController(deps);

    const output = await controller.focusNode('doesNotExist');

    expect(canvas.focusNode).not.toHaveBeenCalled();
    expect(output).toContain('No node matched');
  });

  it('reports that the graph is unavailable when no canvas is mounted', async () => {
    const { deps } = makeDeps({ getCanvas: () => null });
    const controller = createGraphController(deps);

    expect(await controller.focusNode('run')).toContain('not available');
  });
});

describe('neighbors', () => {
  it('returns relationship type and direction so consequences can be explained', async () => {
    const { deps } = makeDeps();
    const controller = createGraphController(deps);

    const output = await controller.neighbors('run');

    expect(output).toContain('CALLS');
    expect(output).toContain('helper');
    expect(deps.setHighlightChannel).toHaveBeenCalled();
  });

  it('separates hidden relationships and warns against calling them absent', async () => {
    const { deps, canvas } = makeDeps();
    canvas.getNeighbors = vi.fn(() => [
      {
        nodeId: 'Function:src/a.ts:helper',
        name: 'helper',
        label: 'Function',
        filePath: 'src/a.ts',
        relationship: 'USES',
        direction: 'out' as const,
        depth: 1,
        rendered: false,
      },
    ]) as any;
    const controller = createGraphController(deps);

    const output = await controller.neighbors('run');

    expect(output).toContain('USES');
    expect(output).toContain('NOT currently drawn');
    expect(output).toContain('do not exist');
  });

  it('says an empty result may mean unresolvable, not absent', async () => {
    const { deps, canvas } = makeDeps();
    canvas.getNeighbors = vi.fn(() => []) as any;
    const controller = createGraphController(deps);

    const output = await controller.neighbors('run');

    expect(output).toMatch(/not resolvable by the index/i);
  });
});

describe('bounds and filters', () => {
  it('rejects more than the target cap without touching the canvas', async () => {
    const { deps, canvas } = makeDeps();
    const controller = createGraphController(deps);

    const output = await controller.frameNodes(
      Array.from({ length: MAX_TARGETS + 1 }, (_, i) => `n${i}`),
    );

    expect(output).toContain(`at most ${MAX_TARGETS}`);
    expect(canvas.frameNodes).not.toHaveBeenCalled();
  });

  it('reports unresolved targets alongside the highlighted count', async () => {
    const { deps } = makeDeps();
    const controller = createGraphController(deps);

    const output = await controller.setHighlight(['run', 'ghost'], 'ai-tool');

    expect(deps.setHighlightChannel).toHaveBeenCalledWith(
      new Set(['Function:src/a.ts:run']),
      'ai-tool',
    );
    expect(output).toContain('ghost');
  });

  it('captures history before switching view mode, because that resets the camera', async () => {
    const { deps } = makeDeps();
    const controller = createGraphController(deps);

    await controller.setViewMode('tree');

    expect(deps.pushViewHistory).toHaveBeenCalledWith(
      'Before switching to tree view',
      expect.anything(),
    );
    expect(deps.setViewMode).toHaveBeenCalledWith('tree');
  });

  it('converts open_code 1-based lines to 0-based references', async () => {
    const { deps } = makeDeps();
    const controller = createGraphController(deps);

    await controller.openCode({ filePath: 'src/a.ts', startLine: 10, endLine: 20 });

    expect(deps.addCodeReference).toHaveBeenCalledWith(
      expect.objectContaining({ startLine: 9, endLine: 19 }),
    );
  });
});

describe('snapshot', () => {
  it('reports what the user is currently looking at', async () => {
    const { deps } = makeDeps();
    const controller = createGraphController(deps);

    const snapshot = await controller.snapshot();

    expect(snapshot).toMatchObject({
      viewMode: 'force',
      totalNodeCount: 3,
      visibleEdgeTypes: ['CALLS'],
      editingEnabled: false,
    });
  });
});

describe('noop controller', () => {
  it('reports unavailability rather than throwing in chat-only mode', async () => {
    const controller = createNoopGraphController();
    expect(await controller.focusNode('anything')).toContain('not available');
    expect((await controller.snapshot()).totalNodeCount).toBe(0);
  });
});
