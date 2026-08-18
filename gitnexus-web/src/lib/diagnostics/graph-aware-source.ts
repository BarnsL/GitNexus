/**
 * Graph-aware diagnostics.
 *
 * The capability unique to GitNexus: the editor knows what calls the symbol you
 * are editing. Removing or renaming something with callers raises a warning
 * naming the caller count, sourced from the same graph data as impact analysis.
 *
 * Wording matters here. An empty caller set is NOT evidence a symbol is unused
 * — it can equally mean the callers are not resolvable by the index (dynamic
 * dispatch, plain-object property access, cross-language calls). These
 * diagnostics say "no resolvable references", never "unused".
 */

import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import type { EditorDiagnostic } from '../../components/CodeEditor';
import { normalizePath } from '../path-resolution';

export interface GraphLike {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

/** Labels that represent an editable declaration rather than a container. */
const SYMBOL_LABELS = new Set(['Function', 'Class', 'Method', 'Interface', 'CodeElement']);

/**
 * Whether a symbol name still appears as a declaration in the buffer.
 *
 * Deliberately a word-boundary text check rather than a parse: this runs on
 * every keystroke (debounced) across sixteen languages, and a false negative
 * here only costs an advisory warning, never correctness.
 */
const declaresSymbol = (content: string, name: string): boolean => {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(content);
};

const inboundCount = (graph: GraphLike, nodeId: string): number =>
  graph.relationships.filter((rel) => rel.targetId === nodeId).length;

export const computeGraphAwareDiagnostics = (
  graph: GraphLike | null | undefined,
  filePath: string,
  content: string,
): EditorDiagnostic[] => {
  if (!graph) return [];

  const target = normalizePath(filePath);
  const symbols = graph.nodes.filter((node) => {
    if (!SYMBOL_LABELS.has(node.label)) return false;
    const path = node.properties?.filePath;
    return typeof path === 'string' && normalizePath(path) === target;
  });

  if (symbols.length === 0) return [];

  const diagnostics: EditorDiagnostic[] = [];

  for (const symbol of symbols) {
    const name = symbol.properties?.name;
    if (typeof name !== 'string') continue;

    // Graph line numbers are 1-based; EditorDiagnostic lines are 0-based.
    const startLine = symbol.properties?.startLine;
    const line = typeof startLine === 'number' ? Math.max(0, startLine - 1) : 0;
    const endRaw = symbol.properties?.endLine;
    const endLine = typeof endRaw === 'number' ? Math.max(0, endRaw - 1) : line;

    const callers = inboundCount(graph, symbol.id);

    if (!declaresSymbol(content, name)) {
      if (callers > 0) {
        diagnostics.push({
          line,
          endLine,
          severity: 'warning',
          source: 'graph',
          message: `"${name}" no longer appears in this file but has ${callers} caller${callers === 1 ? '' : 's'} in the graph. Removing or renaming it breaks them.`,
        });
      }
      continue;
    }

    if (callers === 0) {
      diagnostics.push({
        line,
        endLine,
        severity: 'info',
        source: 'graph',
        // Deliberately avoids the word "unused": callers may exist and simply
        // not be resolvable by the index, so this is not evidence of dead code.
        message: `"${name}" has no resolvable references. Callers may exist that the index cannot resolve, so this is not evidence it can be safely removed.`,
      });
    }
  }

  return diagnostics;
};
