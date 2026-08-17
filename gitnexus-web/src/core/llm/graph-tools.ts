/**
 * Graph navigation tools.
 *
 * These let Nexus drive the user's view instead of describing where to look.
 * Every body is wrapped so a UI failure comes back as text the agent can react
 * to; an exception here would abort the whole turn.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AnimationType } from '../../hooks/useAppState';
import type { HighlightChannel, NexusGraphController } from './graph-controller';

export const GRAPH_CONTROL_TOOL_NAMES = [
  'focus_node',
  'show_neighbors',
  'highlight_nodes',
  'frame_nodes',
  'set_view_mode',
  'set_filters',
  'open_code',
  'graph_snapshot',
  'clear_visuals',
] as const;

/** Highlight style names exposed to the model, mapped to internal channels. */
const STYLE_TO_CHANNEL: Record<string, HighlightChannel> = {
  cyan: 'ai-tool',
  impact: 'blast-radius',
  glow: 'query',
};

const STYLE_TO_ANIMATION: Record<string, AnimationType> = {
  cyan: 'pulse',
  impact: 'ripple',
  glow: 'glow',
};

const MIN_DEPTH = 1;
const MAX_DEPTH = 3;

/** Run a controller call, turning any throw into text for the model. */
const guard = async (run: () => Promise<string>): Promise<string> => {
  try {
    return await run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `The graph action failed: ${message}`;
  }
};

export const createGraphControlTools = (ui: NexusGraphController) => {
  const focusNodeTool = tool(
    async ({ target, zoom, openCode }: { target: string; zoom?: number; openCode?: boolean }) =>
      guard(() => ui.focusNode(target, { zoom, openCode })),
    {
      name: 'focus_node',
      description:
        'Move the camera to a symbol, select it, and open its source in the Code Inspector. Use this whenever your answer has one clear subject so the user does not have to find it themselves. Changes the camera destination at most once per reply.',
      schema: z.object({
        target: z
          .string()
          .describe(
            'Node id, Label:Name (e.g. "Function:validateUser"), file path, or bare symbol name.',
          ),
        zoom: z
          .number()
          .min(0.01)
          .max(2)
          .optional()
          .describe('Camera ratio. Lower is closer. Defaults to 0.15.'),
        openCode: z
          .boolean()
          .optional()
          .describe('Set false to move the camera without opening the Code Inspector.'),
      }),
    },
  );

  const showNeighborsTool = tool(
    async ({
      target,
      depth,
      direction,
      edgeTypes,
    }: {
      target: string;
      depth?: number;
      direction?: 'in' | 'out' | 'both';
      edgeTypes?: string[];
    }) =>
      guard(() =>
        ui.neighbors(target, {
          depth: Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, depth ?? 1)),
          direction,
          edgeTypes,
        }),
      ),
    {
      name: 'show_neighbors',
      description:
        'Highlight what a symbol connects to and return each relationship with its type and direction, so you can explain the consequences of changing it. Relationships reported as not currently drawn are still real — never say they do not exist.',
      schema: z.object({
        target: z.string().describe('Node id, Label:Name, file path, or bare symbol name.'),
        depth: z.number().int().optional().describe('Hops to walk, 1 to 3. Defaults to 1.'),
        direction: z
          .enum(['in', 'out', 'both'])
          .optional()
          .describe('"in" for callers, "out" for callees, "both" by default.'),
        edgeTypes: z
          .array(z.string())
          .optional()
          .describe('Restrict to these relationship types, e.g. ["CALLS"].'),
      }),
    },
  );

  const highlightNodesTool = tool(
    async ({
      targets,
      style,
      animate,
    }: {
      targets: string[];
      style?: 'cyan' | 'impact' | 'glow';
      animate?: boolean;
    }) =>
      guard(async () => {
        const chosen = style ?? 'cyan';
        const result = await ui.setHighlight(targets, STYLE_TO_CHANNEL[chosen]);
        if (animate) {
          await ui.animate(targets, STYLE_TO_ANIMATION[chosen]);
        }
        return result;
      }),
    {
      name: 'highlight_nodes',
      description:
        'Light up a set of nodes. Use "cyan" for relevance, "impact" for blast radius, "glow" for emphasis.',
      schema: z.object({
        targets: z.array(z.string()).describe('Node ids, Label:Name refs, paths, or symbol names.'),
        style: z.enum(['cyan', 'impact', 'glow']).optional(),
        animate: z.boolean().optional().describe('Also play a matching animation.'),
      }),
    },
  );

  const frameNodesTool = tool(
    async ({ targets, padding }: { targets: string[]; padding?: number }) =>
      guard(() => ui.frameNodes(targets, { padding })),
    {
      name: 'frame_nodes',
      description:
        'Fit the camera around several symbols at once. Prefer this over repeated focus_node calls when a whole call chain matters equally.',
      schema: z.object({
        targets: z.array(z.string()).describe('Node ids, Label:Name refs, paths, or symbol names.'),
        padding: z.number().optional().describe('Framing margin. Defaults to 1.4.'),
      }),
    },
  );

  const setViewModeTool = tool(
    async ({ mode }: { mode: 'force' | 'tree' | 'circles' | 'runtime' }) =>
      guard(() => ui.setViewMode(mode)),
    {
      name: 'set_view_mode',
      description:
        'Switch the graph layout. "force" is the default cloud, "tree" is sequential, "circles" is radial, "runtime" shows live execution.',
      schema: z.object({ mode: z.enum(['force', 'tree', 'circles', 'runtime']) }),
    },
  );

  const setFiltersTool = tool(
    async ({
      nodeLabels,
      edgeTypes,
      depth,
    }: {
      nodeLabels?: string[];
      edgeTypes?: string[];
      depth?: number | null;
    }) => guard(() => ui.setFilters({ nodeLabels, edgeTypes, depth })),
    {
      name: 'set_filters',
      description:
        'Change which node labels, edge types, or hop depth are visible. Use this to reveal a relationship type that show_neighbors reported as not drawn.',
      schema: z.object({
        nodeLabels: z.array(z.string()).optional(),
        edgeTypes: z
          .array(z.string())
          .optional()
          .describe('Any of CONTAINS, DEFINES, IMPORTS, CALLS, EXTENDS, IMPLEMENTS.'),
        depth: z
          .number()
          .int()
          .nullable()
          .optional()
          .describe('Hops from the selection to keep visible, or null to clear.'),
      }),
    },
  );

  const openCodeTool = tool(
    async ({
      filePath,
      startLine,
      endLine,
    }: {
      filePath: string;
      startLine?: number;
      endLine?: number;
    }) => guard(() => ui.openCode({ filePath, startLine, endLine })),
    {
      name: 'open_code',
      description:
        'Open a file in the Code Inspector at a line range, without needing a graph node.',
      schema: z.object({
        filePath: z.string().describe('Repo-relative or partial file path.'),
        startLine: z.number().int().optional().describe('1-based start line.'),
        endLine: z.number().int().optional().describe('1-based end line.'),
      }),
    },
  );

  const graphSnapshotTool = tool(
    async () =>
      guard(async () => {
        const snapshot = await ui.snapshot();
        return JSON.stringify(snapshot, null, 2);
      }),
    {
      name: 'graph_snapshot',
      description:
        'Read what the user is currently looking at: view mode, selection, filters, highlight counts, and whether editing is enabled. Call this before changing the view if the current state matters.',
      schema: z.object({}),
    },
  );

  const clearVisualsTool = tool(
    async ({ scope }: { scope?: 'highlights' | 'filters' | 'all' }) =>
      guard(() => ui.clearVisuals(scope)),
    {
      name: 'clear_visuals',
      description: 'Reset highlights, filters, or both.',
      schema: z.object({ scope: z.enum(['highlights', 'filters', 'all']).optional() }),
    },
  );

  return [
    focusNodeTool,
    showNeighborsTool,
    highlightNodesTool,
    frameNodesTool,
    setViewModeTool,
    setFiltersTool,
    openCodeTool,
    graphSnapshotTool,
    clearVisualsTool,
  ];
};
