import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import { RightPanel } from '../../src/components/RightPanel';

/**
 * Regression coverage for the dead AI citation click path.
 *
 * `resolveFilePathForUI` in RightPanel was stubbed to always return null, so
 * every `code-ref:` and `node-ref:` click returned early before reaching
 * `addCodeReference`. Nothing ever opened in the Code Inspector, which forced
 * the user to locate the node by hand. These tests pin the wiring so the stub
 * cannot come back.
 */

const fileNode: GraphNode = {
  id: 'File:src/providers.js',
  label: 'File',
  properties: { name: 'providers.js', filePath: 'src/providers.js' },
};

const functionNode: GraphNode = {
  id: 'Function:src/providers.js:envBaseFor',
  label: 'Function',
  properties: {
    name: 'envBaseFor',
    filePath: 'src/providers.js',
    startLine: 24,
    endLine: 26,
  },
};

const graph = {
  nodes: [fileNode, functionNode],
  relationships: [],
  nodeCount: 2,
  relationshipCount: 0,
};

// Real resolver semantics, mirroring useAppState's implementation: exact match
// on the normalized path, then suffix match for partial paths.
const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\//, '');
const resolveFilePath = vi.fn((requested: string): string | null => {
  const target = normalize(requested);
  for (const node of graph.nodes) {
    if (node.label !== 'File') continue;
    const candidate = normalize(node.properties.filePath as string);
    if (candidate === target || candidate.endsWith(target))
      return node.properties.filePath as string;
  }
  return null;
});
const findFileNodeId = vi.fn(
  (filePath: string): string | undefined =>
    graph.nodes.find(
      (n) =>
        n.label === 'File' && normalize(n.properties.filePath as string) === normalize(filePath),
    )?.id,
);

const addCodeReference = vi.fn();

const appState = {
  isRightPanelOpen: true,
  setRightPanelOpen: vi.fn(),
  graph,
  graphMode: 'full',
  addCodeReference,
  resolveFilePath,
  findFileNodeId,
  chatMessages: [
    {
      id: 'm1',
      role: 'assistant' as const,
      content:
        'The fallback lives in [[src/providers.js:30-55]] and is produced by [[Function:envBaseFor]].',
      timestamp: 0,
    },
  ],
  isChatLoading: false,
  currentToolCalls: [],
  agentError: null,
  dismissAgentError: vi.fn(),
  isAgentReady: true,
  isAgentInitializing: false,
  sendChatMessage: vi.fn(),
  stopChatResponse: vi.fn(),
  clearChat: vi.fn(),
};

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => appState,
}));

vi.mock('../../src/components/ProcessesPanel', () => ({
  ProcessesPanel: () => null,
}));

vi.mock('../../src/core/llm/settings-service', () => ({
  isProviderConfigured: () => true,
}));

describe('AI citation click path', () => {
  beforeEach(() => {
    addCodeReference.mockClear();
    resolveFilePath.mockClear();
  });

  it('opens the Code Inspector when a file citation is clicked', () => {
    render(<RightPanel />);

    fireEvent.click(screen.getByText('src/providers.js:30-55'));

    expect(addCodeReference).toHaveBeenCalledTimes(1);
    expect(addCodeReference).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: 'src/providers.js',
        // Citations are 1-based; CodeReference line numbers are 0-based.
        startLine: 29,
        endLine: 54,
        nodeId: 'File:src/providers.js',
        source: 'ai',
      }),
    );
  });

  it('resolves the citation through the shared resolver rather than a stub', () => {
    render(<RightPanel />);

    fireEvent.click(screen.getByText('src/providers.js:30-55'));

    expect(resolveFilePath).toHaveBeenCalledWith('src/providers.js');
  });

  it('opens the Code Inspector when a symbol citation is clicked', () => {
    render(<RightPanel />);

    fireEvent.click(screen.getByText('Function:envBaseFor'));

    expect(addCodeReference).toHaveBeenCalledTimes(1);
    expect(addCodeReference).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: 'src/providers.js',
        // Graph line numbers are 1-based (ast-helpers emits
        // `startPosition.row + 1`); CodeReference line numbers are 0-based.
        startLine: 23,
        endLine: 25,
        nodeId: 'Function:src/providers.js:envBaseFor',
        source: 'ai',
      }),
    );
  });
});
