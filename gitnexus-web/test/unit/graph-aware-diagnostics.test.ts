import { describe, expect, it } from 'vitest';
import { computeGraphAwareDiagnostics } from '../../src/lib/diagnostics/graph-aware-source';

const graph = {
  nodes: [
    {
      id: 'Function:src/a.ts:envBaseFor',
      label: 'Function',
      properties: { name: 'envBaseFor', filePath: 'src/a.ts', startLine: 5, endLine: 7 },
    },
    {
      id: 'Function:src/a.ts:orphan',
      label: 'Function',
      properties: { name: 'orphan', filePath: 'src/a.ts', startLine: 9, endLine: 10 },
    },
    {
      id: 'Function:src/b.ts:caller',
      label: 'Function',
      properties: { name: 'caller', filePath: 'src/b.ts', startLine: 1, endLine: 3 },
    },
  ],
  relationships: [
    {
      id: 'r1',
      sourceId: 'Function:src/b.ts:caller',
      targetId: 'Function:src/a.ts:envBaseFor',
      type: 'CALLS',
      confidence: 1,
    },
  ],
} as any;

const BOTH_PRESENT = 'function envBaseFor() {}\nfunction orphan() {}\n';

describe('computeGraphAwareDiagnostics', () => {
  it('warns when an edit removes a symbol that has callers, naming the count', () => {
    const out = computeGraphAwareDiagnostics(graph, 'src/a.ts', 'function orphan() {}\n');

    const warning = out.find((d) => d.message.includes('envBaseFor'));
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
    expect(warning!.message).toContain('1 caller');
    expect(warning!.source).toBe('graph');
  });

  it('anchors the warning to the symbol, converting 1-based graph lines to 0-based', () => {
    const out = computeGraphAwareDiagnostics(graph, 'src/a.ts', 'function orphan() {}\n');
    const warning = out.find((d) => d.message.includes('envBaseFor'))!;

    expect(warning.line).toBe(4);
    expect(warning.endLine).toBe(6);
  });

  it('raises no warning while every symbol is still present', () => {
    const out = computeGraphAwareDiagnostics(graph, 'src/a.ts', BOTH_PRESENT);
    expect(out.filter((d) => d.severity === 'warning')).toHaveLength(0);
  });

  it('describes an unreferenced symbol as having no resolvable references, not unused', () => {
    // An empty caller set is not proof a symbol is dead — it can also mean the
    // callers are not resolvable by the index. The wording must not imply
    // otherwise.
    const out = computeGraphAwareDiagnostics(graph, 'src/a.ts', BOTH_PRESENT);
    const info = out.find((d) => d.message.includes('orphan'));

    expect(info).toBeDefined();
    expect(info!.severity).toBe('info');
    expect(info!.message).toMatch(/no resolvable references/i);
    expect(info!.message).not.toMatch(/\bunused\b/i);
  });

  it('does not flag a symbol that has callers and is still present', () => {
    const out = computeGraphAwareDiagnostics(graph, 'src/a.ts', BOTH_PRESENT);
    expect(out.find((d) => d.message.includes('envBaseFor'))).toBeUndefined();
  });

  it('returns nothing for a file with no symbols in the graph', () => {
    expect(computeGraphAwareDiagnostics(graph, 'src/unknown.ts', 'anything')).toEqual([]);
  });

  it('returns nothing when no graph is loaded', () => {
    expect(computeGraphAwareDiagnostics(null, 'src/a.ts', BOTH_PRESENT)).toEqual([]);
  });

  it('matches paths regardless of separator style', () => {
    const out = computeGraphAwareDiagnostics(graph, './src\\a.ts', 'function orphan() {}\n');
    expect(out.some((d) => d.message.includes('envBaseFor'))).toBe(true);
  });
});
