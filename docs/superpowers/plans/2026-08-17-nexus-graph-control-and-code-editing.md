# Nexus Graph Control and Code Inspector Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Nexus AI drive the graph visualization directly (camera, selection, highlighting, neighborhood explanation) and turn the read-only Code Inspector into an editing surface with language-aware diagnostics, gated disk saves, and confirmable AI-proposed edits.

**Architecture:** A typed `NexusGraphController` is injected into the LangChain tool factory, replacing the string-marker side channel for new capabilities. Camera and neighbor operations are forwarded out of `useSigma` through an extended `GraphCanvasHandle`. The Code Inspector swaps `react-syntax-highlighter` for a lazily-imported CodeMirror 6 editor whose lint gutter aggregates four diagnostic sources. Saving goes through a new `PUT /api/file` route gated by both a server flag and a per-repository UI toggle.

**Tech Stack:** React 19, TypeScript 5.9, Vite, Sigma 3 + graphology, LangChain JS, CodeMirror 6, web-tree-sitter, Express, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-nexus-graph-control-and-code-editing-design.md`

## Global Constraints

- Package manager is npm. Web UI commands run from `gitnexus-web/`; server commands run from `gitnexus/`.
- Test runner is Vitest. Web tests live in `gitnexus-web/test/unit/`, server tests in `gitnexus/test/unit/`.
- All user-facing strings go through `react-i18next` and MUST be added to both `gitnexus-web/src/locales/en/` and `gitnexus-web/src/locales/zh-CN/`. `i18n.test.tsx` asserts key parity.
- Path containment checks in server route handlers MUST be written inline at the sink using `path.resolve` then `path.relative`. Cross-module helpers are not followed by CodeQL's interprocedural analysis. See the comment at `gitnexus/src/server/api.ts:598-603`.
- Every mutating server route MUST carry `createRouteLimiter(...)` and `requireTrustedOrigin`, in that order, matching `api.ts:1005`.
- Line numbers in `CodeReference` and `GraphNode.properties` are **0-based**. Line numbers in citations (`[[path:45-60]]`) and CodeMirror are **1-based**. Convert explicitly at every boundary.
- Node ids are `Label:name` for `File`/`Folder` and `Label:filePath:name` for symbols (`gitnexus/src/lib/utils.ts:1-3`).
- Commits use `BarnsL <252321079+BarnsL@users.noreply.github.com>`. Do NOT add `Co-Authored-By: Claude` trailers.
- Product documentation lives at the repository root. `docs/*` is gitignored (`.gitignore:72`); plan and spec files under `docs/superpowers/` are force-added.
- Do not run `npm run dev` via a shell tool. Use the Browser pane preview tooling for verification.

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `gitnexus-web/src/lib/target-resolution.ts` | Single shared resolver from a loose target string to a graph node |
| `gitnexus-web/src/core/llm/graph-controller.ts` | `NexusGraphController` interface + no-op implementation for tests |
| `gitnexus-web/src/core/llm/graph-tools.ts` | The nine navigation tools |
| `gitnexus-web/src/core/llm/edit-tools.ts` | `propose_edit` tool + proposal store |
| `gitnexus-web/src/lib/nexus-edit-marker.ts` | `[[nexus-edit:<id>]]` extraction, mirrors `runtime-action-marker.ts` |
| `gitnexus-web/src/components/NexusEditCard.tsx` | Diff card with Apply/Reject |
| `gitnexus-web/src/components/NavigationTrail.tsx` | Back control + breadcrumb chips |
| `gitnexus-web/src/components/CodeEditor.tsx` | CodeMirror 6 wrapper |
| `gitnexus-web/src/lib/editor-languages.ts` | Prism id → CodeMirror language pack mapping |
| `gitnexus-web/src/lib/diagnostics/tree-sitter-worker.ts` | Web Worker running wasm grammars |
| `gitnexus-web/src/lib/diagnostics/tree-sitter-source.ts` | Worker client, produces syntax diagnostics |
| `gitnexus-web/src/lib/diagnostics/graph-aware-source.ts` | Caller/reference warnings from the knowledge graph |
| `gitnexus-web/src/lib/diagnostics/ai-review-source.ts` | On-demand LLM review |
| `gitnexus-web/src/hooks/useEditingEnabled.ts` | Per-repo editing preference |
| `NEXUS-GRAPH-CONTROL.md` | Product doc for graph control |
| `CODE-INSPECTOR.md` | Product doc for the editor |

**Modified:**

| Path | Change |
|---|---|
| `gitnexus-web/src/components/RightPanel.tsx:51-53` | Delete `resolveFilePathForUI` stub |
| `gitnexus-web/src/components/CodeReferencesPanel.tsx:183-195` | Fix `content: null`; host the editor |
| `gitnexus-web/src/components/CodeReferencesPanel.tsx:406-422` | Fix window-offset highlight defect |
| `gitnexus-web/src/hooks/useAppState.tsx` | Export resolvers, add highlight setter, view history, controller |
| `gitnexus-web/src/hooks/useSigma.ts:1506-1525` | Parameterize `focusNode`, add `frameNodes`, camera get/set, neighbors |
| `gitnexus-web/src/components/GraphCanvas.tsx:34-36,183-199` | Extend `GraphCanvasHandle` |
| `gitnexus-web/src/core/llm/tools.ts` | Accept controller, register new tools |
| `gitnexus-web/src/core/llm/agent.ts:72-230` | Rewrite system prompt sections |
| `gitnexus-web/src/services/backend-client.ts` | Add `writeFile`, extend `getInfo` |
| `gitnexus/src/server/api.ts` | Add `PUT /api/file`, advertise capability |
| `gitnexus-web/vite.config.ts` | Copy tree-sitter wasm grammars |
| `gitnexus-web/vitest.config.ts:36` | Correct stale coverage exclusion |

---

## Task 1: Repair the dead AI citation path

The AI-to-Inspector path is broken end to end. This task restores it before any new capability is built on top.

**Files:**
- Modify: `gitnexus-web/src/hooks/useAppState.tsx` (interface ~line 231, value object ~line 1520)
- Modify: `gitnexus-web/src/components/RightPanel.tsx:51-67`
- Modify: `gitnexus-web/src/components/CodeReferencesPanel.tsx:183-195`
- Test: `gitnexus-web/test/unit/citation-click-path.test.tsx` (create)

**Interfaces:**
- Produces: `resolveFilePath(requestedPath: string): string | null` and `findFileNodeId(filePath: string): string | undefined` on the `useAppState` public surface. Tasks 2 and 5 consume both.

- [ ] **Step 1: Write the failing test**

Create `gitnexus-web/test/unit/citation-click-path.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';
import { MarkdownRenderer } from '../../src/components/MarkdownRenderer';

const GRAPH = {
  nodes: [
    {
      id: 'File:src/providers.js',
      label: 'File' as const,
      properties: { name: 'providers.js', filePath: 'src/providers.js' },
    },
  ],
  relationships: [],
  nodeCount: 1,
  relationshipCount: 0,
};

const Harness = () => {
  const { setGraph, graph, codeReferences, resolveFilePath } = useAppState();
  if (!graph) {
    return <button onClick={() => setGraph(GRAPH as any)}>load</button>;
  }
  return (
    <div>
      <span data-testid="resolved">{String(resolveFilePath('providers.js'))}</span>
      <span data-testid="ref-count">{codeReferences.length}</span>
    </div>
  );
};

describe('AI citation click path', () => {
  it('exposes resolveFilePath from app state and resolves a partial path', async () => {
    render(
      <AppStateProvider>
        <Harness />
      </AppStateProvider>,
    );
    fireEvent.click(screen.getByText('load'));
    await waitFor(() => {
      expect(screen.getByTestId('resolved').textContent).toBe('src/providers.js');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/citation-click-path.test.tsx`
Expected: FAIL — `resolveFilePath` is not a function (it is not on the public surface).

- [ ] **Step 3: Export the resolvers from app state**

In `gitnexus-web/src/hooks/useAppState.tsx`, add to the `AppStateValue` interface near the code panel block (~line 231):

```ts
  resolveFilePath: (requestedPath: string) => string | null;
  findFileNodeId: (filePath: string) => string | undefined;
```

Add both to the returned value object (~line 1520), alongside `addCodeReference`. Both functions already exist at `useAppState.tsx:428-440` and `:442-447`; this only exposes them.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/citation-click-path.test.tsx`
Expected: PASS

- [ ] **Step 5: Delete the RightPanel stub**

In `gitnexus-web/src/components/RightPanel.tsx`, delete lines 51-67 (`resolveFilePathForUI` and `findFileNodeIdForUI`) entirely. Pull the real functions from `useAppState` by adding `resolveFilePath` and `findFileNodeId` to the destructure at line 23-40.

Then replace every use. At line 86:

```ts
      const resolvedPath = resolveFilePath(rawPath);
      if (!resolvedPath) return;

      const nodeId = findFileNodeId(resolvedPath);
```

At line 139 (inside `handleNodeGroundingClick`):

```ts
        const resolvedPath = resolveFilePath(node.properties.filePath);
```

Update the `useCallback` dependency arrays at line 105 and line 153 to `[addCodeReference, findFileNodeId, resolveFilePath]` and `[graph, resolveFilePath, addCodeReference]` respectively.

- [ ] **Step 6: Fix the empty citation snippets**

In `gitnexus-web/src/components/CodeReferencesPanel.tsx`, replace the `refsWithSnippets` memo at lines 183-195. The current version hard-codes `content: null`, so no citation card ever renders code. Replace it with state populated by a fetch effect:

```tsx
  const [snippets, setSnippets] = useState<Map<string, { content: string; start: number }>>(
    new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    const missing = aiReferences.filter((r) => !snippets.has(r.id));
    if (missing.length === 0) return;
    void (async () => {
      for (const ref of missing) {
        const startLine = ref.startLine ?? 0;
        const endLine = ref.endLine ?? startLine;
        try {
          const result = await readFile(ref.filePath, {
            startLine: Math.max(0, startLine - 3),
            endLine: endLine + 3,
            repo: currentRepo || projectName || undefined,
          });
          if (cancelled) return;
          setSnippets((prev) =>
            new Map(prev).set(ref.id, {
              content: result.content,
              start: result.startLine ?? Math.max(0, startLine - 3),
            }),
          );
        } catch {
          if (cancelled) return;
          setSnippets((prev) => new Map(prev).set(ref.id, { content: '', start: 0 }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [aiReferences, snippets, currentRepo, projectName]);

  const refsWithSnippets = useMemo(
    () =>
      aiReferences.map((ref) => {
        const snippet = snippets.get(ref.id);
        const content = snippet?.content || null;
        return {
          ref,
          content,
          start: snippet?.start ?? 0,
          highlightStart: ref.startLine ?? 0,
          highlightEnd: ref.endLine ?? ref.startLine ?? 0,
          totalLines: content ? content.split('\n').length : 0,
        };
      }),
    [aiReferences, snippets],
  );
```

- [ ] **Step 7: Fix the window-offset highlight defect**

In `gitnexus-web/src/components/CodeReferencesPanel.tsx:406-422`, the `lineProps` callback compares an absolute `startLine` against a `lineNumber` that is relative to the fetched window, while the gutter is offset by `startingLineNumber={fileStartLine + 1}`. Subtract the window offset:

```ts
              lineProps={(lineNumber: number) => {
                const symStart = selectedNode?.properties?.startLine as number | undefined;
                const symEnd = (selectedNode?.properties?.endLine as number | undefined) ?? symStart;
                // lineNumber is 1-based and relative to the fetched window;
                // symStart/symEnd are 0-based absolute file lines.
                const absolute = fileStartLine + lineNumber - 1;
                const isHighlighted =
                  typeof symStart === 'number' &&
                  absolute >= symStart &&
                  absolute <= (symEnd ?? symStart);
                return {
                  style: {
                    display: 'block',
                    backgroundColor: isHighlighted ? 'rgba(6, 182, 212, 0.14)' : 'transparent',
                    borderLeft: isHighlighted ? '3px solid #06b6d4' : '3px solid transparent',
                    paddingLeft: '12px',
                    paddingRight: '16px',
                  },
                };
              }}
```

- [ ] **Step 8: Run the full web suite**

Run: `cd gitnexus-web && npx vitest run`
Expected: PASS, including the existing `code-references-panel.test.tsx`.

- [ ] **Step 9: Commit**

```bash
git add gitnexus-web/src/hooks/useAppState.tsx gitnexus-web/src/components/RightPanel.tsx gitnexus-web/src/components/CodeReferencesPanel.tsx gitnexus-web/test/unit/citation-click-path.test.tsx
git commit -m "fix(web): repair dead AI citation click path

resolveFilePathForUI was stubbed to return null, so every code-ref and
node-ref click dead-ended before addCodeReference. refsWithSnippets
hard-coded content: null, so citation cards never rendered source. The
selected-file highlight band compared absolute line numbers against
window-relative ones and landed on the wrong lines for windowed reads.

Promotes resolveFilePath and findFileNodeId onto the app state surface
and deletes the RightPanel stubs."
```

---

## Task 2: Shared target resolution

**Files:**
- Create: `gitnexus-web/src/lib/target-resolution.ts`
- Test: `gitnexus-web/test/unit/target-resolution.test.ts` (create)
- Modify: `gitnexus-web/src/hooks/useAppState.tsx:1038-1049` and `:1070-1081` (replace duplicated matchers)

**Interfaces:**
- Consumes: `KnowledgeGraph` from `src/core/graph/types`, `normalizePath` from `src/lib/path-resolution`.
- Produces:

```ts
export type TargetResolution =
  | { kind: 'match'; nodeId: string; node: GraphNode }
  | { kind: 'ambiguous'; candidates: GraphNode[] }
  | { kind: 'miss'; reason: string };

export const resolveTarget = (
  graph: KnowledgeGraph | null,
  target: string,
): TargetResolution => { ... };

export const resolveTargets = (
  graph: KnowledgeGraph | null,
  targets: string[],
): { resolved: string[]; unresolved: string[]; ambiguous: string[] } => { ... };
```

Tasks 5, 6 and 15 consume both.

- [ ] **Step 1: Write the failing test**

Create `gitnexus-web/test/unit/target-resolution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveTarget, resolveTargets } from '../../src/lib/target-resolution';

const graph = {
  nodes: [
    { id: 'File:src/providers.js', label: 'File', properties: { name: 'providers.js', filePath: 'src/providers.js' } },
    { id: 'Function:src/providers.js:envBaseFor', label: 'Function', properties: { name: 'envBaseFor', filePath: 'src/providers.js', startLine: 24, endLine: 26 } },
    { id: 'Function:src/config.js:envBaseFor', label: 'Function', properties: { name: 'envBaseFor', filePath: 'src/config.js', startLine: 10, endLine: 12 } },
  ],
  relationships: [],
  nodeCount: 3,
  relationshipCount: 0,
} as any;

describe('resolveTarget', () => {
  it('resolves an exact node id', () => {
    const r = resolveTarget(graph, 'Function:src/providers.js:envBaseFor');
    expect(r).toMatchObject({ kind: 'match', nodeId: 'Function:src/providers.js:envBaseFor' });
  });

  it('resolves a typed Label:Name reference when unique', () => {
    const r = resolveTarget(graph, 'File:providers.js');
    expect(r).toMatchObject({ kind: 'match', nodeId: 'File:src/providers.js' });
  });

  it('resolves a partial file path by suffix', () => {
    const r = resolveTarget(graph, 'providers.js');
    expect(r).toMatchObject({ kind: 'match', nodeId: 'File:src/providers.js' });
  });

  it('reports ambiguity for a bare symbol defined twice', () => {
    const r = resolveTarget(graph, 'envBaseFor');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates).toHaveLength(2);
  });

  it('reports a miss with a reason', () => {
    const r = resolveTarget(graph, 'nothingHere');
    expect(r).toMatchObject({ kind: 'miss' });
  });

  it('returns a miss when the graph is null', () => {
    expect(resolveTarget(null, 'anything').kind).toBe('miss');
  });

  it('partitions a batch', () => {
    const r = resolveTargets(graph, ['providers.js', 'nothingHere', 'envBaseFor']);
    expect(r.resolved).toEqual(['File:src/providers.js']);
    expect(r.unresolved).toEqual(['nothingHere']);
    expect(r.ambiguous).toEqual(['envBaseFor']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/target-resolution.test.ts`
Expected: FAIL — module `src/lib/target-resolution` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `gitnexus-web/src/lib/target-resolution.ts`:

```ts
import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';
import { normalizePath } from './path-resolution';

export type TargetResolution =
  | { kind: 'match'; nodeId: string; node: GraphNode }
  | { kind: 'ambiguous'; candidates: GraphNode[] }
  | { kind: 'miss'; reason: string };

const MAX_CANDIDATES = 10;

const finish = (matches: GraphNode[]): TargetResolution | null => {
  if (matches.length === 1) return { kind: 'match', nodeId: matches[0].id, node: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches.slice(0, MAX_CANDIDATES) };
  return null;
};

export const resolveTarget = (
  graph: KnowledgeGraph | null,
  target: string,
): TargetResolution => {
  const raw = target.trim();
  if (!graph || graph.nodes.length === 0) {
    return { kind: 'miss', reason: 'No graph is loaded.' };
  }
  if (!raw) return { kind: 'miss', reason: 'Empty target.' };

  // 1. Exact node id.
  const exact = graph.nodes.find((n) => n.id === raw);
  if (exact) return { kind: 'match', nodeId: exact.id, node: exact };

  // 2. Typed reference Label:Name.
  const typed = raw.match(/^([A-Z][A-Za-z]*):(.+)$/);
  if (typed) {
    const [, label, name] = typed;
    const wanted = name.trim();
    const byLabelName = finish(
      graph.nodes.filter((n) => n.label === label && n.properties.name === wanted),
    );
    if (byLabelName) return byLabelName;
    // File/Folder nodes carry a path in `name`; match by path suffix too.
    const normalized = normalizePath(wanted);
    const byLabelPath = finish(
      graph.nodes.filter(
        (n) =>
          n.label === label &&
          typeof n.properties.filePath === 'string' &&
          normalizePath(n.properties.filePath).endsWith(normalized),
      ),
    );
    if (byLabelPath) return byLabelPath;
  }

  // 3. File path, exact then shortest suffix.
  const normalized = normalizePath(raw);
  const fileNodes = graph.nodes.filter(
    (n) => n.label === 'File' && typeof n.properties.filePath === 'string',
  );
  const exactPath = fileNodes.find((n) => normalizePath(n.properties.filePath) === normalized);
  if (exactPath) return { kind: 'match', nodeId: exactPath.id, node: exactPath };
  if (normalized.includes('.')) {
    const suffix = fileNodes
      .filter((n) => normalizePath(n.properties.filePath).endsWith(normalized))
      .sort((a, b) => a.properties.filePath.length - b.properties.filePath.length);
    const bySuffix = finish(suffix);
    if (bySuffix) return bySuffix;
  }

  // 4. Bare symbol name: exact, then case-insensitive, then node-id suffix.
  const byName = finish(graph.nodes.filter((n) => n.properties.name === raw));
  if (byName) return byName;
  const lower = raw.toLowerCase();
  const byNameCI = finish(graph.nodes.filter((n) => n.properties.name?.toLowerCase() === lower));
  if (byNameCI) return byNameCI;
  const byIdSuffix = finish(
    graph.nodes.filter((n) => n.id.endsWith(`:${raw}`) || n.id.endsWith(raw)),
  );
  if (byIdSuffix) return byIdSuffix;

  return { kind: 'miss', reason: `No node matched "${raw}".` };
};

export const resolveTargets = (
  graph: KnowledgeGraph | null,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/target-resolution.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Replace the duplicated marker matchers**

In `gitnexus-web/src/hooks/useAppState.tsx`, the `[HIGHLIGHT_NODES:...]` branch at lines 1028-1057 and the `[IMPACT:...]` branch at lines 1060-1089 contain the same 12-line matcher. Replace both bodies with `resolveTargets`:

```ts
                  const highlightMatch = tc.result.match(/\[HIGHLIGHT_NODES:([^\]]+)\]/);
                  if (highlightMatch) {
                    const rawIds = highlightMatch[1]
                      .split(',')
                      .map((id: string) => id.trim())
                      .filter(Boolean);
                    const { resolved } = resolveTargets(graph, rawIds);
                    if (resolved.length > 0) {
                      setAIToolHighlightedNodeIds(new Set(resolved));
                    }
                  }

                  const impactMatch = tc.result.match(/\[IMPACT:([^\]]+)\]/);
                  if (impactMatch) {
                    const rawIds = impactMatch[1]
                      .split(',')
                      .map((id: string) => id.trim())
                      .filter(Boolean);
                    const { resolved } = resolveTargets(graph, rawIds);
                    if (resolved.length > 0) {
                      setBlastRadiusNodeIds(new Set(resolved));
                    }
                  }
```

Add `import { resolveTargets } from '../lib/target-resolution';` at the top.

- [ ] **Step 6: Replace the Header search matcher**

In `gitnexus-web/src/components/Header.tsx:104-111`, keep the substring behavior for the live dropdown (it is a search box, not a resolver) but export nothing new. No change required. Leave a comment noting that `resolveTarget` is the canonical resolver for programmatic lookups so a future reader does not add a third copy:

```ts
      // Substring search for the interactive dropdown. Programmatic lookups
      // must use resolveTarget in src/lib/target-resolution.ts instead.
```

- [ ] **Step 7: Run the full web suite**

Run: `cd gitnexus-web && npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add gitnexus-web/src/lib/target-resolution.ts gitnexus-web/test/unit/target-resolution.test.ts gitnexus-web/src/hooks/useAppState.tsx gitnexus-web/src/components/Header.tsx
git commit -m "feat(web): add shared target resolution for graph lookups

Single resolver handling exact node ids, Label:Name references, file
paths by exact then shortest suffix, and bare symbol names, reporting
ambiguity rather than silently picking a candidate. Replaces the two
duplicated matchers in the tool-result marker parser."
```

---

## Task 3: Camera and neighbor plumbing

**Files:**
- Modify: `gitnexus-web/src/hooks/useSigma.ts:1506-1525` and the return object at `:1556-1576`
- Modify: `gitnexus-web/src/components/GraphCanvas.tsx:34-36` and `:183-199`
- Test: `gitnexus-web/test/unit/graph-camera-api.test.ts` (create)

**Interfaces:**
- Produces, on `GraphCanvasHandle`:

```ts
export interface CameraState {
  x: number;
  y: number;
  ratio: number;
  angle: number;
}

export interface NeighborEdge {
  nodeId: string;
  name: string;
  label: string;
  filePath?: string;
  relationship: string;
  direction: 'in' | 'out';
  rendered: boolean;
}

export interface GraphCanvasHandle {
  focusNode: (nodeId: string, opts?: { zoom?: number; duration?: number }) => void;
  frameNodes: (nodeIds: string[], opts?: { padding?: number; duration?: number }) => void;
  getCameraState: () => CameraState | null;
  setCameraState: (state: CameraState, durationMs?: number) => void;
  getNeighbors: (
    nodeId: string,
    opts?: { depth?: number; direction?: 'in' | 'out' | 'both'; edgeTypes?: string[] },
  ) => NeighborEdge[];
}
```

Tasks 4, 5 and 6 consume all five.

- [ ] **Step 1: Write the failing test**

Create `gitnexus-web/test/unit/graph-camera-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeBoundingBoxCamera } from '../../src/hooks/useSigma';

describe('computeBoundingBoxCamera', () => {
  it('centres on the midpoint of the supplied points', () => {
    const result = computeBoundingBoxCamera([{ x: 0, y: 0 }, { x: 10, y: 20 }], 1.2);
    expect(result.x).toBeCloseTo(5);
    expect(result.y).toBeCloseTo(10);
  });

  it('scales the ratio to the larger dimension plus padding', () => {
    const wide = computeBoundingBoxCamera([{ x: 0, y: 0 }, { x: 100, y: 1 }], 1);
    const tall = computeBoundingBoxCamera([{ x: 0, y: 0 }, { x: 1, y: 100 }], 1);
    expect(wide.ratio).toBeCloseTo(tall.ratio);
  });

  it('falls back to a usable ratio for a single point', () => {
    const result = computeBoundingBoxCamera([{ x: 4, y: 4 }], 1);
    expect(result.x).toBe(4);
    expect(result.ratio).toBeGreaterThan(0);
  });

  it('returns null for an empty set', () => {
    expect(computeBoundingBoxCamera([], 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/graph-camera-api.test.ts`
Expected: FAIL — `computeBoundingBoxCamera` is not exported.

- [ ] **Step 3: Add the bounding-box helper**

At the top level of `gitnexus-web/src/hooks/useSigma.ts` (near `dimColor` at line 37, outside the hook), add:

```ts
/** Minimum camera ratio so a single node does not zoom to an unusable level. */
const MIN_FRAME_RATIO = 0.05;

export const computeBoundingBoxCamera = (
  points: { x: number; y: number }[],
  padding: number,
): { x: number; y: number; ratio: number } | null => {
  if (points.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const span = Math.max(width, height);
  const ratio = span > 0 ? Math.max(MIN_FRAME_RATIO, (span / 2) * padding) : 0.15;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, ratio };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/graph-camera-api.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Parameterize focusNode and remove the repeat no-op**

Replace `focusNode` at `gitnexus-web/src/hooks/useSigma.ts:1506-1525`:

```ts
  const focusNode = useCallback(
    (nodeId: string, opts?: { zoom?: number; duration?: number }) => {
      const sigma = sigmaRef.current;
      const graph = graphRef.current;
      if (!sigma || !graph || !graph.hasNode(nodeId)) return;

      selectedNodeRef.current = nodeId;
      setSelectedNodeState(nodeId);

      const nodeAttrs = graph.getNodeAttributes(nodeId);
      const camera = sigma.getCamera();
      const targetRatio = opts?.zoom ?? 0.15;
      const state = camera.getState();
      // Skip only the animation when the camera is already effectively there.
      // The selection and panel side effects above always run, so a repeated
      // call from the agent still re-selects and re-opens the inspector.
      const settled =
        Math.abs(state.x - nodeAttrs.x) < 1e-3 &&
        Math.abs(state.y - nodeAttrs.y) < 1e-3 &&
        Math.abs(state.ratio - targetRatio) < 1e-3;
      if (!settled) {
        camera.animate(
          { x: nodeAttrs.x, y: nodeAttrs.y, ratio: targetRatio },
          { duration: opts?.duration ?? 400 },
        );
      }
      sigma.refresh();
    },
    [],
  );
```

- [ ] **Step 6: Add frameNodes, camera get/set, and getNeighbors**

Immediately after `focusNode` in `useSigma.ts`:

```ts
  const frameNodes = useCallback(
    (nodeIds: string[], opts?: { padding?: number; duration?: number }) => {
      const sigma = sigmaRef.current;
      const graph = graphRef.current;
      if (!sigma || !graph) return;
      const points = nodeIds
        .filter((id) => graph.hasNode(id))
        .map((id) => {
          const a = graph.getNodeAttributes(id);
          return { x: a.x, y: a.y };
        });
      const target = computeBoundingBoxCamera(points, opts?.padding ?? 1.4);
      if (!target) return;
      sigma.getCamera().animate(target, { duration: opts?.duration ?? 500 });
    },
    [],
  );

  const getCameraState = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return null;
    const { x, y, ratio, angle } = sigma.getCamera().getState();
    return { x, y, ratio, angle };
  }, []);

  const setCameraState = useCallback(
    (state: { x: number; y: number; ratio: number; angle: number }, durationMs?: number) => {
      const sigma = sigmaRef.current;
      if (!sigma) return;
      sigma.getCamera().animate(state, { duration: durationMs ?? 400 });
    },
    [],
  );

  const getNeighbors = useCallback(
    (
      nodeId: string,
      opts?: { depth?: number; direction?: 'in' | 'out' | 'both'; edgeTypes?: string[] },
    ) => {
      const graph = graphRef.current;
      if (!graph || !graph.hasNode(nodeId)) return [];
      const depth = Math.max(1, Math.min(3, opts?.depth ?? 1));
      const direction = opts?.direction ?? 'both';
      const wanted = opts?.edgeTypes;
      const visible = new Set(visibleEdgeTypesRef.current ?? []);

      const seen = new Set<string>([nodeId]);
      const out: {
        nodeId: string;
        name: string;
        label: string;
        filePath?: string;
        relationship: string;
        direction: 'in' | 'out';
        rendered: boolean;
      }[] = [];
      let frontier = [nodeId];

      for (let hop = 0; hop < depth; hop += 1) {
        const next: string[] = [];
        for (const current of frontier) {
          graph.forEachEdge(current, (_edge, attrs, source, target) => {
            const isOut = source === current;
            const other = isOut ? target : source;
            const dir: 'in' | 'out' = isOut ? 'out' : 'in';
            if (direction !== 'both' && direction !== dir) return;
            const relationship = String(attrs.relationshipType ?? attrs.type ?? 'UNKNOWN');
            if (wanted && wanted.length > 0 && !wanted.includes(relationship)) return;
            if (seen.has(other)) return;
            seen.add(other);
            next.push(other);
            const a = graph.getNodeAttributes(other);
            out.push({
              nodeId: other,
              name: String(a.label ?? other),
              label: String(a.nodeType ?? 'CodeElement'),
              filePath: a.filePath as string | undefined,
              relationship,
              direction: dir,
              rendered: visible.size === 0 || visible.has(relationship),
            });
          });
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
      return out;
    },
    [],
  );
```

Add `visibleEdgeTypesRef` alongside the other option refs mirrored at `useSigma.ts:271-282` if one does not already exist, populated from the `visibleEdgeTypes` option.

Add all four to the hook's return object at `useSigma.ts:1556-1576`: `frameNodes, getCameraState, setCameraState, getNeighbors`.

- [ ] **Step 7: Extend GraphCanvasHandle**

In `gitnexus-web/src/components/GraphCanvas.tsx`, replace the handle type at lines 34-36 with the full interface from the Interfaces block above (export `CameraState` and `NeighborEdge` from this file). Then replace the `useImperativeHandle` at lines 183-199:

```tsx
  useImperativeHandle(
    ref,
    () => ({
      focusNode: (nodeId: string, opts?: { zoom?: number; duration?: number }) => {
        if (graph) {
          const node = nodeById.get(nodeId);
          if (node) {
            setSelectedNode(node);
            openCodePanel();
          }
        }
        focusNode(nodeId, opts);
      },
      frameNodes,
      getCameraState,
      setCameraState,
      getNeighbors,
    }),
    [
      focusNode,
      frameNodes,
      getCameraState,
      setCameraState,
      getNeighbors,
      graph,
      nodeById,
      setSelectedNode,
      openCodePanel,
    ],
  );
```

Destructure the four new functions from `useSigma(...)` at `GraphCanvas.tsx:127`.

- [ ] **Step 8: Typecheck and run the suite**

Run: `cd gitnexus-web && npx tsc -b --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add gitnexus-web/src/hooks/useSigma.ts gitnexus-web/src/components/GraphCanvas.tsx gitnexus-web/test/unit/graph-camera-api.test.ts
git commit -m "feat(web): expose camera and neighbor operations on GraphCanvasHandle

focusNode gains zoom and duration parameters and no longer skips its
selection side effects when called twice for the same node; it now skips
only the animation when the camera has already settled there. Adds
frameNodes, camera get/set for view history, and getNeighbors returning
relationship type, direction, and whether the edge is currently rendered."
```

---

## Task 4: View history and navigation trail

**Files:**
- Modify: `gitnexus-web/src/hooks/useAppState.tsx` (state, interface, value object)
- Create: `gitnexus-web/src/components/NavigationTrail.tsx`
- Modify: `gitnexus-web/src/App.tsx` (render the trail)
- Modify: `gitnexus-web/src/locales/en/graph.json`, `gitnexus-web/src/locales/zh-CN/graph.json`
- Test: `gitnexus-web/test/unit/view-history.test.tsx` (create)

**Interfaces:**
- Consumes: `CameraState` from Task 3.
- Produces on `useAppState`:

```ts
export interface ViewHistoryEntry {
  id: string;
  label: string;
  camera: CameraState | null;
  selectedNodeId: string | null;
  viewMode: GraphViewMode;
  ts: number;
}

viewHistory: ViewHistoryEntry[];
pushViewHistory: (label: string, entry: Omit<ViewHistoryEntry, 'id' | 'label' | 'ts'>) => void;
popViewHistory: () => ViewHistoryEntry | null;
restoreViewHistory: (id: string) => ViewHistoryEntry | null;
clearViewHistory: () => void;
```

Tasks 5 and 6 consume `pushViewHistory`.

- [ ] **Step 1: Write the failing test**

Create `gitnexus-web/test/unit/view-history.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AppStateProvider>{children}</AppStateProvider>
);

const entry = (n: number) => ({
  camera: { x: n, y: n, ratio: 0.5, angle: 0 },
  selectedNodeId: `Function:f${n}`,
  viewMode: 'force' as const,
});

describe('view history', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    expect(result.current.viewHistory).toEqual([]);
  });

  it('pushes and pops in LIFO order', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    act(() => {
      result.current.pushViewHistory('first', entry(1));
      result.current.pushViewHistory('second', entry(2));
    });
    expect(result.current.viewHistory).toHaveLength(2);
    let popped: any;
    act(() => {
      popped = result.current.popViewHistory();
    });
    expect(popped.label).toBe('second');
    expect(result.current.viewHistory).toHaveLength(1);
  });

  it('caps the stack at 20 entries, discarding the oldest', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    act(() => {
      for (let i = 0; i < 25; i += 1) result.current.pushViewHistory(`e${i}`, entry(i));
    });
    expect(result.current.viewHistory).toHaveLength(20);
    expect(result.current.viewHistory[0].label).toBe('e5');
  });

  it('restoring by id truncates everything after it', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    act(() => {
      result.current.pushViewHistory('a', entry(1));
      result.current.pushViewHistory('b', entry(2));
      result.current.pushViewHistory('c', entry(3));
    });
    const targetId = result.current.viewHistory[0].id;
    act(() => {
      result.current.restoreViewHistory(targetId);
    });
    expect(result.current.viewHistory).toHaveLength(0);
  });

  it('returns null when popping an empty stack', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    let popped: any = 'unset';
    act(() => {
      popped = result.current.popViewHistory();
    });
    expect(popped).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/view-history.test.tsx`
Expected: FAIL — `pushViewHistory` is not a function.

- [ ] **Step 3: Implement view history state**

In `gitnexus-web/src/hooks/useAppState.tsx`, after the animations block (~line 367):

```ts
  const MAX_VIEW_HISTORY = 20;
  const [viewHistory, setViewHistory] = useState<ViewHistoryEntry[]>([]);

  const pushViewHistory = useCallback(
    (label: string, entry: Omit<ViewHistoryEntry, 'id' | 'label' | 'ts'>) => {
      setViewHistory((prev) => {
        const next = [
          ...prev,
          {
            ...entry,
            id: `vh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            label,
            ts: Date.now(),
          },
        ];
        return next.length > MAX_VIEW_HISTORY ? next.slice(next.length - MAX_VIEW_HISTORY) : next;
      });
    },
    [],
  );

  const popViewHistory = useCallback((): ViewHistoryEntry | null => {
    let popped: ViewHistoryEntry | null = null;
    setViewHistory((prev) => {
      if (prev.length === 0) return prev;
      popped = prev[prev.length - 1];
      return prev.slice(0, -1);
    });
    return popped;
  }, []);

  const restoreViewHistory = useCallback((id: string): ViewHistoryEntry | null => {
    let target: ViewHistoryEntry | null = null;
    setViewHistory((prev) => {
      const idx = prev.findIndex((e) => e.id === id);
      if (idx < 0) return prev;
      target = prev[idx];
      return prev.slice(0, idx);
    });
    return target;
  }, []);

  const clearViewHistory = useCallback(() => setViewHistory([]), []);
```

`popViewHistory` and `restoreViewHistory` read the value inside the updater, which React invokes synchronously during `setState`, so the returned value is populated before the function returns.

Add `ViewHistoryEntry` to the exported types near `CodeReference` (~line 88), add the five members to the `AppStateValue` interface, and add them to the value object.

Clear the history when the repository changes: add `clearViewHistory()` to the existing `switchRepo` flow.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/view-history.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Add locale strings**

In `gitnexus-web/src/locales/en/graph.json` add:

```json
  "navigationTrail": {
    "back": "Back to previous view",
    "trail": "Navigation trail",
    "restore": "Return to: {{label}}",
    "clear": "Clear trail"
  }
```

In `gitnexus-web/src/locales/zh-CN/graph.json` add the same keys:

```json
  "navigationTrail": {
    "back": "返回上一个视图",
    "trail": "导航轨迹",
    "restore": "返回：{{label}}",
    "clear": "清除轨迹"
  }
```

- [ ] **Step 6: Create the NavigationTrail component**

Create `gitnexus-web/src/components/NavigationTrail.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import { ArrowLeft, X } from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import type { ViewHistoryEntry } from '../hooks/useAppState';

interface NavigationTrailProps {
  onRestore: (entry: ViewHistoryEntry) => void;
}

export const NavigationTrail = ({ onRestore }: NavigationTrailProps) => {
  const { t } = useTranslation(['graph']);
  const { viewHistory, popViewHistory, restoreViewHistory, clearViewHistory } = useAppState();

  if (viewHistory.length === 0) return null;

  const recent = viewHistory.slice(-4);

  return (
    <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-white/10 bg-black/60 px-2 py-1 backdrop-blur">
      <button
        type="button"
        onClick={() => {
          const entry = popViewHistory();
          if (entry) onRestore(entry);
        }}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-400/10"
        title={t('graph:navigationTrail.back')}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('graph:navigationTrail.back')}
      </button>
      <div className="flex items-center gap-1" aria-label={t('graph:navigationTrail.trail')}>
        {recent.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => {
              const restored = restoreViewHistory(entry.id);
              if (restored) onRestore(restored);
            }}
            className="max-w-[10rem] truncate rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-text-muted hover:border-cyan-300/50 hover:text-cyan-200"
            title={t('graph:navigationTrail.restore', { label: entry.label })}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={clearViewHistory}
        className="rounded-md p-1 text-text-muted hover:text-white"
        title={t('graph:navigationTrail.clear')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
```

- [ ] **Step 7: Render the trail and wire restore**

In `gitnexus-web/src/App.tsx`, near the existing graph overlay controls, add:

```tsx
  const handleRestoreView = useCallback((entry: ViewHistoryEntry) => {
    const canvas = graphCanvasRef.current;
    if (!canvas) return;
    // Reapply the view mode first; layout switching resets the camera, so the
    // camera restore must wait for the new layout to settle.
    if (entry.viewMode !== graphViewMode) {
      setGraphViewMode(entry.viewMode);
      window.setTimeout(() => {
        if (entry.camera) canvas.setCameraState(entry.camera, 400);
      }, 700);
    } else if (entry.camera) {
      canvas.setCameraState(entry.camera, 400);
    }
    if (entry.selectedNodeId) {
      const node = graph?.nodes.find((n) => n.id === entry.selectedNodeId) ?? null;
      setSelectedNode(node);
    } else {
      setSelectedNode(null);
    }
  }, [graph, graphViewMode, setGraphViewMode, setSelectedNode]);
```

Render `<NavigationTrail onRestore={handleRestoreView} />` in the graph overlay layer above the graph controls.

- [ ] **Step 8: Run the suite and typecheck**

Run: `cd gitnexus-web && npx tsc -b --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add gitnexus-web/src/hooks/useAppState.tsx gitnexus-web/src/components/NavigationTrail.tsx gitnexus-web/src/App.tsx gitnexus-web/src/locales gitnexus-web/test/unit/view-history.test.tsx
git commit -m "feat(web): add view history and navigation trail

Captures camera, selection, and view mode before AI-driven navigation so
automatic camera movement is reversible. Restoring across a view-mode
change reapplies the mode first and waits for the layout to settle,
because switching modes fires three independent camera resets."
```

---

## Task 5: NexusGraphController

**Files:**
- Create: `gitnexus-web/src/core/llm/graph-controller.ts`
- Modify: `gitnexus-web/src/hooks/useAppState.tsx` (construct the controller, add `setHighlight`)
- Test: `gitnexus-web/test/unit/graph-controller.test.ts` (create)

**Interfaces:**
- Consumes: `GraphCanvasHandle` (Task 3), `resolveTarget` (Task 2), `pushViewHistory` (Task 4).
- Produces:

```ts
export type HighlightChannel = 'ai-tool' | 'blast-radius' | 'query';

export interface GraphSnapshot {
  viewMode: string;
  selectedNodeId: string | null;
  selectedNodeName: string | null;
  visibleNodeCount: number;
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
  animate(targets: string[], type: 'pulse' | 'ripple' | 'glow', durationMs?: number): Promise<string>;
  setViewMode(mode: 'force' | 'tree' | 'circles' | 'runtime'): Promise<string>;
  setFilters(opts: { nodeLabels?: string[]; edgeTypes?: string[]; depth?: number | null }): Promise<string>;
  openCode(opts: { filePath: string; startLine?: number; endLine?: number }): Promise<string>;
  neighbors(target: string, opts?: { depth?: number; direction?: 'in' | 'out' | 'both'; edgeTypes?: string[] }): Promise<string>;
  snapshot(): Promise<GraphSnapshot>;
  clearVisuals(scope?: 'highlights' | 'filters' | 'all'): Promise<string>;
}
```

Task 6 consumes every method.

- [ ] **Step 1: Write the failing test**

Create `gitnexus-web/test/unit/graph-controller.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createGraphController } from '../../src/core/llm/graph-controller';

const graph = {
  nodes: [
    { id: 'File:src/a.ts', label: 'File', properties: { name: 'a.ts', filePath: 'src/a.ts' } },
    { id: 'Function:src/a.ts:run', label: 'Function', properties: { name: 'run', filePath: 'src/a.ts', startLine: 4, endLine: 9 } },
  ],
  relationships: [],
  nodeCount: 2,
  relationshipCount: 0,
} as any;

const makeDeps = () => ({
  getGraph: () => graph,
  canvas: {
    focusNode: vi.fn(),
    frameNodes: vi.fn(),
    getCameraState: vi.fn(() => ({ x: 0, y: 0, ratio: 1, angle: 0 })),
    setCameraState: vi.fn(),
    getNeighbors: vi.fn(() => [
      { nodeId: 'File:src/a.ts', name: 'a.ts', label: 'File', relationship: 'DEFINES', direction: 'in' as const, rendered: true },
    ]),
  },
  setHighlightChannel: vi.fn(),
  triggerNodeAnimation: vi.fn(),
  setGraphViewMode: vi.fn(),
  setDepthFilter: vi.fn(),
  addCodeReference: vi.fn(),
  pushViewHistory: vi.fn(),
  getSnapshot: () => ({
    viewMode: 'force', selectedNodeId: null, selectedNodeName: null,
    visibleNodeCount: 2, totalNodeCount: 2, visibleEdgeTypes: ['CALLS'],
    depthFilter: null, highlightCounts: { 'ai-tool': 0, 'blast-radius': 0, query: 0 },
    editingEnabled: false, historyDepth: 0,
  }),
  clearVisuals: vi.fn(),
});

describe('NexusGraphController', () => {
  it('focusNode resolves a target and drives the canvas', async () => {
    const deps = makeDeps();
    const c = createGraphController(deps as any);
    const out = await c.focusNode('run');
    expect(deps.canvas.focusNode).toHaveBeenCalledWith('Function:src/a.ts:run', expect.anything());
    expect(deps.pushViewHistory).toHaveBeenCalled();
    expect(out).toContain('Function:src/a.ts:run');
  });

  it('focusNode reports ambiguity without navigating', async () => {
    const deps = makeDeps();
    deps.getGraph = () => ({
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: 'Function:src/b.ts:run', label: 'Function', properties: { name: 'run', filePath: 'src/b.ts' } },
      ],
    }) as any;
    const c = createGraphController(deps as any);
    const out = await c.focusNode('run');
    expect(deps.canvas.focusNode).not.toHaveBeenCalled();
    expect(out.toLowerCase()).toContain('ambiguous');
  });

  it('focusNode reports a miss without navigating', async () => {
    const deps = makeDeps();
    const c = createGraphController(deps as any);
    const out = await c.focusNode('nope');
    expect(deps.canvas.focusNode).not.toHaveBeenCalled();
    expect(out.toLowerCase()).toContain('no node matched');
  });

  it('neighbors reports rendered and filtered relationships separately', async () => {
    const deps = makeDeps();
    deps.canvas.getNeighbors = vi.fn(() => [
      { nodeId: 'X', name: 'x', label: 'Function', relationship: 'CALLS', direction: 'out' as const, rendered: true },
      { nodeId: 'Y', name: 'y', label: 'Function', relationship: 'USES', direction: 'out' as const, rendered: false },
    ]) as any;
    const c = createGraphController(deps as any);
    const out = await c.neighbors('run');
    expect(out).toContain('CALLS');
    expect(out).toContain('USES');
    expect(out.toLowerCase()).toContain('not currently drawn');
  });

  it('setHighlight resolves targets and reports unresolved ones', async () => {
    const deps = makeDeps();
    const c = createGraphController(deps as any);
    const out = await c.setHighlight(['run', 'ghost'], 'ai-tool');
    expect(deps.setHighlightChannel).toHaveBeenCalledWith(
      new Set(['Function:src/a.ts:run']),
      'ai-tool',
    );
    expect(out).toContain('ghost');
  });

  it('frameNodes rejects more than 100 targets', async () => {
    const deps = makeDeps();
    const c = createGraphController(deps as any);
    const out = await c.frameNodes(Array.from({ length: 101 }, (_, i) => `n${i}`));
    expect(out.toLowerCase()).toContain('at most 100');
    expect(deps.canvas.frameNodes).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/graph-controller.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the controller**

Create `gitnexus-web/src/core/llm/graph-controller.ts` with the interfaces from the Interfaces block plus a `createGraphController(deps)` factory. Key behaviors, each covered by a test above:

- `focusNode` calls `resolveTarget`; on `ambiguous` it returns a message listing candidates and does not navigate; on `miss` it returns the reason and does not navigate; on `match` it calls `pushViewHistory` with the label `Before focusing <name>`, then `canvas.focusNode(nodeId, { zoom })`, then `addCodeReference` when `openCode !== false` and the node has a `filePath`.
- `frameNodes` and `setHighlight` cap at 100 targets, returning `Provide at most 100 targets.` when exceeded.
- `neighbors` caps at 50 returned entries, states the true total when it truncates, and groups the result into rendered relationships and ones described as `not currently drawn in the current filter`.
- `setViewMode` calls `pushViewHistory` before switching, because switching resets the camera.
- `snapshot` delegates to `deps.getSnapshot()`.
- Every method returns a plain string for the model; only `snapshot` returns an object.

Also export a `createNoopGraphController()` returning `'The graph UI is not available.'` from each method, for tests and for the chat-only mode where no canvas is mounted.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/graph-controller.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Add the public highlight setter**

In `gitnexus-web/src/hooks/useAppState.tsx`, add a single channel-keyed setter next to the existing clear functions (~line 316):

```ts
  const setHighlightChannel = useCallback((nodeIds: Set<string>, channel: HighlightChannel) => {
    if (channel === 'ai-tool') setAIToolHighlightedNodeIds(nodeIds);
    else if (channel === 'blast-radius') setBlastRadiusNodeIds(nodeIds);
    else setHighlightedNodeIds(nodeIds);
  }, []);
```

Expose it on the interface and value object.

- [ ] **Step 6: Construct the controller in App**

In `gitnexus-web/src/App.tsx`, build the controller with `useMemo` from `graphCanvasRef.current` and the app-state functions, and pass it into `initializeAgent`. When `graphCanvasRef.current` is null (chat-only mode), pass `createNoopGraphController()`.

- [ ] **Step 7: Typecheck and run the suite**

Run: `cd gitnexus-web && npx tsc -b --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add gitnexus-web/src/core/llm/graph-controller.ts gitnexus-web/src/hooks/useAppState.tsx gitnexus-web/src/App.tsx gitnexus-web/test/unit/graph-controller.test.ts
git commit -m "feat(web): add NexusGraphController

Typed controller giving the agent camera, selection, highlight, filter,
and neighbor operations, replacing the string-marker side channel for new
capabilities. Ambiguous and missed targets are reported to the model
rather than silently resolved."
```

---

## Task 6: The nine navigation tools

**Files:**
- Create: `gitnexus-web/src/core/llm/graph-tools.ts`
- Modify: `gitnexus-web/src/core/llm/tools.ts:23-31` (tool names), `:54` (factory signature), `:1513` (return array)
- Modify: `gitnexus-web/src/hooks/useAppState.tsx` (pass the controller to `createGraphRAGTools`)
- Test: `gitnexus-web/test/unit/graph-tools.test.ts` (create)

**Interfaces:**
- Consumes: `NexusGraphController` (Task 5).
- Produces: `createGraphControlTools(ui: NexusGraphController)` returning nine LangChain tools, and `GRAPH_CONTROL_TOOL_NAMES`.

- [ ] **Step 1: Write the failing test**

Create `gitnexus-web/test/unit/graph-tools.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createGraphControlTools, GRAPH_CONTROL_TOOL_NAMES } from '../../src/core/llm/graph-tools';

const stubController = () => ({
  focusNode: vi.fn(async () => 'focused'),
  frameNodes: vi.fn(async () => 'framed'),
  setHighlight: vi.fn(async () => 'highlighted'),
  animate: vi.fn(async () => 'animated'),
  setViewMode: vi.fn(async () => 'switched'),
  setFilters: vi.fn(async () => 'filtered'),
  openCode: vi.fn(async () => 'opened'),
  neighbors: vi.fn(async () => 'neighbors'),
  snapshot: vi.fn(async () => ({ viewMode: 'force' })),
  clearVisuals: vi.fn(async () => 'cleared'),
});

describe('graph control tools', () => {
  it('registers exactly the nine declared names', () => {
    const tools = createGraphControlTools(stubController() as any);
    expect(tools.map((t) => t.name).sort()).toEqual([...GRAPH_CONTROL_TOOL_NAMES].sort());
    expect(GRAPH_CONTROL_TOOL_NAMES).toHaveLength(9);
  });

  it('focus_node forwards target and options', async () => {
    const ui = stubController();
    const tools = createGraphControlTools(ui as any);
    const tool = tools.find((t) => t.name === 'focus_node')!;
    await tool.invoke({ target: 'envBaseFor', zoom: 0.2 });
    expect(ui.focusNode).toHaveBeenCalledWith('envBaseFor', { zoom: 0.2, openCode: undefined });
  });

  it('show_neighbors clamps depth to the 1-3 range', async () => {
    const ui = stubController();
    const tools = createGraphControlTools(ui as any);
    const tool = tools.find((t) => t.name === 'show_neighbors')!;
    await tool.invoke({ target: 'x', depth: 9 });
    expect(ui.neighbors).toHaveBeenCalledWith('x', expect.objectContaining({ depth: 3 }));
  });

  it('graph_snapshot serializes the snapshot object to text', async () => {
    const ui = stubController();
    const tools = createGraphControlTools(ui as any);
    const tool = tools.find((t) => t.name === 'graph_snapshot')!;
    const out = await tool.invoke({});
    expect(String(out)).toContain('force');
  });

  it('a controller error is returned as text, not thrown', async () => {
    const ui = stubController();
    ui.focusNode = vi.fn(async () => {
      throw new Error('canvas gone');
    });
    const tools = createGraphControlTools(ui as any);
    const tool = tools.find((t) => t.name === 'focus_node')!;
    const out = await tool.invoke({ target: 'x' });
    expect(String(out)).toContain('canvas gone');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/graph-tools.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the tools**

Create `gitnexus-web/src/core/llm/graph-tools.ts` following the `tool(...)` pattern at `tools.ts:423-453`. Declare:

```ts
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
```

Every tool body is wrapped in `try/catch` returning `Error: ${message}` so a UI failure never aborts the agent loop. Zod schemas:

- `focus_node`: `{ target: z.string(), zoom: z.number().min(0.01).max(2).optional(), openCode: z.boolean().optional() }`
- `show_neighbors`: `{ target: z.string(), depth: z.number().int().optional(), direction: z.enum(['in','out','both']).optional(), edgeTypes: z.array(z.string()).optional() }` — clamp `depth` with `Math.max(1, Math.min(3, depth ?? 1))` before delegating
- `highlight_nodes`: `{ targets: z.array(z.string()), style: z.enum(['cyan','impact','glow']).optional(), animate: z.boolean().optional() }` — map `cyan`→`ai-tool`, `impact`→`blast-radius`, `glow`→`query`; when `animate` is true also call `ui.animate` with `pulse`/`ripple`/`glow` respectively
- `frame_nodes`: `{ targets: z.array(z.string()), padding: z.number().optional() }`
- `set_view_mode`: `{ mode: z.enum(['force','tree','circles','runtime']) }`
- `set_filters`: `{ nodeLabels: z.array(z.string()).optional(), edgeTypes: z.array(z.string()).optional(), depth: z.number().int().nullable().optional() }`
- `open_code`: `{ filePath: z.string(), startLine: z.number().int().optional(), endLine: z.number().int().optional() }` — describe these as **1-based** in the schema description and convert to 0-based before calling `ui.openCode`
- `graph_snapshot`: `z.object({})`, returns `JSON.stringify(snapshot, null, 2)`
- `clear_visuals`: `{ scope: z.enum(['highlights','filters','all']).optional() }`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/graph-tools.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Register the tools in the factory**

In `gitnexus-web/src/core/llm/tools.ts`:

Change the signature at line 54 to `export const createGraphRAGTools = (backend: GraphRAGBackend, ui?: NexusGraphController) => {`.

Extend `GRAPH_RAG_TOOL_NAMES` at lines 23-31 to include the nine control names plus `propose_edit` (Task 15), giving seventeen entries total.

Change the return at line 1513 to:

```ts
  const controlTools = ui ? createGraphControlTools(ui) : [];
  return [
    searchTool,
    cypherTool,
    grepTool,
    readTool,
    overviewTool,
    exploreTool,
    impactTool,
    ...controlTools,
  ];
```

Pass the controller through from `useAppState.tsx` where `createGraphRAGTools(backend)` is called (near line 691).

- [ ] **Step 6: Run the suite**

Run: `cd gitnexus-web && npx tsc -b --noEmit && npx vitest run`
Expected: `agent-prompt.test.ts` FAILS because `GRAPH_RAG_TOOL_NAMES` now lists names absent from `BASE_SYSTEM_PROMPT`. That failure is expected and is fixed by Task 7. All other tests PASS.

- [ ] **Step 7: Commit**

```bash
git add gitnexus-web/src/core/llm/graph-tools.ts gitnexus-web/src/core/llm/tools.ts gitnexus-web/src/hooks/useAppState.tsx gitnexus-web/test/unit/graph-tools.test.ts
git commit -m "feat(web): add nine graph navigation tools for Nexus

focus_node, show_neighbors, highlight_nodes, frame_nodes, set_view_mode,
set_filters, open_code, graph_snapshot, and clear_visuals. Tool bodies
never throw; UI failures are returned as text so the agent loop can
recover. agent-prompt.test.ts stays red until the system prompt lands."
```

---

## Task 7: System prompt rewrite

**Files:**
- Modify: `gitnexus-web/src/core/llm/agent.ts:136-140` and `:173-197`
- Modify: `gitnexus-web/test/unit/agent-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `gitnexus-web/test/unit/agent-prompt.test.ts`:

```ts
describe('graph control prompt', () => {
  it('documents every registered tool name', () => {
    for (const name of GRAPH_RAG_TOOL_NAMES) {
      expect(BASE_SYSTEM_PROMPT).toContain(name);
    }
  });

  it('no longer claims the agent cannot move the viewport', () => {
    expect(BASE_SYSTEM_PROMPT).not.toContain('You cannot programmatically zoom');
    expect(BASE_SYSTEM_PROMPT).not.toContain('There is NO `highlight_in_graph` tool');
  });

  it('bounds camera movement to one destination per turn', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/one .{0,20}focus_node/i);
  });

  it('forbids unrequested edits', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/never propose .{0,40}edit/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/agent-prompt.test.ts`
Expected: FAIL on all four.

- [ ] **Step 3: Replace the VISUAL GROUNDING section**

Replace `agent.ts:136-140` with:

```
## 🎯 VISUAL GROUNDING
The user sees a knowledge graph alongside this chat, and you can drive it.
- Citations \`[[path:START-END]]\` and \`[[Type:Name]]\` highlight nodes passively. Use them for every claim.
- The graph control tools below actively move the user's view. Use them deliberately, not for every reference.
- Rule of thumb: cite everything, navigate once. A citation is a footnote; a navigation is "look here now".
```

- [ ] **Step 4: Replace the animations and limitations sections**

Replace `agent.ts:173-197` (the `🎬 GRAPH ANIMATIONS & VISUAL EFFECTS` block through the end of `What you CANNOT do`) with:

```
## 🎬 GRAPH CONTROL (you drive the user's view)
You can move the camera, select nodes, highlight sets, switch layouts, and open source.

**Tools:**
- \`focus_node\` — Fly the camera to a symbol, select it, and open its source in the Code Inspector. Your primary "show me" action.
- \`show_neighbors\` — Highlight what a symbol connects to AND return each relationship's type and direction so you can explain the consequences.
- \`highlight_nodes\` — Light up a set. \`cyan\` for relevance, \`impact\` for blast radius, \`glow\` for emphasis.
- \`frame_nodes\` — Fit the camera around several symbols at once. Prefer this over repeated \`focus_node\` calls when a whole chain matters.
- \`set_view_mode\` — Switch Force, Tree, Circles, or Runtime.
- \`set_filters\` — Change which node labels, edge types, or hop depth are visible.
- \`open_code\` — Open a file at a line range without needing a graph node. Line numbers are 1-based.
- \`graph_snapshot\` — Read what the user is currently looking at before you change it.
- \`clear_visuals\` — Reset highlights or filters.

**Navigation policy:**
1. When your answer has one clear subject, call \`focus_node\` on it. Do not make the user hunt.
2. Change the camera destination at most one time per reply. Use \`frame_nodes\` when several symbols matter equally.
3. Always narrate what you just did: "I've focused the graph on X — the highlighted nodes around it are its callers."
4. After \`show_neighbors\`, explain the relationships. Highlighting without explanation is an incomplete answer.
5. Only six edge types are drawn. If \`show_neighbors\` reports a relationship as not currently drawn, say the edge is real but hidden by the current filter. Never claim a relationship does not exist because it is not visible.
6. Targets are resolved loosely. If a tool reports the target is ambiguous, ask the user which one or refine with a file path.

## ✏️ CODE EDITING
The Code Inspector is an editor when the user enables editing for the repository.
- \`propose_edit\` — Stage a change for the user's confirmation. It writes nothing.
- **Never propose an edit the user did not ask for.** If you spot a problem, describe it and offer to fix it. Wait to be asked.
- The user confirms the diff card, the change lands in the editor as unsaved, and the user saves. You never touch disk.
- If the tool reports editing is disabled, tell the user to enable editing in the Code Inspector. Do not retry.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/agent-prompt.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add gitnexus-web/src/core/llm/agent.ts gitnexus-web/test/unit/agent-prompt.test.ts
git commit -m "docs(agent): document graph control and remove stale UI limitations

The prompt claimed the agent could not move the viewport or switch view
mode, which is no longer true. Adds the navigation policy bounding camera
movement to one destination per turn, the requirement to explain
relationships rather than only highlight them, and the rule that hidden
edge types must not be reported as nonexistent."
```

---

## Task 8: Server file write route

**Files:**
- Modify: `gitnexus/src/server/api.ts` (add `handleFileWriteRequest` near `handleFileRequest` at line 578; mount near line 1337; extend `/api/info` at line 932)
- Modify: `gitnexus/src/server/index.ts` or the serve command entry to accept `--allow-file-writes`
- Test: `gitnexus/test/unit/api-file-write-route.test.ts` (create)

**Interfaces:**
- Produces: `PUT /api/file` accepting `{ repo?, path, content, expectedSha }` and returning `{ ok: true, sha }`. `/api/info` gains `fileWritesEnabled: boolean`. Task 9 consumes both.

- [ ] **Step 1: Write the failing test**

Create `gitnexus/test/unit/api-file-write-route.test.ts` modeled on the existing `api-file-route.test.ts`. Cover, one `it` each: a successful write returning the new sha; `..` traversal rejected with 403; an absolute path rejected with 403; a symlink at the resolved path rejected with 403; a path that does not already exist rejected with 404; a body over the size cap rejected with 413; an `expectedSha` mismatch rejected with 409; writes disabled by configuration rejected with 403; and confirmation that no `.tmp` file remains in the directory after a successful write.

```ts
it('rejects a path escaping the repository root', async () => {
  const res = mockRes();
  await handleFileWriteRequest(
    { body: { path: '../../etc/passwd', content: 'x', expectedSha: 'anything' } } as any,
    res as any,
    repoRoot,
    { allowWrites: true },
  );
  expect(res.statusCode).toBe(403);
  expect(res.body.error).toMatch(/traversal/i);
});

it('rejects when expectedSha does not match the file on disk', async () => {
  const res = mockRes();
  await handleFileWriteRequest(
    { body: { path: 'src/a.ts', content: 'new', expectedSha: 'stale-sha' } } as any,
    res as any,
    repoRoot,
    { allowWrites: true },
  );
  expect(res.statusCode).toBe(409);
});

it('rejects every write when writes are disabled', async () => {
  const res = mockRes();
  await handleFileWriteRequest(
    { body: { path: 'src/a.ts', content: 'x', expectedSha: shaOf('original') } } as any,
    res as any,
    repoRoot,
    { allowWrites: false },
  );
  expect(res.statusCode).toBe(403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus && npx vitest run test/unit/api-file-write-route.test.ts`
Expected: FAIL — `handleFileWriteRequest` is not exported.

- [ ] **Step 3: Implement the handler**

Add to `gitnexus/src/server/api.ts` directly after `handleFileRequest` (line 645):

```ts
/** Maximum accepted file body. Larger writes are rejected with 413. */
const MAX_WRITE_BYTES = 2 * 1024 * 1024;

export const shaOfContent = (content: string): string =>
  crypto.createHash('sha256').update(content, 'utf-8').digest('hex');

export const handleFileWriteRequest = async (
  req: { body: any },
  res: {
    status: (code: number) => { json: (body: any) => void };
    json: (body: any) => void;
  },
  repoPath: string,
  opts: { allowWrites: boolean },
): Promise<void> => {
  try {
    if (!opts.allowWrites) {
      res.status(403).json({
        error:
          'File writes are disabled on this server. Start it with --allow-file-writes to enable editing.',
      });
      return;
    }

    const rawFilePath = req.body?.path;
    if (rawFilePath === undefined || rawFilePath === '') {
      res.status(400).json({ error: 'Missing path' });
      return;
    }
    const filePath = assertString(rawFilePath, 'path');
    const content = req.body?.content;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Missing content' });
      return;
    }
    const expectedSha = req.body?.expectedSha;
    if (typeof expectedSha !== 'string' || expectedSha.length === 0) {
      res.status(400).json({ error: 'Missing expectedSha' });
      return;
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_BYTES) {
      res.status(413).json({ error: 'File too large to save' });
      return;
    }

    // Path-injection containment — inline at the sink with the canonical
    // path.relative idiom that CodeQL's js/path-injection sanitizer
    // recognizes. See the equivalent barrier in handleFileRequest; the
    // check must be visible inline at the writeFile sink for the same
    // interprocedural-analysis reason.
    const repoRoot = path.resolve(repoPath);
    const fullPath = path.resolve(repoRoot, filePath);
    const fullRel = path.relative(repoRoot, fullPath);
    if (fullRel.startsWith('..') || path.isAbsolute(fullRel)) {
      res.status(403).json({ error: 'Path traversal denied' });
      return;
    }

    // A symlink inside the repository could redirect the write outside it,
    // so reject anything that is not a regular file. lstat does not follow.
    let stat;
    try {
      stat = await fs.lstat(fullPath);
    } catch {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      res.status(403).json({ error: 'Refusing to write a non-regular file' });
      return;
    }

    const current = await fs.readFile(fullPath, 'utf-8');
    if (shaOfContent(current) !== expectedSha) {
      res.status(409).json({
        error: 'The file changed on disk since it was opened. Reload it before saving.',
      });
      return;
    }

    // Atomic replace: write a sibling temp file, then rename over the target.
    const tempPath = `${fullPath}.gitnexus-${process.pid}-${Date.now()}.tmp`;
    try {
      await fs.writeFile(tempPath, content, 'utf-8');
      await fs.rename(tempPath, fullPath);
    } catch (writeErr) {
      await fs.rm(tempPath, { force: true });
      throw writeErr;
    }

    res.json({ ok: true, sha: shaOfContent(content) });
  } catch (err: any) {
    res.status(statusFromError(err)).json({ error: err.message || 'Failed to write file' });
  }
};
```

Add `import crypto from 'node:crypto';` if not already imported.

- [ ] **Step 4: Mount the route**

After the `GET /api/file` mount at `api.ts:1337-1344`:

```ts
  app.put(
    '/api/file',
    createRouteLimiter({ limit: 30 }),
    requireTrustedOrigin,
    express.json({ limit: '4mb' }),
    async (req, res) => {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      await handleFileWriteRequest(req, res, entry.path, { allowWrites: allowFileWrites });
    },
  );
```

Compute `allowFileWrites` where `requireTrustedOrigin` is created (`api.ts:766`):

```ts
  // File writes default on for loopback-bound servers and off otherwise, so
  // exposing the server on a network does not silently add a write surface.
  const isLoopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const allowFileWrites =
    process.env.GITNEXUS_ALLOW_FILE_WRITES === '1'
      ? true
      : process.env.GITNEXUS_ALLOW_FILE_WRITES === '0'
        ? false
        : options.allowFileWrites ?? isLoopbackHost;
```

Add `fileWritesEnabled: allowFileWrites` to the `/api/info` response at `api.ts:932`.

- [ ] **Step 5: Add the CLI flag**

Wire `--allow-file-writes` through the serve command into `options.allowFileWrites`, following how existing serve flags are parsed.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd gitnexus && npx vitest run test/unit/api-file-write-route.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 7: Run the server suite**

Run: `cd gitnexus && npx vitest run test/unit/api-file-route.test.ts test/unit/rate-limit.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add gitnexus/src/server/api.ts gitnexus/test/unit/api-file-write-route.test.ts
git commit -m "feat(server): add gated PUT /api/file for Code Inspector saves

Inline path containment at the sink, symlink rejection, existing-files
only, 2MB cap, sha-based optimistic concurrency returning 409 on drift,
and atomic temp-file-plus-rename. Disabled unless the server is loopback
bound or --allow-file-writes is passed, so exposing the server on a
network does not add a write surface."
```

---

## Task 9: Client write API

**Files:**
- Modify: `gitnexus-web/src/services/backend-client.ts` (after `readFile` at line 917)
- Test: `gitnexus-web/test/unit/backend-write-file.test.ts` (create)

**Interfaces:**
- Produces:

```ts
export interface WriteFileResult { ok: true; sha: string; }
export const writeFile = async (
  filePath: string,
  content: string,
  expectedSha: string,
  options?: { repo?: string },
): Promise<WriteFileResult> => { ... };
export const shaOfContent = async (content: string): Promise<string> => { ... };
```

Task 10 consumes both.

- [ ] **Step 1: Write the failing test**

Create `gitnexus-web/test/unit/backend-write-file.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { writeFile, shaOfContent, setBackendUrl } from '../../src/services/backend-client';

describe('writeFile', () => {
  beforeEach(() => setBackendUrl('http://localhost:4747'));

  it('PUTs the body and returns the new sha', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, sha: 'abc' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await writeFile('src/a.ts', 'next', 'prev-sha', { repo: 'demo' });
    expect(result.sha).toBe('abc');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/file');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toMatchObject({ path: 'src/a.ts', content: 'next', expectedSha: 'prev-sha' });
  });

  it('surfaces a 409 conflict as an error mentioning the drift', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'The file changed on disk since it was opened. Reload it before saving.' }), { status: 409 })));
    await expect(writeFile('src/a.ts', 'x', 'stale')).rejects.toThrow(/changed on disk/i);
  });

  it('computes a stable sha for identical content', async () => {
    expect(await shaOfContent('hello')).toBe(await shaOfContent('hello'));
    expect(await shaOfContent('hello')).not.toBe(await shaOfContent('world'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/backend-write-file.test.ts`
Expected: FAIL — `writeFile` is not exported.

- [ ] **Step 3: Implement the client**

Add to `gitnexus-web/src/services/backend-client.ts` after `readFile`:

```ts
export interface WriteFileResult {
  ok: true;
  sha: string;
}

/** SHA-256 of the file content, matching the server's shaOfContent. */
export const shaOfContent = async (content: string): Promise<string> => {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

export const writeFile = async (
  filePath: string,
  content: string,
  expectedSha: string,
  options?: { repo?: string },
): Promise<WriteFileResult> => {
  const params = [repoParam(options?.repo)].filter(Boolean).join('&');
  const response = await fetchWithTimeout(`${_backendUrl}/api/file${params ? `?${params}` : ''}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content, expectedSha }),
  });
  await assertOk(response);
  return response.json() as Promise<WriteFileResult>;
};
```

`fetchWithTimeout` already defaults non-idempotent verbs to `maxAttempts = 1` (`backend-client.ts:441`); do not override it. A save must never be silently retried.

Extend the `getInfo` result type with `fileWritesEnabled?: boolean`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/backend-write-file.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add gitnexus-web/src/services/backend-client.ts gitnexus-web/test/unit/backend-write-file.test.ts
git commit -m "feat(web): add writeFile client with sha-based conflict detection

Saves are never retried; a 409 surfaces as an explicit on-disk-drift
error the Inspector can show rather than a silent overwrite."
```

---

## Task 10: CodeMirror editor in the Code Inspector

**Files:**
- Create: `gitnexus-web/src/lib/editor-languages.ts`
- Create: `gitnexus-web/src/components/CodeEditor.tsx`
- Create: `gitnexus-web/src/hooks/useEditingEnabled.ts`
- Modify: `gitnexus-web/src/components/CodeReferencesPanel.tsx:394-426`
- Modify: `gitnexus-web/src/locales/en/graph.json`, `gitnexus-web/src/locales/zh-CN/graph.json`
- Test: `gitnexus-web/test/unit/editor-languages.test.ts`, `gitnexus-web/test/unit/code-editor.test.tsx` (create)

**Interfaces:**
- Consumes: `writeFile`, `shaOfContent` (Task 9).
- Produces: `getEditorLanguage(filePath: string): Promise<Extension | null>`, `<CodeEditor />`, `useEditingEnabled(repo)` returning `{ enabled, setEnabled, serverAllows }`.

- [ ] **Step 1: Install dependencies**

```bash
cd gitnexus-web && npm install codemirror @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/autocomplete @codemirror/lint @codemirror/search @codemirror/lang-javascript @codemirror/lang-python @codemirror/lang-java @codemirror/lang-cpp @codemirror/lang-go @codemirror/lang-rust @codemirror/lang-php @codemirror/lang-vue @codemirror/legacy-modes
```

- [ ] **Step 2: Write the failing language-mapping test**

Create `gitnexus-web/test/unit/editor-languages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EDITOR_LANGUAGE_IDS, getEditorLanguage } from '../../src/lib/editor-languages';
import { SupportedLanguages } from 'gitnexus-shared';

describe('editor language mapping', () => {
  it('covers every SupportedLanguages member', () => {
    for (const lang of Object.values(SupportedLanguages)) {
      expect(EDITOR_LANGUAGE_IDS[lang as SupportedLanguages]).toBeDefined();
    }
  });

  it('resolves a TypeScript file to a loadable extension', async () => {
    await expect(getEditorLanguage('src/a.ts')).resolves.not.toBeNull();
  });

  it('resolves a Python file to a loadable extension', async () => {
    await expect(getEditorLanguage('main.py')).resolves.not.toBeNull();
  });

  it('returns null for an unmapped extension rather than throwing', async () => {
    await expect(getEditorLanguage('notes.unknownext')).resolves.toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/editor-languages.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the mapping**

Create `gitnexus-web/src/lib/editor-languages.ts`. Use a `satisfies Record<SupportedLanguages, string>` constraint so adding an enum member is a compile error, matching the convention in `gitnexus-shared/src/language-detection.ts:29`:

```ts
import type { Extension } from '@codemirror/state';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';

export const EDITOR_LANGUAGE_IDS = {
  [SupportedLanguages.JavaScript]: 'javascript',
  [SupportedLanguages.TypeScript]: 'typescript',
  [SupportedLanguages.Python]: 'python',
  [SupportedLanguages.Java]: 'java',
  [SupportedLanguages.C]: 'cpp',
  [SupportedLanguages.CPlusPlus]: 'cpp',
  [SupportedLanguages.CSharp]: 'csharp',
  [SupportedLanguages.Go]: 'go',
  [SupportedLanguages.Ruby]: 'ruby',
  [SupportedLanguages.Rust]: 'rust',
  [SupportedLanguages.PHP]: 'php',
  [SupportedLanguages.Kotlin]: 'kotlin',
  [SupportedLanguages.Swift]: 'swift',
  [SupportedLanguages.Dart]: 'dart',
  [SupportedLanguages.Vue]: 'vue',
  [SupportedLanguages.Cobol]: 'cobol',
} satisfies Record<SupportedLanguages, string>;
```

`getEditorLanguage(filePath)` maps the id to a dynamically imported extension: first-class packages for `javascript`, `typescript`, `python`, `java`, `cpp`, `go`, `rust`, `php`, `vue`; `@codemirror/legacy-modes` via `StreamLanguage` for `csharp`, `ruby`, `kotlin`, `swift`, `dart`, `cobol`; and the auxiliary extensions (`json`, `yaml`, `markdown`, `css`, `html`, `sql`, `shell`, `toml`) through the same path. Return `null` when nothing matches, and wrap each import in `try/catch` returning `null` so a missing optional package degrades to plain text rather than breaking the editor.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/editor-languages.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Write the failing editor test**

Create `gitnexus-web/test/unit/code-editor.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CodeEditor } from '../../src/components/CodeEditor';

describe('CodeEditor', () => {
  it('renders the supplied content', async () => {
    render(
      <CodeEditor
        filePath="src/a.ts"
        content={'const a = 1;\nconst b = 2;\n'}
        firstLine={0}
        editable={false}
        highlightRange={null}
        diagnostics={[]}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/const a = 1;/)).toBeTruthy());
  });

  it('does not call onChange while read-only', async () => {
    const onChange = vi.fn();
    render(
      <CodeEditor
        filePath="src/a.ts"
        content="const a = 1;"
        firstLine={0}
        editable={false}
        highlightRange={null}
        diagnostics={[]}
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(screen.getByText(/const a = 1;/)).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports edits through onChange when editable', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <CodeEditor
        filePath="src/a.ts"
        content="const a = 1;"
        firstLine={0}
        editable
        highlightRange={null}
        diagnostics={[]}
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(container.querySelector('.cm-content')).toBeTruthy());
    // Dispatch through the CodeMirror view exposed on the container for tests.
    const view = (container.querySelector('.cm-editor') as any).__cmView;
    view.dispatch({ changes: { from: 0, insert: '// ' } });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/code-editor.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 8: Implement CodeEditor**

Create `gitnexus-web/src/components/CodeEditor.tsx` wrapping an `EditorView`. Requirements:

- Props: `filePath`, `content`, `firstLine` (0-based absolute line of the first rendered line, replacing `startingLineNumber`), `editable`, `highlightRange: { start: number; end: number } | null` (0-based absolute), `diagnostics: EditorDiagnostic[]`, `onChange(next: string)`.
- Line numbers render as `firstLine + relativeLine`, via `lineNumbers({ formatNumber: (n) => String(firstLine + n) })`.
- The highlight band is a `Decoration.line` range set computed from `highlightRange`, converting absolute 0-based to view-relative 1-based with `absolute - firstLine + 1`. This is where the Task 1 defect is permanently fixed.
- `EditorView.editable.of(editable)` and `EditorState.readOnly.of(!editable)`.
- Theme matching the existing panel: background `#0a0a10`, 13px, line-height 1.6, JetBrains Mono.
- Diagnostics feed `setDiagnostics` from `@codemirror/lint`.
- The language extension loads asynchronously in an effect and is applied through a `Compartment` so the editor renders immediately in plain text and gains highlighting when the import resolves.
- Expose the view as `__cmView` on the `.cm-editor` element for tests.

- [ ] **Step 9: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/code-editor.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 10: Implement the editing preference hook**

Create `gitnexus-web/src/hooks/useEditingEnabled.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { getInfo } from '../services/backend-client';

const keyFor = (repo: string | undefined) => `gitnexus.editing.${repo ?? '__none__'}`;

export const useEditingEnabled = (repo: string | undefined) => {
  const [enabled, setEnabledState] = useState(false);
  const [serverAllows, setServerAllows] = useState(false);

  useEffect(() => {
    try {
      setEnabledState(localStorage.getItem(keyFor(repo)) === '1');
    } catch {
      setEnabledState(false);
    }
  }, [repo]);

  useEffect(() => {
    let cancelled = false;
    getInfo()
      .then((info) => {
        if (!cancelled) setServerAllows(Boolean(info?.fileWritesEnabled));
      })
      .catch(() => {
        if (!cancelled) setServerAllows(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      try {
        localStorage.setItem(keyFor(repo), next ? '1' : '0');
      } catch {
        // Preference is best-effort; editing still works for this session.
      }
    },
    [repo],
  );

  return { enabled: enabled && serverAllows, setEnabled, serverAllows };
};
```

- [ ] **Step 11: Swap the viewer and add save controls**

In `gitnexus-web/src/components/CodeReferencesPanel.tsx`, replace the `SyntaxHighlighter` block at lines 394-426 with `<CodeEditor />`. Add above it a toolbar row containing: a `Read-only` badge with an `Enable editing` toggle from `useEditingEnabled`, a dirty dot when the buffer differs from the loaded content, and a `Save` button.

Save handler:

```ts
  const handleSave = useCallback(async () => {
    if (!selectedFilePath || loadedSha === null) return;
    setSaveState('saving');
    try {
      const result = await writeFile(selectedFilePath, buffer, loadedSha, {
        repo: currentRepo || projectName || undefined,
      });
      setLoadedSha(result.sha);
      setSaveState('saved');
      onSaved?.(selectedFilePath);
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    }
  }, [selectedFilePath, buffer, loadedSha, currentRepo, projectName, onSaved]);
```

Compute `loadedSha` with `shaOfContent` whenever file content loads. Bind `Ctrl+S` / `Cmd+S` to `handleSave` while the editor has focus and editing is enabled.

Delete the now-unused scroll-to-line effect at lines 265-294 and its hard-coded `20.8` line height; `CodeEditor` handles scrolling through `EditorView.scrollIntoView`.

- [ ] **Step 12: Add locale strings**

Add to both `en/graph.json` and `zh-CN/graph.json`:

```json
  "editor": {
    "readOnly": "Read-only",
    "enableEditing": "Enable editing",
    "disableEditing": "Disable editing",
    "unsaved": "Unsaved changes",
    "save": "Save",
    "saving": "Saving…",
    "saved": "Saved",
    "saveFailed": "Save failed: {{message}}",
    "writesDisabled": "This server has file writes disabled."
  }
```

Chinese values: `只读`, `启用编辑`, `禁用编辑`, `未保存的更改`, `保存`, `保存中…`, `已保存`, `保存失败：{{message}}`, `此服务器已禁用文件写入。`

- [ ] **Step 13: Run the suite and typecheck**

Run: `cd gitnexus-web && npx tsc -b --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add gitnexus-web/package.json gitnexus-web/package-lock.json gitnexus-web/src/lib/editor-languages.ts gitnexus-web/src/components/CodeEditor.tsx gitnexus-web/src/hooks/useEditingEnabled.ts gitnexus-web/src/components/CodeReferencesPanel.tsx gitnexus-web/src/locales gitnexus-web/test/unit/editor-languages.test.ts gitnexus-web/test/unit/code-editor.test.tsx
git commit -m "feat(web): make the Code Inspector an editor

CodeMirror 6 replaces the read-only highlighter, lazily importing its
language pack through a Compartment so the panel renders immediately.
Editing stays off until enabled per repository and the server advertises
that writes are allowed. Removes the DOM-selector scroll hack and its
hard-coded line height."
```

---

## Task 11: Tree-sitter syntax diagnostics

**Files:**
- Create: `gitnexus-web/src/lib/diagnostics/tree-sitter-worker.ts`
- Create: `gitnexus-web/src/lib/diagnostics/tree-sitter-source.ts`
- Modify: `gitnexus-web/vite.config.ts` (copy wasm grammars)
- Modify: `gitnexus-web/vitest.config.ts:36` (fix stale exclusion)
- Modify: `gitnexus-web/package.json` (promote `tree-sitter-wasms`, add `web-tree-sitter`)
- Test: `gitnexus-web/test/unit/tree-sitter-diagnostics.test.ts` (create)

- [ ] **Step 1: Install and promote dependencies**

```bash
cd gitnexus-web && npm install web-tree-sitter && npm install --save tree-sitter-wasms
```

`tree-sitter-wasms` is currently a devDependency at `package.json:74` that nothing imports. It becomes a real dependency because its `out/*.wasm` files are now shipped.

- [ ] **Step 2: Write the failing test**

Create `gitnexus-web/test/unit/tree-sitter-diagnostics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { grammarFileFor, GRAMMAR_COVERAGE, toDiagnostics } from '../../src/lib/diagnostics/tree-sitter-source';

describe('tree-sitter diagnostics', () => {
  it('maps a TypeScript file to its grammar asset', () => {
    expect(grammarFileFor('src/a.ts')).toBe('tree-sitter-typescript.wasm');
  });

  it('returns null for a language with no bundled grammar', () => {
    expect(grammarFileFor('legacy.cbl')).toBeNull();
  });

  it('reports which languages have grammar coverage', () => {
    expect(GRAMMAR_COVERAGE.covered).toContain('typescript');
    expect(GRAMMAR_COVERAGE.covered.length).toBeGreaterThan(0);
  });

  it('converts ERROR nodes into diagnostics with a source tag', () => {
    const diagnostics = toDiagnostics([
      { startIndex: 10, endIndex: 14, type: 'ERROR', isMissing: false },
    ]);
    expect(diagnostics[0]).toMatchObject({ from: 10, to: 14, severity: 'error', source: 'tree-sitter' });
  });

  it('describes MISSING nodes distinctly from ERROR nodes', () => {
    const [d] = toDiagnostics([{ startIndex: 3, endIndex: 3, type: ')', isMissing: true }]);
    expect(d.message.toLowerCase()).toContain('missing');
  });

  it('returns no diagnostics for a clean parse', () => {
    expect(toDiagnostics([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/tree-sitter-diagnostics.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the diagnostic source and worker**

Create `gitnexus-web/src/lib/diagnostics/tree-sitter-source.ts` exporting `grammarFileFor(filePath)`, `GRAMMAR_COVERAGE` (`{ covered: string[]; uncovered: string[] }`), `toDiagnostics(errorNodes)`, and `parseForDiagnostics(filePath, content)` which posts to the worker and resolves with diagnostics. `grammarFileFor` returns `null` for any language whose `.wasm` is not present in `node_modules/tree-sitter-wasms/out/`, so uncovered languages produce no diagnostics rather than false confidence.

Create `gitnexus-web/src/lib/diagnostics/tree-sitter-worker.ts` initializing `web-tree-sitter`, lazily loading and caching one `Language` per grammar file, parsing the posted content, walking the tree for `ERROR` and `isMissing` nodes, and posting back their byte ranges. Parsing in a worker keeps a large file from blocking the UI.

- [ ] **Step 5: Copy grammars at build time**

In `gitnexus-web/vite.config.ts`, add a plugin copying `node_modules/tree-sitter-wasms/out/*.wasm` and `node_modules/web-tree-sitter/tree-sitter.wasm` into `public/tree-sitter/` before build and serving them in dev. Create `gitnexus-web/public/.gitkeep` and add `gitnexus-web/public/tree-sitter/*.wasm` to `.gitignore`, since the files are copied from `node_modules` rather than checked in.

- [ ] **Step 6: Fix the stale coverage exclusion**

In `gitnexus-web/vitest.config.ts:36`, the exclusion `'src/core/tree-sitter/**'` points at a directory that does not exist. Replace it with the real worker path:

```ts
        'src/lib/diagnostics/tree-sitter-worker.ts', // WASM worker (requires grammar binaries)
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/tree-sitter-diagnostics.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 8: Commit**

```bash
git add gitnexus-web/package.json gitnexus-web/package-lock.json gitnexus-web/vite.config.ts gitnexus-web/vitest.config.ts gitnexus-web/src/lib/diagnostics gitnexus-web/public gitnexus-web/.gitignore gitnexus-web/test/unit/tree-sitter-diagnostics.test.ts
git commit -m "feat(web): add tree-sitter syntax diagnostics in a worker

Promotes the previously unused tree-sitter-wasms devDependency, copies
its grammars plus the web-tree-sitter runtime into public/ at build time,
and parses in a Web Worker so large files do not block the UI. Languages
without a bundled grammar produce no diagnostics rather than false
confidence. Corrects the vitest coverage exclusion that pointed at a
directory removed in an earlier refactor."
```

---

## Task 12: Graph-aware and AI-review diagnostics

**Files:**
- Create: `gitnexus-web/src/lib/diagnostics/graph-aware-source.ts`
- Create: `gitnexus-web/src/lib/diagnostics/ai-review-source.ts`
- Modify: `gitnexus-web/src/components/CodeReferencesPanel.tsx` (aggregate sources, add Review button)
- Modify: locale files
- Test: `gitnexus-web/test/unit/graph-aware-diagnostics.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `gitnexus-web/test/unit/graph-aware-diagnostics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeGraphAwareDiagnostics } from '../../src/lib/diagnostics/graph-aware-source';

const graph = {
  nodes: [
    { id: 'Function:src/a.ts:envBaseFor', label: 'Function', properties: { name: 'envBaseFor', filePath: 'src/a.ts', startLine: 4, endLine: 6 } },
    { id: 'Function:src/b.ts:caller', label: 'Function', properties: { name: 'caller', filePath: 'src/b.ts', startLine: 1, endLine: 3 } },
    { id: 'Function:src/a.ts:orphan', label: 'Function', properties: { name: 'orphan', filePath: 'src/a.ts', startLine: 8, endLine: 9 } },
  ],
  relationships: [
    { id: 'r1', sourceId: 'Function:src/b.ts:caller', targetId: 'Function:src/a.ts:envBaseFor', type: 'CALLS', confidence: 1 },
  ],
  nodeCount: 3,
  relationshipCount: 1,
} as any;

describe('graph-aware diagnostics', () => {
  it('warns when an edited buffer removes a symbol that has callers', () => {
    const out = computeGraphAwareDiagnostics(graph, 'src/a.ts', 'function orphan() {}\n');
    const warning = out.find((d) => d.message.includes('envBaseFor'));
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
    expect(warning!.message).toContain('1 caller');
  });

  it('stays silent when every symbol is still present', () => {
    const content = 'function envBaseFor() {}\nfunction orphan() {}\n';
    const out = computeGraphAwareDiagnostics(graph, 'src/a.ts', content);
    expect(out.filter((d) => d.severity === 'warning')).toHaveLength(0);
  });

  it('describes an unreferenced symbol as having no resolvable references', () => {
    const content = 'function envBaseFor() {}\nfunction orphan() {}\n';
    const out = computeGraphAwareDiagnostics(graph, 'src/a.ts', content);
    const info = out.find((d) => d.message.includes('orphan'));
    expect(info!.severity).toBe('info');
    expect(info!.message).toMatch(/no resolvable references/i);
    expect(info!.message).not.toMatch(/\bunused\b/i);
  });

  it('returns nothing when the file is not in the graph', () => {
    expect(computeGraphAwareDiagnostics(graph, 'src/unknown.ts', 'x')).toEqual([]);
  });
});
```

The third assertion enforces the repository rule that an empty caller set means the walk could not answer, not that the symbol is dead.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/graph-aware-diagnostics.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the graph-aware source**

Create `gitnexus-web/src/lib/diagnostics/graph-aware-source.ts` exporting `computeGraphAwareDiagnostics(graph, filePath, content)`. For each graph symbol whose `filePath` matches, check whether its `name` still appears as a declared identifier in the buffer. When it does not, count inbound relationships and emit a `warning` naming the caller count. When a symbol is present but has zero inbound relationships, emit an `info` worded `"<name>" has no resolvable references. Callers may exist but not be resolvable by the index.` Anchor each diagnostic to the symbol's line range when present, otherwise to the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/graph-aware-diagnostics.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Implement the AI review source**

Create `gitnexus-web/src/lib/diagnostics/ai-review-source.ts` exporting `reviewFile(params)` that sends the buffer plus the file's graph symbols to the configured provider through the existing agent plumbing, and parses the reply into diagnostics with optional `replacement` text. Return an empty array with a surfaced error message when no provider is configured, so the button explains itself rather than failing silently.

- [ ] **Step 6: Aggregate the sources in the panel**

In `CodeReferencesPanel.tsx`, combine the four sources into one array passed to `CodeEditor`, each entry tagged with `source: 'tree-sitter' | 'language' | 'graph' | 'ai'`. Debounce the tree-sitter and graph-aware recomputation at 400ms after the last keystroke. Add a `Review file` button that calls `reviewFile`, plus per-source toggles in the settings panel. Diagnostics never block saving.

- [ ] **Step 7: Add locale strings**

Add `diagnostics.reviewFile`, `diagnostics.reviewing`, `diagnostics.noProvider`, `diagnostics.sourceTreeSitter`, `diagnostics.sourceLanguage`, `diagnostics.sourceGraph`, `diagnostics.sourceAi` to both locale files.

- [ ] **Step 8: Run the suite**

Run: `cd gitnexus-web && npx tsc -b --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add gitnexus-web/src/lib/diagnostics gitnexus-web/src/components/CodeReferencesPanel.tsx gitnexus-web/src/locales gitnexus-web/test/unit/graph-aware-diagnostics.test.ts
git commit -m "feat(web): add graph-aware and on-demand AI diagnostics

Removing a symbol that has callers raises a warning naming the caller
count, sourced from the same graph data as impact analysis. Symbols with
no inbound edges are reported as having no resolvable references rather
than being called unused, because an empty caller set can also mean the
callers are not resolvable by the index. AI review stays behind an
explicit button so it never spends tokens silently."
```

---

## Task 13: Nexus edit proposals

**Files:**
- Create: `gitnexus-web/src/core/llm/edit-tools.ts`
- Create: `gitnexus-web/src/lib/nexus-edit-marker.ts`
- Create: `gitnexus-web/src/components/NexusEditCard.tsx`
- Modify: `gitnexus-web/src/components/MarkdownRenderer.tsx:108` (extract edit markers)
- Modify: locale files
- Test: `gitnexus-web/test/unit/nexus-edit-proposal.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `gitnexus-web/test/unit/nexus-edit-proposal.test.tsx`:

```tsx
import { describe, expect, it, beforeEach } from 'vitest';
import { editProposals, registerProposal, applyProposal } from '../../src/core/llm/edit-tools';
import { extractNexusEditMarkers } from '../../src/lib/nexus-edit-marker';

describe('nexus edit proposals', () => {
  beforeEach(() => editProposals.clear());

  it('extracts a marker and strips it from the rendered text', () => {
    const out = extractNexusEditMarkers('Here is a fix [[nexus-edit:abc123]] for you.');
    expect(out.ids).toEqual(['abc123']);
    expect(out.content).not.toContain('nexus-edit');
  });

  it('applies a single unique replacement', () => {
    const id = registerProposal({
      filePath: 'src/a.ts',
      rationale: 'use the helper',
      edits: [{ oldText: "['OPENROUTER_API_KEY']", newText: '[envBaseFor(id)]' }],
    });
    const result = applyProposal(id, "vendorEnv: ['OPENROUTER_API_KEY'],");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe('vendorEnv: [envBaseFor(id)],');
  });

  it('refuses when oldText is absent from the buffer', () => {
    const id = registerProposal({
      filePath: 'src/a.ts',
      rationale: 'x',
      edits: [{ oldText: 'not present', newText: 'y' }],
    });
    const result = applyProposal(id, 'different content');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no longer matches/i);
  });

  it('refuses when oldText occurs more than once', () => {
    const id = registerProposal({
      filePath: 'src/a.ts',
      rationale: 'x',
      edits: [{ oldText: 'dup', newText: 'y' }],
    });
    const result = applyProposal(id, 'dup and dup');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/more than once/i);
  });

  it('applies multiple edits in order', () => {
    const id = registerProposal({
      filePath: 'src/a.ts',
      rationale: 'two changes',
      edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: 'beta', newText: 'BETA' },
      ],
    });
    const result = applyProposal(id, 'alpha then beta');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe('ALPHA then BETA');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/nexus-edit-proposal.test.tsx`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement the proposal store and tool**

Create `gitnexus-web/src/core/llm/edit-tools.ts` exporting `editProposals` (a `Map`), `registerProposal(proposal): string`, `applyProposal(id, currentContent): { ok: true; content: string } | { ok: false; reason: string }`, and `createEditTools(deps)` returning the `propose_edit` tool.

`propose_edit` schema: `{ filePath: z.string(), rationale: z.string(), edits: z.array(z.object({ oldText: z.string(), newText: z.string() })).min(1).max(10) }`. The tool reads the current file, validates that each `oldText` occurs exactly once, registers the proposal, and returns `[[nexus-edit:<id>]]` plus a summary. When `deps.isEditingEnabled()` is false it returns `Editing is disabled for this repository. Ask the user to enable editing in the Code Inspector, then try again.` and registers nothing.

Create `gitnexus-web/src/lib/nexus-edit-marker.ts` mirroring `src/lib/runtime-action-marker.ts`, exporting `extractNexusEditMarkers(content): { content: string; ids: string[] }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/nexus-edit-proposal.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Implement NexusEditCard**

Create `gitnexus-web/src/components/NexusEditCard.tsx` modeled on `RuntimeActionCard.tsx`. It shows the file path, the rationale, and a unified diff rendered from the proposal's edits. `Apply to editor` opens the file in the Inspector, applies the proposal to the buffer via `applyProposal`, and marks it dirty without writing. `Reject` discards the proposal. When `applyProposal` fails, the card shows the reason and offers no apply action. When the proposal id is unknown, it renders the same "no longer available" treatment as `RuntimeActionCard.tsx:63-71`.

- [ ] **Step 6: Render the card**

In `gitnexus-web/src/components/MarkdownRenderer.tsx`, alongside `extractRuntimeActionMarkers` at line 108, extract edit markers and render a `NexusEditCard` per id below the message body.

- [ ] **Step 7: Register the tool**

Add `propose_edit` to the array returned by `createGraphRAGTools` when a controller and editing deps are supplied. It is already listed in `GRAPH_RAG_TOOL_NAMES` from Task 6.

- [ ] **Step 8: Add locale strings**

Add `editCard.title`, `editCard.apply`, `editCard.reject`, `editCard.applied`, `editCard.rejected`, `editCard.stale`, `editCard.unavailable` to both locale files.

- [ ] **Step 9: Run the suite**

Run: `cd gitnexus-web && npx tsc -b --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add gitnexus-web/src/core/llm/edit-tools.ts gitnexus-web/src/lib/nexus-edit-marker.ts gitnexus-web/src/components/NexusEditCard.tsx gitnexus-web/src/components/MarkdownRenderer.tsx gitnexus-web/src/core/llm/tools.ts gitnexus-web/src/locales gitnexus-web/test/unit/nexus-edit-proposal.test.tsx
git commit -m "feat(web): let Nexus propose confirmable code edits

propose_edit writes nothing. It validates that each oldText occurs
exactly once, registers a proposal, and emits a marker the chat renders
as a diff card. Applying stages the change in the editor as unsaved, so
three gates stand between a proposal and disk: the user asked, the user
confirmed the card, and the user saved. The tool refuses outright when
editing is disabled for the repository."
```

---

## Task 14: Re-index after save

**Files:**
- Modify: `gitnexus-web/src/components/CodeReferencesPanel.tsx` (call the hook on save)
- Modify: `gitnexus-web/src/hooks/useAppState.tsx` (expose `scheduleReindex`)
- Test: `gitnexus-web/test/unit/reindex-after-save.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createReindexScheduler } from '../../src/lib/reindex-scheduler';

describe('reindex scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses several saves into one analyze call', () => {
    const start = vi.fn();
    const schedule = createReindexScheduler(start, 2000);
    schedule('demo');
    schedule('demo');
    schedule('demo');
    vi.advanceTimersByTime(2100);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not fire before the debounce window elapses', () => {
    const start = vi.fn();
    const schedule = createReindexScheduler(start, 2000);
    schedule('demo');
    vi.advanceTimersByTime(1000);
    expect(start).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/reindex-after-save.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the scheduler**

Create `gitnexus-web/src/lib/reindex-scheduler.ts`:

```ts
export const createReindexScheduler = (
  start: (repo: string) => void,
  delayMs = 2000,
): ((repo: string) => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  return (repo: string) => {
    pending = repo;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (pending) start(pending);
      pending = null;
    }, delayMs);
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gitnexus-web && npx vitest run test/unit/reindex-after-save.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire it to save**

Expose `scheduleReindex` from `useAppState`, backed by the existing `startAnalyze` client call, and invoke it from the panel's `onSaved` callback. Show an indexing indicator in the Inspector header while the job runs so the user knows when graph-aware diagnostics are trustworthy again.

- [ ] **Step 6: Commit**

```bash
git add gitnexus-web/src/lib/reindex-scheduler.ts gitnexus-web/src/hooks/useAppState.tsx gitnexus-web/src/components/CodeReferencesPanel.tsx gitnexus-web/test/unit/reindex-after-save.test.ts
git commit -m "feat(web): re-index after a save so the graph stays honest

Debounced so a burst of saves triggers one analyze run. The Inspector
shows indexing state because graph-aware diagnostics are stale until it
finishes."
```

---

## Task 15: Documentation

**Files:**
- Create: `NEXUS-GRAPH-CONTROL.md`, `CODE-INSPECTOR.md`
- Modify: `ARCHITECTURE.md`, `README.md`, `gitnexus/CHANGELOG.md`
- Test: `gitnexus-web/test/unit/i18n.test.tsx` (verify parity passes)

- [ ] **Step 1: Write NEXUS-GRAPH-CONTROL.md**

Document, at the root: what changed and why (the citation click path was broken and the agent could not navigate); the nine tools with parameters and an example exchange; how target resolution handles each of the four target forms and what happens on ambiguity; the navigation policy including the one-camera-move-per-turn bound; the view history model and how restore behaves across a layout switch; and the six-renderable-edge-types caveat with the rule that hidden edges are never reported as nonexistent.

- [ ] **Step 2: Write CODE-INSPECTOR.md**

Document: enabling editing per repository and the server-side `--allow-file-writes` gate; what the save endpoint guarantees (containment, symlink rejection, existing files only, 2MB cap, sha conflict detection, atomic replace); all four diagnostic layers with their coverage limits, explicitly listing which languages have bundled tree-sitter grammars; the wording rule that unreferenced symbols are reported as having no resolvable references; the Nexus edit proposal flow and its three gates; and the re-index behavior after a save.

- [ ] **Step 3: Update ARCHITECTURE.md**

Add a section after the Runtime Intelligence paragraph at `ARCHITECTURE.md:490` covering the browser-side graph control surface (`GraphCanvasHandle` → `NexusGraphController` → tools) and the file write route, cross-linking both new documents.

- [ ] **Step 4: Update README.md**

Document the `--allow-file-writes` flag and its loopback default, and the per-repository editing toggle.

- [ ] **Step 5: Update CHANGELOG.md**

Add entries for the graph control tools, the Code Inspector editor, the write route, and the citation path fix.

- [ ] **Step 6: Verify locale parity**

Run: `cd gitnexus-web && npx vitest run test/unit/i18n.test.tsx`
Expected: PASS — every key added in Tasks 4, 10, 12, and 13 exists in both `en` and `zh-CN`.

- [ ] **Step 7: Commit**

```bash
git add NEXUS-GRAPH-CONTROL.md CODE-INSPECTOR.md ARCHITECTURE.md README.md gitnexus/CHANGELOG.md
git commit -m "docs: document Nexus graph control and Code Inspector editing"
```

---

## Task 16: Full verification

- [ ] **Step 1: Typecheck both packages**

Run: `cd gitnexus-web && npx tsc -b --noEmit` then `cd ../gitnexus && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint` from the repository root.
Expected: no new violations.

- [ ] **Step 3: Full test suites**

Run: `cd gitnexus-web && npx vitest run` then `cd ../gitnexus && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Build the web bundle**

Run: `cd gitnexus-web && npm run build`
Expected: success, with the tree-sitter grammars present in the output directory.

- [ ] **Step 5: Verify in the running app**

Start the dev server through the Browser pane preview tooling, not a shell command. Then confirm, capturing evidence for each:

1. Ask Nexus to find a piece of logic. The camera moves to the node, the node is selected, and the Inspector opens at the right lines without any click.
2. The navigation trail appears and `Back to previous view` returns the camera.
3. Ask about callers. Neighbors highlight and the reply explains the relationships.
4. Toggle `Enable editing`, modify a file, observe the dirty indicator, save, and confirm the change on disk.
5. Introduce a syntax error and confirm a tree-sitter diagnostic appears in the gutter.
6. Delete a symbol that has callers and confirm the graph-aware warning names the caller count.
7. Ask Nexus for a specific edit, confirm the diff card, apply, and confirm the change stages as unsaved rather than writing immediately.
8. Confirm Nexus does NOT propose an edit when merely asked to explain code.

- [ ] **Step 6: Run graph change analysis before the final commit**

Run: `node .gitnexus/run.cjs detect-changes --scope all --repo .`
Treat `partial: true` or `truncated: true` as not a clean check and re-run.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: verify Nexus graph control and Code Inspector editing"
```

---

## Self-Review Notes

**Spec coverage:** §2 → Task 1. §3 → Task 2. §4 → Tasks 3 and 5. §4.4 → Task 3 Step 6 and Task 5 Step 3. §5 → Task 6. §6 → Task 4 and Task 7 Step 4. §7.1-7.3 → Tasks 8, 9, 10. §7.4 → Tasks 11 and 12. §8 → Task 13. §9 → Task 7. §10 → tests in every task. §11 → Task 15. §7.3 re-index → Task 14.

**Type consistency:** `CameraState` and `NeighborEdge` are defined in Task 3 and consumed unchanged in Tasks 4 and 5. `HighlightChannel` is defined in Task 5 and used by `setHighlightChannel` in the same task. `ViewHistoryEntry` is defined in Task 4 and consumed in Task 4 Step 7. `shaOfContent` exists on both server (Task 8) and client (Task 9) and must produce identical SHA-256 hex for identical input; the client test asserts stability and the server test asserts round-trip agreement.

**Known intentional red state:** `agent-prompt.test.ts` fails between Task 6 and Task 7. This is called out in Task 6 Step 6 and resolved in Task 7.
