# Nexus Graph Control and Code Editing Design

**Date:** 2026-08-17
**Status:** Approved for implementation
**Scope:** GitNexus web UI (graph control, Code Inspector), LLM agent tools and system prompt, server file-write API, tree-sitter browser pipeline, tests, and documentation

## 1. Goal

Nexus AI currently describes code but cannot act on the workspace. When it reports that logic lives in `providers.js:30-55`, the user must locate that node by hand. Two capabilities close the gap:

1. Nexus drives the graph directly. It moves the camera, selects and highlights the node it is discussing, surfaces the nodes that node touches, and explains those relationships in the same answer.
2. The Code Inspector becomes an editor. It supports editing with language-aware diagnostics and quick fixes, saves back to disk behind explicit opt-in, and accepts Nexus-proposed edits only when the user asks for them and confirms.

A prerequisite defect blocks both: the existing citation click path is dead code and must be repaired first.

## 2. Prerequisite defect

Three defects break the AI-to-Inspector path end to end today.

`resolveFilePathForUI` in `gitnexus-web/src/components/RightPanel.tsx:51-53` always returns `null`. Every `code-ref:` and `node-ref:` click therefore returns early at `RightPanel.tsx:87` and `RightPanel.tsx:141` without calling `addCodeReference`. A correct resolver already exists at `useAppState.tsx:428-440` and is not exported.

`refsWithSnippets` in `gitnexus-web/src/components/CodeReferencesPanel.tsx:183-195` hard-codes `content: null` for every AI reference, so the citation card highlighter at `CodeReferencesPanel.tsx:544-579` never renders and every card falls through to the "code not available" message.

The selected-file highlight band at `CodeReferencesPanel.tsx:406-422` compares an absolute `startLine` against a window-relative `lineNumber` while the gutter is offset by `startingLineNumber={fileStartLine + 1}`. For windowed symbol reads the band lands on the wrong lines.

All three are repaired as part of this change. `resolveFilePath` and `findFileNodeId` are promoted onto the `useAppState` public surface and the `RightPanel` stub is deleted.

## 3. Target resolution

Every new capability accepts a loose target and resolves it through one shared function, `resolveTarget`, exported from `gitnexus-web/src/lib/target-resolution.ts`. Three ad-hoc implementations are replaced by it: `Header.tsx:104-111`, `useAppState.tsx:923-925`, and the duplicated marker matcher at `useAppState.tsx:1038-1049` and `useAppState.tsx:1070-1081`.

Accepted target forms, resolved in priority order:

1. Exact node id, for example `Function:src/hooks/useSigma.ts:focusNode`.
2. Typed reference `Label:Name`, matched against `node.label` and `node.properties.name`.
3. Repository-relative file path, normalized by `normalizePath` and matched exactly, then by shortest suffix.
4. Bare symbol name, matched exactly against `properties.name`, then case-insensitively, then by suffix on the node id.

Node ids follow `Label:name` for `File` and `Folder` nodes and `Label:filePath:name` for symbols, per `generateId` in `gitnexus/src/lib/utils.ts:1-3`. Overload disambiguation suffixes (`~paramTypes`, `#arity`) are preserved when present.

`resolveTarget` returns a discriminated result: a unique match, an ambiguous match carrying up to ten candidates, or no match. Tools surface ambiguity back to the model as a list rather than silently choosing, so Nexus can ask the user or refine the target.

## 4. Graph control architecture

### 4.1 Transport

Graph control uses a typed controller, not string markers. `createGraphRAGTools(backend, ui)` gains a second parameter implementing `NexusGraphController`, defined in `gitnexus-web/src/core/llm/graph-controller.ts`. Tools invoke the controller directly and return a human-readable confirmation string to the model.

The existing `[HIGHLIGHT_NODES:...]` and `[IMPACT:...]` markers parsed at `useAppState.tsx:1028` and `useAppState.tsx:1060` remain supported for backward compatibility with the `impact` tool output, but no new capability uses them. The duplicated matching logic in both branches is replaced by `resolveTarget`.

The agent runs in the browser, so controller calls take effect during the streaming turn. Every controller method is synchronous or returns a promise that resolves once the visual change is committed, so ordering across multiple tool calls in one turn is deterministic.

### 4.2 Controller surface

`NexusGraphController` exposes the operations the tools need and nothing else. It is constructed in `useAppState` where the state setters live, and receives the `GraphCanvasHandle` ref for camera operations.

```
focusNode(nodeId, opts?: { zoom?: number; duration?: number; openCode?: boolean })
frameNodes(nodeIds, opts?: { padding?: number; duration?: number })
setHighlight(nodeIds, channel: 'ai-tool' | 'blast-radius' | 'query')
animate(nodeIds, type: 'pulse' | 'ripple' | 'glow', durationMs?)
setViewMode(mode)
setFilters({ nodeLabels?, edgeTypes?, depth? })
openCode({ filePath, startLine?, endLine? })
neighbors(nodeId, { depth, direction, edgeTypes })
snapshot()
clearVisuals()
pushViewHistory(label)
```

### 4.3 Required plumbing

`GraphCanvasHandle` at `GraphCanvas.tsx:34-36` currently exposes only `focusNode`. It is extended with `frameNodes`, `getCameraState`, `setCameraState`, and `getNeighbors`. The underlying camera and graphology access stay encapsulated inside `useSigma`; only these named operations cross the component boundary.

`focusNode` at `useSigma.ts:1506-1525` gains optional `zoom` and `duration` parameters, replacing the hardcoded `ratio: 0.15` and `duration: 400`. Its early return when the target is already selected is removed and replaced by a check that skips only the camera animation when the camera is already within a small epsilon of the target, so a repeated agent call still re-selects, re-opens the Inspector, and re-fires the highlight.

`frameNodes` is new. It computes the bounding box of the supplied nodes from their graphology coordinates and animates the camera to fit that box with padding, enabling "show me this whole call chain at once".

`getNeighbors` wraps the existing `getNodesWithinHops` at `graph-adapter.ts:528-552`, which today only works on the graphology graph that never escapes `useSigma`. It returns neighbor node ids together with the connecting relationship type and direction, which is what lets Nexus explain how a symbol acts on others rather than merely highlighting them.

The three AI highlight sets at `useAppState.tsx:295-299` currently have no public setters. `setHighlight` writes them through a single channel-keyed setter added to the app state value object.

### 4.4 Edge type coverage

The renderable `EdgeType` union in `src/lib/constants.ts:143-152` contains six members, while `RelationshipType` in `gitnexus-shared/src/graph/types.ts:107` contains substantially more. `useSigma.ts:593-605` hides anything outside the six, aside from the `HAS_METHOD` and `HAS_PROPERTY` normalization.

`neighbors` therefore reports two sets: relationships that are currently visible, and relationships that exist in the graph but are filtered out of the rendering. When Nexus reports a relationship in the second set it states that the edge is real but not currently drawn, and may call `set_filters` to reveal it. Tools never claim a relationship does not exist merely because it is not rendered.

## 5. Graph control tools

Nine navigation tools are added to `createGraphRAGTools`, joining the seven existing tools. A tenth new tool, `propose_edit`, is specified in section 8. All ten are registered in `GRAPH_RAG_TOOL_NAMES`, bringing that constant to seventeen entries; `agent-prompt.test.ts` enforces that the constant, each tool's `name`, and `BASE_SYSTEM_PROMPT` stay in sync.

| Tool | Parameters | Behavior |
|---|---|---|
| `focus_node` | `target`, `zoom?`, `openCode?` | Resolves the target, pushes view history, animates the camera, selects the node, and opens the Inspector at the symbol's line range unless `openCode` is false. Returns the resolved node id, label, file, and line range. |
| `show_neighbors` | `target`, `depth?` (1-3, default 1), `direction?` (`in`/`out`/`both`), `edgeTypes?` | Highlights the neighborhood and returns each neighbor with its relationship type, direction, and file. Reports filtered-out relationship types separately. |
| `highlight_nodes` | `targets[]`, `style?` (`cyan`/`impact`/`glow`), `animate?` | Sets the corresponding highlight channel and optionally triggers the matching animation. |
| `frame_nodes` | `targets[]`, `padding?` | Fits the camera to the bounding box of the set without changing selection. |
| `set_view_mode` | `mode` (`force`/`tree`/`circles`/`runtime`) | Switches layout. Pushes view history first, because layout switching resets the camera. |
| `set_filters` | `nodeLabels?`, `edgeTypes?`, `depth?` | Adjusts visibility filters. Reports what became visible or hidden. |
| `open_code` | `filePath`, `startLine?`, `endLine?` | Opens the Inspector at a location without requiring a graph node. |
| `graph_snapshot` | none | Returns current view mode, selected node, active filters, highlight counts, visible node count, and whether editing is enabled. Lets Nexus reason about what the user is actually looking at. |
| `clear_visuals` | `scope?` | Clears highlights, animations, and optionally filters. |

Tool results are bounded. `show_neighbors` returns at most 50 neighbors with a stated total; `highlight_nodes` and `frame_nodes` accept at most 100 targets. Exceeding a bound is reported in the result rather than silently truncated.

## 6. Auto-drive behavior and view history

Nexus navigates on its own initiative. The system prompt directs it to call `focus_node` once it identifies the primary subject of an answer, and `show_neighbors` when the answer concerns relationships, callers, or consequences. It narrates what the user is seeing rather than leaving the visual unexplained.

Navigation is bounded so a single answer does not become a slideshow. At most one `focus_node` call per assistant turn changes the camera destination; subsequent calls in the same turn update selection and highlight without re-animating unless the target differs. `frame_nodes` is preferred over repeated `focus_node` calls when several symbols matter equally.

Because navigation is automatic, it must be reversible. A `ViewHistory` stack is added to app state holding entries of camera position, camera ratio, selected node id, view mode, and active filters, each with a short label such as "Before focusing envBaseFor". Entries are pushed by `pushViewHistory` before any AI-driven navigation and capped at 20.

A `NavigationTrail` component renders above the graph controls: a `Back to previous view` control that pops one entry, and breadcrumb chips for the recent trail that jump directly to an earlier state. The trail is only visible when the stack is non-empty and clears when the repository changes.

This matters because layout switching currently fires three independent `animatedReset` calls (`GraphCanvas.tsx:175`, `useSigma.ts:1494`, and `useSigma.ts:342`/`:361`) and destroys the viewport. Restoring a history entry that carries a different view mode reapplies the mode first, waits for the layout to settle, then restores the camera.

## 7. Code Inspector editor

### 7.1 Editor choice and loading

CodeMirror 6 replaces the read-only `react-syntax-highlighter` viewer at `CodeReferencesPanel.tsx:394-426`. It is chosen over Monaco for bundle size and tree-shaking, and it provides the diagnostics gutter, autocompletion, and extensible linting the feature needs.

The editor and its language packs load through dynamic `import()` the first time the Inspector renders, so the graph application does not pay for the editor on initial load. Until it resolves, the existing highlighter renders the same content, so there is no blank state.

Three behaviors that `SyntaxHighlighter` currently provides for free are reimplemented explicitly:

- Line-number windowing equivalent to `startingLineNumber={fileStartLine + 1}` at `CodeReferencesPanel.tsx:398`.
- The cyan symbol highlight band from `lineProps` at `CodeReferencesPanel.tsx:406-422`, implemented as a CodeMirror line decoration, with the window-offset defect from section 2 corrected.
- The scroll-to-line contract at `CodeReferencesPanel.tsx:265-294`, which currently depends on `[data-line-number]` and `.linenumber` DOM selectors and a hard-coded `20.8` line height. It is replaced by CodeMirror's `EditorView.scrollIntoView` with a line position, removing the DOM coupling and the magic number.

### 7.2 Language mapping

`getSyntaxLanguageFromFilename` in `gitnexus-shared/src/language-detection.ts:160-170` returns Prism identifiers, which CodeMirror does not accept. A translation layer in `gitnexus-web/src/lib/editor-languages.ts` maps `SupportedLanguages` and the auxiliary extension map to CodeMirror language packs, using `@codemirror/legacy-modes` for languages without a first-class package. Files with no mapping open in plain text with editing still available.

The mapping is exhaustive over `SupportedLanguages` using a `satisfies Record<SupportedLanguages, ...>` constraint, matching the existing convention so adding a language to the enum is a compile error until the editor mapping is updated too.

### 7.3 Editing gate and save

Editing is off by default. A per-repository `editingEnabled` preference persists to `localStorage` under `gitnexus.editing.<repoIdentity>`. The Inspector header shows a `Read-only` badge with an `Enable editing` toggle. With editing off the buffer is not editable and no save affordance appears.

Saving is a new server route, `PUT /api/file`, in `gitnexus/src/server/api.ts`, adjacent to the existing `GET /api/file` at `api.ts:1337`. It carries every control the read route has plus the controls a mutation requires:

- `requireTrustedOrigin`, matching the pattern used by the other mutating routes at `api.ts:1005`, `:1513`, and `:1645`.
- A dedicated `createRouteLimiter` with a tighter limit than the read route.
- Path containment written inline at the sink using `path.resolve` followed by a `path.relative` check for a `..` prefix or absolute result, duplicating the idiom at `api.ts:604-610`. The comment at `api.ts:598-603` explains why the shared `assertSafePath` helper is insufficient for CodeQL; that constraint applies equally here.
- An `lstat` check rejecting symlinks at the resolved path, so a symlink inside the repository cannot redirect a write outside it.
- A request body size cap and a rejection of paths not already present in the repository, so the route can modify existing files but cannot create arbitrary new ones.
- `expectedSha`, a hash of the content the client last read. A mismatch returns 409 rather than overwriting a file changed on disk since it was opened.
- An atomic write: temporary file in the same directory followed by `rename`.

A server-level gate governs the route independently of the UI toggle, because a client-side preference is not a security boundary. The route is enabled by `--allow-file-writes` on `gitnexus serve`, or the `GITNEXUS_ALLOW_FILE_WRITES` environment variable, defaulting to enabled when the server is bound to a loopback address and disabled otherwise. When disabled the route returns 403 with an explanation, and `/api/info` advertises the current state so the UI can hide the editing toggle rather than offer an action that will fail.

The client gains `writeFile` in `gitnexus-web/src/services/backend-client.ts`. It keeps the default `maxAttempts = 1` for non-idempotent verbs from `backend-client.ts:441`; a save is never silently retried.

After a successful write the client triggers a debounced incremental re-index for the repository so the graph reflects the edited source. The Inspector shows an indexing indicator and the graph refreshes when the job completes.

### 7.4 Diagnostics

Four diagnostic sources feed one CodeMirror lint gutter. Each is independently toggleable in settings and each diagnostic is tagged with its source so the user knows what produced it.

**Tree-sitter syntax diagnostics** cover all languages the repository indexes. This requires new browser infrastructure: `web-tree-sitter` as a dependency, a `public/` directory in `gitnexus-web` (which does not exist today), and a Vite build step copying the `.wasm` grammars from the existing but unused `tree-sitter-wasms` devDependency at `gitnexus-web/package.json:74` into a served path. Grammars load lazily per language and are cached. Parsing runs in a Web Worker so a large file does not block the UI, and reports `ERROR` and `MISSING` nodes as diagnostics with their ranges. The stale `src/core/tree-sitter/**` coverage exclusion at `vitest.config.ts:36`, which points at a directory that no longer exists, is corrected to the real worker path.

The `tree-sitter-wasms` package covers a subset of the sixteen indexed languages. Languages without an available grammar simply produce no syntax diagnostics; the layer degrades silently rather than reporting false confidence, and the settings panel lists which languages have grammar coverage.

**CodeMirror language diagnostics** supply bracket matching, auto-indent, folding, and completion from the language packs, plus each pack's own linting where it exists.

**Graph-aware checks** are the capability unique to GitNexus. On a debounce after edits, the buffer's symbols are compared against the graph's symbols for that file. Removing or renaming a symbol that has callers raises a warning naming the caller count and the execution flows it participates in, resolved through the same graph data the `impact` tool uses. Symbols with no inbound references are reported as informational, explicitly worded as "no resolvable references" rather than "unused", because an empty caller set can also mean the callers are not resolvable by the index.

**On-demand AI review** is an explicit `Review file` button, never automatic, because it consumes tokens. It sends the buffer plus graph context for the file to the configured provider and returns suggestions as diagnostics carrying optional replacement text, applied through the same staging mechanism as section 8.

Diagnostics never block saving. They inform; the user decides.

## 8. Nexus code edits

`propose_edit` is added to the tool set. It writes nothing. It accepts a file path, an ordered list of `{ oldText, newText }` replacements with optional line anchors, and a rationale. It validates that each `oldText` occurs exactly once in the current file content, registers the proposal in a store keyed by a generated id, and returns the marker `[[nexus-edit:<id>]]` plus a summary.

The marker renders as a `NexusEditCard` in the chat transcript, following the structure of the existing `RuntimeActionCard` and extracted by a marker helper mirroring `src/lib/runtime-action-marker.ts`. The card shows the file, the rationale, and a unified diff, with `Apply to editor` and `Reject` controls.

`Apply to editor` opens the file in the Inspector, applies the replacements to the buffer, and marks it dirty. It does not write to disk. The user reviews the change in context and presses Save, which goes through the section 7.3 path including the `expectedSha` check. Three gates therefore stand between a proposal and a modified file: the user asked for an edit, the user confirmed the card, and the user saved.

Two constraints bound the tool. It returns an error instructing Nexus to ask the user to enable editing when the repository's editing toggle is off or the server has file writes disabled, so the capability cannot be exercised against a read-only workspace. The system prompt forbids proposing edits that the user did not request; Nexus explains what it would change and waits to be asked.

A proposal is invalidated when its `oldText` no longer matches the current buffer, and the card reports that the file changed rather than applying a stale patch.

## 9. System prompt changes

`BASE_SYSTEM_PROMPT` in `gitnexus-web/src/core/llm/agent.ts:72-230` is revised in three places.

The `What you CANNOT do (UI limitations)` block at `agent.ts:194-197` is deleted. It currently states that the agent cannot move the viewport or switch view mode, which becomes false.

A graph control section documents the nine tools, the auto-drive policy from section 6, the one-camera-move-per-turn bound, and the requirement to narrate what the user is seeing. It states explicitly that highlighting without explanation is incomplete: when Nexus shows neighbors it says how the focused symbol acts on them.

An editing section documents `propose_edit`, the prohibition on unrequested edits, and the confirmation flow.

The `VISUAL GROUNDING` section at `agent.ts:136-140`, which currently asserts "There is NO `highlight_in_graph` tool", is rewritten. Citations remain the lightweight grounding mechanism; the control tools are for deliberate navigation. Both are described so Nexus chooses correctly rather than calling a tool for every reference.

## 10. Testing

Unit tests cover `resolveTarget` across all four target forms plus ambiguity and miss cases; each new tool's argument validation, bounds, and error paths; `NexusGraphController` methods against a mocked canvas handle; view history push, pop, and cross-view-mode restore; the Prism-to-CodeMirror language mapping including exhaustiveness; the diff application and staleness detection in the edit proposal store; and the marker extraction helper.

Server tests extend the existing `gitnexus/test/unit/api-file-route.test.ts` pattern to the write route: traversal rejection, symlink rejection, absolute path rejection, missing-file rejection, oversize body rejection, `expectedSha` mismatch returning 409, trusted-origin enforcement, rate limiting, the disabled-by-configuration 403, and confirmation that the atomic write leaves no temporary file behind.

Component tests cover the repaired citation click path end to end, which has no coverage today, the read-only-to-editable transition, the dirty and save states, diagnostics rendering per source, and the edit card's apply and reject flows.

`agent-prompt.test.ts` is extended so the new tool names appear in `GRAPH_RAG_TOOL_NAMES`, in each tool definition, and in `BASE_SYSTEM_PROMPT`, and so the deleted limitation text does not reappear.

An i18n test asserts that the English and Chinese locale files carry matching key sets for the new strings.

## 11. Documentation

Product documentation lives at the repository root alongside `RUNTIME-INTELLIGENCE.md`, not under `docs/`, which `.gitignore:72` reserves for local planning output.

`NEXUS-GRAPH-CONTROL.md` is added at the repository root, describing the controller, the nine navigation tools, target resolution, the auto-drive policy, and the view history model.

`CODE-INSPECTOR.md` is added at the repository root, describing the editor, the editing gate, the save path and its guarantees, all four diagnostic layers with their coverage limits, and the Nexus edit proposal flow.

This design document and its implementation plan are force-added under `docs/superpowers/`, following the precedent set by the runtime GUI controls work whose spec and plan are tracked there despite the ignore rule.

`ARCHITECTURE.md` gains a section covering the browser-side graph control surface and the file write route, alongside the existing Runtime Intelligence description at `ARCHITECTURE.md:490`.

`README.md` documents the `--allow-file-writes` server flag and the per-repository editing toggle. `gitnexus/CHANGELOG.md` records the feature and the citation path fix.

Locale files `gitnexus-web/src/locales/en/*` and `gitnexus-web/src/locales/zh-CN/*` gain the editor, diagnostics, navigation trail, and edit card strings.

## 12. Risks and mitigations

Automatic camera movement can disorient a user who is reading the graph. The one-move-per-turn bound and the navigation trail with breadcrumb restore address this; the trail is not optional.

The wasm grammar pipeline adds meaningful bundle weight. Grammars load lazily per language and are never part of the initial payload; a language whose grammar is unavailable degrades to no syntax diagnostics rather than failing.

A write endpoint is the highest-risk element of this change. It is mitigated by the two independent gates, inline path containment at the sink, symlink rejection, restriction to existing files, optimistic concurrency, and atomic writes. The default-off behavior for non-loopback bindings means a server exposed on a network does not gain a write surface by upgrading.

Editing a file makes the index stale. The debounced incremental re-index after each successful write keeps the graph consistent, and the Inspector surfaces indexing state so the user knows when graph-aware diagnostics are trustworthy.

## 13. Out of scope

Multi-file refactoring driven by Nexus, git operations from the UI, a full language server for any language, conflict resolution beyond the `expectedSha` check, and collaborative or concurrent editing by multiple browser sessions.
