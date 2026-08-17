/**
 * Shared target resolution.
 *
 * Agent tools, grounding clicks, and tool-result markers all need to turn a
 * loosely-specified target ("envBaseFor", "providers.js", "Function:validate",
 * or a full node id) into a graph node. Three ad-hoc implementations of this
 * used to exist; this module is the single canonical one.
 *
 * Ambiguity is reported rather than silently resolved. Picking the first of
 * several same-named symbols is how an agent ends up confidently describing the
 * wrong file.
 */

import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';
import { normalizePath } from './path-resolution';

/** Minimal shape needed to resolve; avoids requiring the full graph container. */
export type ResolvableGraph = Pick<KnowledgeGraph, 'nodes'>;

export type TargetResolution =
  | { kind: 'match'; nodeId: string; node: GraphNode }
  | { kind: 'ambiguous'; candidates: GraphNode[] }
  | { kind: 'miss'; reason: string };

/** Upper bound on candidates reported back to the model for an ambiguous target. */
const MAX_CANDIDATES = 10;

/** Node labels whose `name` property holds a path rather than a symbol name. */
const PATH_LABELS = new Set(['File', 'Folder']);

const decide = (matches: GraphNode[]): TargetResolution | null => {
  if (matches.length === 1) {
    return { kind: 'match', nodeId: matches[0].id, node: matches[0] };
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', candidates: matches.slice(0, MAX_CANDIDATES) };
  }
  return null;
};

const filePathOf = (node: GraphNode): string | undefined => {
  const raw = node.properties?.filePath;
  return typeof raw === 'string' ? raw : undefined;
};

/** Shorter paths first, so `src/a.ts` beats `vendor/copy/src/a.ts` on a tie. */
const byPathLength = (a: GraphNode, b: GraphNode): number =>
  (filePathOf(a)?.length ?? 0) - (filePathOf(b)?.length ?? 0);

export const resolveTarget = (
  graph: ResolvableGraph | null | undefined,
  target: string,
): TargetResolution => {
  const raw = target?.trim() ?? '';
  if (!graph || graph.nodes.length === 0) {
    return { kind: 'miss', reason: 'No graph is loaded.' };
  }
  if (!raw) {
    return { kind: 'miss', reason: 'Empty target.' };
  }

  // 1. Exact node id — `File:src/a.ts` or `Function:src/a.ts:run`.
  const exactId = graph.nodes.find((n) => n.id === raw);
  if (exactId) {
    return { kind: 'match', nodeId: exactId.id, node: exactId };
  }

  // 2. Typed reference — `Label:Name`.
  const typed = raw.match(/^([A-Z][A-Za-z]*):(.+)$/);
  if (typed) {
    const [, label, rest] = typed;
    const wanted = rest.trim();

    const byLabelName = decide(
      graph.nodes.filter((n) => n.label === label && n.properties?.name === wanted),
    );
    if (byLabelName) return byLabelName;

    // File/Folder nodes carry a path in `name`, so also try a path suffix.
    if (PATH_LABELS.has(label)) {
      const normalized = normalizePath(wanted);
      const byLabelPath = decide(
        graph.nodes
          .filter((n) => {
            if (n.label !== label) return false;
            const path = filePathOf(n);
            return path !== undefined && normalizePath(path).endsWith(normalized);
          })
          .sort(byPathLength),
      );
      if (byLabelPath) return byLabelPath;
    }
  }

  // 3. File path — exact, then shortest suffix. Only attempted when the target
  //    looks like a path, so a bare symbol name never matches a file by accident.
  const normalized = normalizePath(raw);
  if (normalized.includes('/') || normalized.includes('.')) {
    const fileNodes = graph.nodes.filter((n) => n.label === 'File' && filePathOf(n) !== undefined);

    const exactPath = fileNodes.find((n) => normalizePath(filePathOf(n)!) === normalized);
    if (exactPath) {
      return { kind: 'match', nodeId: exactPath.id, node: exactPath };
    }

    const suffixMatches = fileNodes
      .filter((n) => normalizePath(filePathOf(n)!).endsWith(`/${normalized}`))
      .sort(byPathLength);
    // A single shortest match wins outright; ties stay ambiguous.
    if (suffixMatches.length === 1) {
      return { kind: 'match', nodeId: suffixMatches[0].id, node: suffixMatches[0] };
    }
    if (suffixMatches.length > 1) {
      const shortest = filePathOf(suffixMatches[0])!.length;
      const tied = suffixMatches.filter((n) => filePathOf(n)!.length === shortest);
      const resolved = decide(tied);
      if (resolved) return resolved;
    }
  }

  // 4. Bare symbol name — exact, then case-insensitive, then node-id suffix.
  const byName = decide(graph.nodes.filter((n) => n.properties?.name === raw));
  if (byName) return byName;

  const lower = raw.toLowerCase();
  const byNameCI = decide(
    graph.nodes.filter(
      (n) => typeof n.properties?.name === 'string' && n.properties.name.toLowerCase() === lower,
    ),
  );
  if (byNameCI) return byNameCI;

  const byIdSuffix = decide(graph.nodes.filter((n) => n.id.endsWith(`:${raw}`)));
  if (byIdSuffix) return byIdSuffix;

  return { kind: 'miss', reason: `No node matched "${raw}".` };
};

/**
 * Resolve a batch, partitioning the outcomes. Used by the tool-result marker
 * parser and by any tool accepting a list of targets.
 */
export const resolveTargets = (
  graph: ResolvableGraph | null | undefined,
  targets: string[],
): { resolved: string[]; unresolved: string[]; ambiguous: string[] } => {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const ambiguous: string[] = [];

  for (const target of targets) {
    const result = resolveTarget(graph, target);
    if (result.kind === 'match') resolved.push(result.nodeId);
    else if (result.kind === 'ambiguous') ambiguous.push(target);
    else unresolved.push(target);
  }

  return { resolved, unresolved, ambiguous };
};

/** Human-readable candidate list for reporting ambiguity back to the model. */
export const describeCandidates = (candidates: GraphNode[]): string =>
  candidates
    .map((n) => `${n.label}:${n.properties?.name ?? '?'} (${filePathOf(n) ?? 'unknown file'})`)
    .join(', ');
