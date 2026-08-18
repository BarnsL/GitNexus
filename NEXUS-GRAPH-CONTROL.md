# Nexus Graph Control

Last reviewed: 2026-08-17

Nexus AI drives the knowledge graph directly. When it identifies the code behind your question, it moves the camera there, selects the node, opens the source, and highlights what that code touches — instead of naming a file and leaving you to find it.

## Why this exists

Before this change, Nexus could only emit citations. Citations highlighted nodes, but the camera never moved and the Code Inspector only opened if you clicked. Worse, that click was dead: `resolveFilePathForUI` in `RightPanel.tsx` was stubbed to return `null`, so every citation click returned early before reaching `addCodeReference`. Two further defects compounded it — AI citation cards hard-coded `content: null` so they never rendered source, and the selected-file highlight band was off by one line on every symbol.

All three are fixed. The navigation tools below are built on top of that repaired path.

## The tools

| Tool | What it does |
| --- | --- |
| `focus_node` | Flies the camera to a symbol, selects it, and opens its source in the Code Inspector. The primary "show me" action. |
| `show_neighbors` | Highlights what a symbol connects to and returns each relationship's type, direction, and hop depth, so Nexus can explain consequences rather than just lighting nodes up. |
| `highlight_nodes` | Lights up a set: `cyan` for relevance, `impact` for blast radius, `glow` for emphasis. Optionally animates. |
| `frame_nodes` | Fits the camera around several symbols at once — for showing a whole call chain rather than one link. |
| `set_view_mode` | Switches Force, Tree, Circles, or Runtime. |
| `set_filters` | Changes visible node labels, edge types, or hop depth. |
| `open_code` | Opens a file at a line range with no graph node required. Arguments are 1-based. |
| `graph_snapshot` | Reads current view mode, selection, filters, highlight counts, and whether editing is enabled. |
| `clear_visuals` | Resets highlights, filters, or both. |

These register only when a graph canvas is mounted. In chat-only mode (a repository too large to download the graph) the agent keeps its read-only tool set and reports that the graph view is unavailable rather than failing.

## Target resolution

Every tool accepts a loosely-specified target, resolved by `src/lib/target-resolution.ts` in this order:

1. **Exact node id** — `Function:src/providers.js:envBaseFor`
2. **Typed reference** — `Class:AuthService`, `File:providers.js`
3. **File path** — exact match, then the shortest suffix match
4. **Bare symbol name** — exact, then case-insensitive, then node-id suffix

Path matching is only attempted when the target looks like a path, so a bare symbol name never accidentally latches onto a similarly-named file.

**Ambiguity is reported, never guessed.** If `envBaseFor` exists in two files, the tool returns both candidates with their paths and navigates nowhere. Silently picking the first match is how an agent ends up confidently describing the wrong file.

## Navigation policy

Automatic navigation is useful only if it stays predictable. The system prompt binds Nexus to five rules:

1. When an answer has one clear subject, focus it. Making the user hunt for the node is the failure this feature exists to fix.
2. Change the camera destination **at most once per reply**. Use `frame_nodes` when several symbols matter equally.
3. Narrate what changed — a moved camera with no explanation is disorienting.
4. After `show_neighbors`, explain the relationships. Highlighting without explanation is an incomplete answer.
5. Never report a hidden relationship as nonexistent. See below.

## Rendered versus real relationships

Only six relationship types are drawable: `CONTAINS`, `DEFINES`, `IMPORTS`, `CALLS`, `EXTENDS`, `IMPLEMENTS`. (`HAS_METHOD` and `HAS_PROPERTY` are normalized onto `DEFINES` and `CONTAINS`.) The graph itself carries many more — `USES`, `ACCESSES`, `DECORATES`, `HANDLES_ROUTE`, `STEP_IN_PROCESS`, and others.

`show_neighbors` therefore splits its result into relationships currently drawn and relationships that are real but not drawn, and tells Nexus explicitly not to claim the latter do not exist. `normalizeEdgeType` and `isRelationshipRendered` in `src/lib/constants.ts` are shared by the neighbor walk and the edge renderer so both agree on what "drawn" means.

An empty neighbor result is likewise reported as possibly unresolvable rather than proof of no connections, matching the repository's standing rule that an empty caller set is not evidence a symbol is unused.

## Navigation trail

Because Nexus moves the view on its own initiative, every navigation is reversible. Before each move, a `ViewHistoryEntry` captures the camera position, the selected node, and the view mode. A trail appears above the graph with a **Back to previous view** control and breadcrumb chips for recent positions. It stays hidden until there is history, so ordinary manual exploration is unaffected. The stack is capped at 20 entries and clears when you switch repositories.

Restoring across a view-mode change reapplies the mode first and waits for the layout to settle before restoring the camera. This matters because switching layouts fires three independent camera resets (`GraphCanvas.tsx`, `useSigma.ts` `setGraph`, and the tree/circles physics settle handler) and recomputes every node coordinate.

## Architecture

```
Nexus (LangChain agent, in-browser)
  └─ graph-tools.ts        nine tool definitions, never throw
      └─ NexusGraphController      typed methods, resolve + report
          └─ GraphCanvasHandle     focusNode / frameNodes / camera / neighbors
              └─ useSigma          Sigma + graphology stay encapsulated here
```

The controller is built in `useAppState`, not `App`, because `initializeAgent` is also called internally by `sendChatMessage`, `switchRepo`, and `loadGraphAnyway`. `App` registers the canvas handle instead.

Tool bodies never throw. A UI failure is returned as text so the agent can reason about it; an exception would abort the whole turn.

Two bounds keep results readable: at most 100 targets per call, and at most 50 neighbors reported (with the true total stated when truncated).

## Legacy marker channel

The older `[HIGHLIGHT_NODES:…]` and `[IMPACT:…]` markers embedded in tool results still work — the `impact` tool emits them — and are parsed in `useAppState`. They now share `resolveTargets` with the navigation tools rather than carrying their own duplicated matcher. New capabilities use the controller.

## Related

- [CODE-INSPECTOR.md](CODE-INSPECTOR.md) — the editor Nexus opens
- [ARCHITECTURE.md](ARCHITECTURE.md) — where this sits in the system
- [RUNTIME-INTELLIGENCE.md](RUNTIME-INTELLIGENCE.md) — live execution overlay
