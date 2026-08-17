import { describe, expect, it } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import {
  describeCandidates,
  resolveTarget,
  resolveTargets,
  type ResolvableGraph,
} from '../../src/lib/target-resolution';

const node = (id: string, label: string, name: string, filePath?: string): GraphNode =>
  ({ id, label, properties: { name, ...(filePath ? { filePath } : {}) } }) as GraphNode;

const graph: ResolvableGraph = {
  nodes: [
    node('File:src/providers.js', 'File', 'providers.js', 'src/providers.js'),
    node(
      'File:vendor/copy/src/providers.js',
      'File',
      'providers.js',
      'vendor/copy/src/providers.js',
    ),
    node('File:src/config.js', 'File', 'config.js', 'src/config.js'),
    node('Function:src/providers.js:envBaseFor', 'Function', 'envBaseFor', 'src/providers.js'),
    node('Function:src/config.js:envBaseFor', 'Function', 'envBaseFor', 'src/config.js'),
    node('Function:src/config.js:loadConfig', 'Function', 'loadConfig', 'src/config.js'),
    node('Class:src/config.js:ConfigStore', 'Class', 'ConfigStore', 'src/config.js'),
  ],
};

describe('resolveTarget', () => {
  it('resolves an exact node id', () => {
    const result = resolveTarget(graph, 'Function:src/providers.js:envBaseFor');
    expect(result).toMatchObject({
      kind: 'match',
      nodeId: 'Function:src/providers.js:envBaseFor',
    });
  });

  it('resolves a typed Label:Name reference when unique', () => {
    expect(resolveTarget(graph, 'Class:ConfigStore')).toMatchObject({
      kind: 'match',
      nodeId: 'Class:src/config.js:ConfigStore',
    });
  });

  it('resolves a unique bare symbol name', () => {
    expect(resolveTarget(graph, 'loadConfig')).toMatchObject({
      kind: 'match',
      nodeId: 'Function:src/config.js:loadConfig',
    });
  });

  it('resolves an exact file path', () => {
    expect(resolveTarget(graph, 'src/config.js')).toMatchObject({
      kind: 'match',
      nodeId: 'File:src/config.js',
    });
  });

  it('prefers the shortest path when a partial path matches several files', () => {
    expect(resolveTarget(graph, 'providers.js')).toMatchObject({
      kind: 'match',
      nodeId: 'File:src/providers.js',
    });
  });

  it('normalizes backslashes and a leading ./ before matching', () => {
    expect(resolveTarget(graph, './src\\config.js')).toMatchObject({
      kind: 'match',
      nodeId: 'File:src/config.js',
    });
  });

  it('reports ambiguity for a symbol defined in two files', () => {
    const result = resolveTarget(graph, 'envBaseFor');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('does not resolve a bare symbol name to a file node', () => {
    // "config" is not a file path and matches no symbol; it must miss rather
    // than fuzzily latch onto src/config.js.
    expect(resolveTarget(graph, 'config').kind).toBe('miss');
  });

  it('matches a symbol name case-insensitively when no exact match exists', () => {
    expect(resolveTarget(graph, 'loadconfig')).toMatchObject({
      kind: 'match',
      nodeId: 'Function:src/config.js:loadConfig',
    });
  });

  it('reports a miss with a reason naming the target', () => {
    const result = resolveTarget(graph, 'nothingHere');
    expect(result.kind).toBe('miss');
    if (result.kind === 'miss') {
      expect(result.reason).toContain('nothingHere');
    }
  });

  it('reports a miss when the graph is null', () => {
    expect(resolveTarget(null, 'anything')).toMatchObject({ kind: 'miss' });
  });

  it('reports a miss for an empty target', () => {
    expect(resolveTarget(graph, '   ')).toMatchObject({ kind: 'miss' });
  });
});

describe('resolveTargets', () => {
  it('partitions a batch into resolved, unresolved, and ambiguous', () => {
    const result = resolveTargets(graph, ['loadConfig', 'nothingHere', 'envBaseFor']);
    expect(result.resolved).toEqual(['Function:src/config.js:loadConfig']);
    expect(result.unresolved).toEqual(['nothingHere']);
    expect(result.ambiguous).toEqual(['envBaseFor']);
  });

  it('returns empty partitions for an empty batch', () => {
    expect(resolveTargets(graph, [])).toEqual({
      resolved: [],
      unresolved: [],
      ambiguous: [],
    });
  });
});

describe('describeCandidates', () => {
  it('names each candidate with its file so the model can disambiguate', () => {
    const result = resolveTarget(graph, 'envBaseFor');
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguity');
    const described = describeCandidates(result.candidates);
    expect(described).toContain('src/providers.js');
    expect(described).toContain('src/config.js');
  });
});
