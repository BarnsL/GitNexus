/**
 * NexusGraphController — the agent's typed handle on the graph UI.
 *
 * Replaces the string-marker side channel for new capabilities. Tools call
 * these methods directly and return the resulting string to the model, so a
 * failure surfaces as text the agent can reason about rather than an exception
 * that aborts the turn.
 *
 * Every method that resolves a target reports ambiguity and misses back to the
 * model instead of guessing.
 */

import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../core/graph/types';
import type { CameraState, NeighborEdge, NeighborQueryDirection } from '../../hooks/useSigma';
import type { AnimationType, GraphViewMode, ViewHistoryEntry } from '../../hooks/useAppState';
import { describeCandidates, resolveTarget, resolveTargets } from '../../lib/target-resolution';

export type HighlightChannel = 'ai-tool' | 'blast-radius' | 'query';

/** Bound on targets accepted in one call, to keep results readable. */
export const MAX_TARGETS = 100;
/** Bound on neighbors reported back to the model in one call. */
export const MAX_NEIGHBORS_REPORTED = 50;

export interface GraphSnapshot {
  viewMode: GraphViewMode;
  selectedNodeId: string | null;
  selectedNodeName: string | null;
  totalNodeCount: number;
  visibleEdgeTypes: string[];
  depthFilter: number | null;
  highlightCounts: Record<HighlightChannel, number>;
  editingEnabled: boolean;
  historyDepth: number;
}

export interface NexusGraphController {
  focusNode(target: string, opts?: { zoom?: number; openCode?: boolean }): Promise<string>;
  frameNodes(targets: string[], opts?: { padding?: number }): Promise<string>;
  setHighlight(targets: string[], channel: HighlightChannel): Promise<string>;
  animate(targets: string[], type: AnimationType, durationMs?: number): Promise<string>;
  setViewMode(mode: GraphViewMode): Promise<string>;
  setFilters(opts: {
    nodeLabels?: string[];
    edgeTypes?: string[];
    depth?: number | null;
  }): Promise<string>;
  openCode(opts: { filePath: string; startLine?: number; endLine?: number }): Promise<string>;
  neighbors(
    target: string,
    opts?: { depth?: number; direction?: NeighborQueryDirection; edgeTypes?: string[] },
  ): Promise<string>;
  snapshot(): Promise<GraphSnapshot>;
  clearVisuals(scope?: 'highlights' | 'filters' | 'all'): Promise<string>;
}

/**
 * The subset of GraphCanvasHandle the controller uses. Declared structurally so
 * the controller does not depend on the component module.
 */
export interface NexusCanvasHandle {
  focusNode: (nodeId: string, opts?: { zoom?: number; duration?: number }) => void;
  frameNodes: (nodeIds: string[], opts?: { padding?: number; duration?: number }) => void;
  getCameraState: () => CameraState | null;
  getNeighbors: (
    nodeId: string,
    opts?: { depth?: number; direction?: NeighborQueryDirection; edgeTypes?: string[] },
  ) => NeighborEdge[];
}

/** Everything the controller needs from app state. */
export interface GraphControllerDeps {
  getGraph: () => KnowledgeGraph | null;
  getCanvas: () => NexusCanvasHandle | null;
  setHighlightChannel: (nodeIds: Set<string>, channel: HighlightChannel) => void;
  triggerNodeAnimation: (nodeIds: string[], type: AnimationType, durationMs?: number) => void;
  getViewMode: () => GraphViewMode;
  setViewMode: (mode: GraphViewMode) => void;
  setVisibleEdgeTypes: (types: string[]) => void;
  getVisibleEdgeTypes: () => string[];
  setVisibleLabels: (labels: string[]) => void;
  setDepthFilter: (depth: number | null) => void;
  getDepthFilter: () => number | null;
  addCodeReference: (ref: {
    filePath: string;
    startLine?: number;
    endLine?: number;
    nodeId?: string;
    label?: string;
    name?: string;
    source: 'ai' | 'user';
  }) => void;
  resolveFilePath: (path: string) => string | null;
  getSelectedNode: () => GraphNode | null;
  setSelectedNode: (node: GraphNode | null) => void;
  pushViewHistory: (label: string, entry: Omit<ViewHistoryEntry, 'id' | 'label' | 'ts'>) => void;
  getHistoryDepth: () => number;
  getHighlightCounts: () => Record<HighlightChannel, number>;
  isEditingEnabled: () => boolean;
  clearHighlights: () => void;
  clearAnimations: () => void;
  resetFilters: () => void;
}

const NO_CANVAS = 'The graph view is not available right now.';

/** Describe a resolution failure in terms the model can act on. */
const explainFailure = (target: string, result: ReturnType<typeof resolveTarget>): string => {
  if (result.kind === 'ambiguous') {
    return `"${target}" is ambiguous — ${result.candidates.length} nodes match: ${describeCandidates(result.candidates)}. Re-run with a file path or a full node id.`;
  }
  return result.kind === 'miss' ? result.reason : '';
};

const describeNode = (node: GraphNode): string => {
  const file = node.properties?.filePath;
  const start = node.properties?.startLine;
  const end = node.properties?.endLine;
  const range =
    typeof start === 'number' ? `:${start}${typeof end === 'number' ? `-${end}` : ''}` : '';
  return `${node.label}:${node.properties?.name ?? node.id}${file ? ` (${file}${range})` : ''}`;
};

export const createGraphController = (deps: GraphControllerDeps): NexusGraphController => {
  /** Capture the current view so the user can undo whatever we are about to do. */
  const capture = (label: string): void => {
    const canvas = deps.getCanvas();
    deps.pushViewHistory(label, {
      camera: canvas?.getCameraState() ?? null,
      selectedNodeId: deps.getSelectedNode()?.id ?? null,
      viewMode: deps.getViewMode(),
    });
  };

  const resolveOne = (target: string): { node: GraphNode } | { error: string } => {
    const result = resolveTarget(deps.getGraph(), target);
    if (result.kind === 'match') return { node: result.node };
    return { error: explainFailure(target, result) };
  };

  return {
    async focusNode(target, opts) {
      const canvas = deps.getCanvas();
      if (!canvas) return NO_CANVAS;

      const resolved = resolveOne(target);
      if ('error' in resolved) return resolved.error;
      const { node } = resolved;

      capture(`Before focusing ${node.properties?.name ?? node.id}`);
      canvas.focusNode(node.id, { zoom: opts?.zoom });
      deps.setSelectedNode(node);

      // Open the source unless explicitly told not to. Graph line numbers are
      // 1-based; CodeReference line numbers are 0-based.
      const filePath = node.properties?.filePath;
      if (opts?.openCode !== false && typeof filePath === 'string') {
        const startLine = node.properties?.startLine;
        const endLine = node.properties?.endLine;
        deps.addCodeReference({
          filePath: deps.resolveFilePath(filePath) ?? filePath,
          startLine: typeof startLine === 'number' ? Math.max(0, startLine - 1) : undefined,
          endLine: typeof endLine === 'number' ? Math.max(0, endLine - 1) : undefined,
          nodeId: node.id,
          label: node.label,
          name: node.properties?.name,
          source: 'ai',
        });
      }

      return `Focused the graph on ${describeNode(node)}. The node is selected and its source is open in the Code Inspector.`;
    },

    async frameNodes(targets, opts) {
      const canvas = deps.getCanvas();
      if (!canvas) return NO_CANVAS;
      if (targets.length > MAX_TARGETS) {
        return `Provide at most ${MAX_TARGETS} targets (received ${targets.length}).`;
      }

      const { resolved, unresolved, ambiguous } = resolveTargets(deps.getGraph(), targets);
      if (resolved.length === 0) {
        return `None of those targets resolved to a graph node: ${targets.join(', ')}.`;
      }

      capture(`Before framing ${resolved.length} nodes`);
      canvas.frameNodes(resolved, { padding: opts?.padding });

      const notes: string[] = [];
      if (unresolved.length) notes.push(`not found: ${unresolved.join(', ')}`);
      if (ambiguous.length) notes.push(`ambiguous: ${ambiguous.join(', ')}`);
      return `Framed ${resolved.length} node(s) in view.${notes.length ? ` (${notes.join('; ')})` : ''}`;
    },

    async setHighlight(targets, channel) {
      if (targets.length > MAX_TARGETS) {
        return `Provide at most ${MAX_TARGETS} targets (received ${targets.length}).`;
      }
      const { resolved, unresolved, ambiguous } = resolveTargets(deps.getGraph(), targets);
      deps.setHighlightChannel(new Set(resolved), channel);

      const notes: string[] = [];
      if (unresolved.length) notes.push(`not found: ${unresolved.join(', ')}`);
      if (ambiguous.length) notes.push(`ambiguous: ${ambiguous.join(', ')}`);
      return `Highlighted ${resolved.length} node(s).${notes.length ? ` (${notes.join('; ')})` : ''}`;
    },

    async animate(targets, type, durationMs) {
      const { resolved } = resolveTargets(deps.getGraph(), targets);
      if (resolved.length === 0) return 'No targets resolved, so nothing was animated.';
      deps.triggerNodeAnimation(resolved, type, durationMs);
      return `Playing a ${type} animation on ${resolved.length} node(s).`;
    },

    async setViewMode(mode) {
      // Layout switching resets the camera, so capture before switching.
      capture(`Before switching to ${mode} view`);
      deps.setViewMode(mode);
      return `Switched the graph to ${mode} view.`;
    },

    async setFilters(opts) {
      const changes: string[] = [];
      if (opts.edgeTypes) {
        deps.setVisibleEdgeTypes(opts.edgeTypes);
        changes.push(`edge types: ${opts.edgeTypes.join(', ') || 'none'}`);
      }
      if (opts.nodeLabels) {
        deps.setVisibleLabels(opts.nodeLabels);
        changes.push(`node labels: ${opts.nodeLabels.join(', ') || 'none'}`);
      }
      if (opts.depth !== undefined) {
        deps.setDepthFilter(opts.depth);
        changes.push(opts.depth === null ? 'depth filter cleared' : `depth: ${opts.depth} hop(s)`);
      }
      return changes.length
        ? `Updated filters — ${changes.join('; ')}.`
        : 'No filter changes requested.';
    },

    async openCode({ filePath, startLine, endLine }) {
      const resolvedPath = deps.resolveFilePath(filePath);
      if (!resolvedPath) {
        return `No file in the graph matched "${filePath}".`;
      }
      // Tool arguments are 1-based; CodeReference is 0-based.
      const start = typeof startLine === 'number' ? Math.max(0, startLine - 1) : undefined;
      const end = typeof endLine === 'number' ? Math.max(0, endLine - 1) : start;
      deps.addCodeReference({
        filePath: resolvedPath,
        startLine: start,
        endLine: end,
        label: 'File',
        name: resolvedPath.split('/').pop() ?? resolvedPath,
        source: 'ai',
      });
      const where = typeof startLine === 'number' ? ` at line ${startLine}` : '';
      return `Opened ${resolvedPath}${where} in the Code Inspector.`;
    },

    async neighbors(target, opts) {
      const canvas = deps.getCanvas();
      if (!canvas) return NO_CANVAS;

      const resolved = resolveOne(target);
      if ('error' in resolved) return resolved.error;
      const { node } = resolved;

      const all = canvas.getNeighbors(node.id, opts);
      if (all.length === 0) {
        return `${describeNode(node)} has no connections matching that filter. Note this may mean the relationships are not resolvable by the index, not that none exist.`;
      }

      deps.setHighlightChannel(new Set([node.id, ...all.map((n) => n.nodeId)]), 'ai-tool');

      const shown = all.slice(0, MAX_NEIGHBORS_REPORTED);
      const drawn = shown.filter((n) => n.rendered);
      const hidden = shown.filter((n) => !n.rendered);

      const format = (n: NeighborEdge) =>
        n.direction === 'out'
          ? `  ${node.properties?.name ?? node.id} -[${n.relationship}]-> ${n.name} (${n.label}${n.filePath ? `, ${n.filePath}` : ''})`
          : `  ${n.name} (${n.label}${n.filePath ? `, ${n.filePath}` : ''}) -[${n.relationship}]-> ${node.properties?.name ?? node.id}`;

      const parts: string[] = [
        `${describeNode(node)} connects to ${all.length} node(s). Highlighted them in the graph.`,
      ];
      if (drawn.length) {
        parts.push(`\nDrawn in the current view:\n${drawn.map(format).join('\n')}`);
      }
      if (hidden.length) {
        parts.push(
          `\nThese relationships are real but NOT currently drawn (filtered out, or the type has no renderable form). Do not tell the user they do not exist:\n${hidden.map(format).join('\n')}`,
        );
      }
      if (all.length > shown.length) {
        parts.push(`\nShowing the first ${shown.length} of ${all.length}.`);
      }
      return parts.join('\n');
    },

    async snapshot() {
      const graph = deps.getGraph();
      const selected = deps.getSelectedNode();
      return {
        viewMode: deps.getViewMode(),
        selectedNodeId: selected?.id ?? null,
        selectedNodeName: (selected?.properties?.name as string | undefined) ?? null,
        totalNodeCount: graph?.nodes.length ?? 0,
        visibleEdgeTypes: deps.getVisibleEdgeTypes(),
        depthFilter: deps.getDepthFilter(),
        highlightCounts: deps.getHighlightCounts(),
        editingEnabled: deps.isEditingEnabled(),
        historyDepth: deps.getHistoryDepth(),
      };
    },

    async clearVisuals(scope = 'highlights') {
      if (scope === 'highlights' || scope === 'all') {
        deps.clearHighlights();
        deps.clearAnimations();
      }
      if (scope === 'filters' || scope === 'all') {
        deps.resetFilters();
      }
      return `Cleared ${scope === 'all' ? 'highlights and filters' : scope}.`;
    },
  };
};

/** Controller used when no graph canvas is mounted (chat-only mode). */
export const createNoopGraphController = (): NexusGraphController => {
  const unavailable = async () => NO_CANVAS;
  return {
    focusNode: unavailable,
    frameNodes: unavailable,
    setHighlight: unavailable,
    animate: unavailable,
    setViewMode: unavailable,
    setFilters: unavailable,
    openCode: unavailable,
    neighbors: unavailable,
    clearVisuals: unavailable,
    async snapshot() {
      return {
        viewMode: 'force',
        selectedNodeId: null,
        selectedNodeName: null,
        totalNodeCount: 0,
        visibleEdgeTypes: [],
        depthFilter: null,
        highlightCounts: { 'ai-tool': 0, 'blast-radius': 0, query: 0 },
        editingEnabled: false,
        historyDepth: 0,
      };
    },
  };
};
