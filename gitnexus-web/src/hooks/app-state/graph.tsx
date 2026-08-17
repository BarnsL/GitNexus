import { createContext, useContext, useCallback, useMemo, useState, ReactNode } from 'react';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../core/graph/types';
import { DEFAULT_VISIBLE_LABELS, DEFAULT_VISIBLE_EDGES, type EdgeType } from '../../lib/constants';
import type { GraphMode } from '../../lib/apply-connect-result';

export type { GraphMode };

interface GraphStateContextValue {
  graph: KnowledgeGraph | null;
  setGraph: (graph: KnowledgeGraph | null) => void;
  selectedNode: GraphNode | null;
  setSelectedNode: (node: GraphNode | null) => void;
  visibleLabels: NodeLabel[];
  toggleLabelVisibility: (label: NodeLabel) => void;
  /** Replace the whole set at once — used by the agent's set_filters tool. */
  setVisibleLabels: (labels: NodeLabel[]) => void;
  visibleEdgeTypes: EdgeType[];
  toggleEdgeVisibility: (edgeType: EdgeType) => void;
  setVisibleEdgeTypes: (types: EdgeType[]) => void;
  /** Restore label, edge, and depth filters to their defaults. */
  resetFilters: () => void;
  depthFilter: number | null;
  setDepthFilter: (depth: number | null) => void;
  highlightedNodeIds: Set<string>;
  setHighlightedNodeIds: (ids: Set<string>) => void;
  graphViewMode: 'force' | 'tree' | 'circles' | 'runtime';
  setGraphViewMode: (mode: 'force' | 'tree' | 'circles' | 'runtime') => void;
  /**
   * Whether the in-memory graph was downloaded ('full') or skipped for a large
   * project ('chatOnly'). In chat-only mode `graph` is an empty-but-non-null
   * KnowledgeGraph so existing `graph?.` consumers keep working; this flag is
   * the explicit signal that drives the chat-only empty-state UI. See #2178.
   */
  graphMode: GraphMode;
  setGraphMode: (mode: GraphMode) => void;
  /**
   * Node count of the connected repo when in chat-only mode (from the connect
   * result's repo stats), or null when unknown. Used to size and gate the
   * chat-only empty-state notice and its "load anyway" warning without waiting
   * on the async `availableRepos` list. See #2178.
   */
  chatOnlyNodeCount: number | null;
  setChatOnlyNodeCount: (count: number | null) => void;
}

const GraphStateContext = createContext<GraphStateContextValue | null>(null);

export const GraphStateProvider = ({ children }: { children: ReactNode }) => {
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [visibleLabels, setVisibleLabels] = useState<NodeLabel[]>(DEFAULT_VISIBLE_LABELS);
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<EdgeType[]>(DEFAULT_VISIBLE_EDGES);
  const [depthFilter, setDepthFilter] = useState<number | null>(null);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [graphViewMode, setGraphViewMode] = useState<'force' | 'tree' | 'circles' | 'runtime'>(
    'force',
  );
  const [graphMode, setGraphMode] = useState<GraphMode>('full');
  const [chatOnlyNodeCount, setChatOnlyNodeCount] = useState<number | null>(null);

  const toggleLabelVisibility = useCallback((label: NodeLabel) => {
    setVisibleLabels((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    );
  }, []);

  const toggleEdgeVisibility = useCallback((edgeType: EdgeType) => {
    setVisibleEdgeTypes((prev) =>
      prev.includes(edgeType) ? prev.filter((e) => e !== edgeType) : [...prev, edgeType],
    );
  }, []);

  const resetFilters = useCallback(() => {
    setVisibleLabels(DEFAULT_VISIBLE_LABELS);
    setVisibleEdgeTypes(DEFAULT_VISIBLE_EDGES);
    setDepthFilter(null);
  }, []);

  const value = useMemo<GraphStateContextValue>(
    () => ({
      graph,
      setGraph,
      selectedNode,
      setSelectedNode,
      visibleLabels,
      toggleLabelVisibility,
      setVisibleLabels,
      visibleEdgeTypes,
      toggleEdgeVisibility,
      setVisibleEdgeTypes,
      resetFilters,
      depthFilter,
      setDepthFilter,
      highlightedNodeIds,
      setHighlightedNodeIds,
      graphViewMode,
      setGraphViewMode,
      graphMode,
      setGraphMode,
      chatOnlyNodeCount,
      setChatOnlyNodeCount,
    }),
    [
      graph,
      selectedNode,
      visibleLabels,
      visibleEdgeTypes,
      depthFilter,
      highlightedNodeIds,
      graphViewMode,
      graphMode,
      chatOnlyNodeCount,
      resetFilters,
    ],
  );

  return <GraphStateContext.Provider value={value}>{children}</GraphStateContext.Provider>;
};

export const useGraphState = (): GraphStateContextValue => {
  const ctx = useContext(GraphStateContext);
  if (!ctx) {
    throw new Error('useGraphState must be used within a GraphStateProvider');
  }
  return ctx;
};
