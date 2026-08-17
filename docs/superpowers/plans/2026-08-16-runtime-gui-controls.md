# Runtime GUI Controls Implementation Plan

> **For Codex:** Execute this plan task by task in the current isolated worktree. Follow strict red-green-refactor, run GitNexus impact before each symbol edit, and run `detect-changes` before each commit.

**Goal:** Make runtime tracing startable and stoppable from the GitNexus GUI, place Runtime Activity in one bottom dock with Query immediately above it, remove upstream promotion controls, and make Nexus AI give actionable explanations that a non-developer can follow.

**Architecture:** The browser receives server-generated managed actions and sends only repository, profile generation, and opaque action IDs. A server-owned process manager re-resolves each action from the current profile, validates the component root and deterministic launch plan, spawns without a shell, captures bounded output, and owns stop/dispose. Runtime Activity is rendered once by `AppContent`; the Runtime tab becomes an expand/focus shortcut instead of replacing the graph.

**Tech stack:** TypeScript, Node child processes, Express, React, Vitest, Testing Library, Tailwind CSS, SSE runtime relay.

---

## Task 1: Shared managed-run contract

**Files:**
- Modify: `gitnexus-shared/src/runtime-intelligence.ts`
- Modify: `gitnexus-shared/src/index.ts`

1. Add `RuntimeManagedAction`, `RuntimeManagedRun`, lifecycle state, output-entry, start-request, and stop-request types.
2. Make actions opaque: the response may include a human-readable command preview, but start requests contain no executable, argv, environment, or working directory.
3. Export all new types from the shared package.
4. Run `npm run build` in `gitnexus-shared`.

## Task 2: Server-owned managed process lifecycle

**Files:**
- Create: `gitnexus/src/runtime-intelligence/managed-process-manager.ts`
- Create: `gitnexus/test/unit/runtime-managed-process.test.ts`
- Modify: `gitnexus/src/cli/browser-runtime.ts`

1. Write failing tests for action generation, stale and unknown action rejection, repository-root containment, shell-free spawning, bounded output, cross-repository stop rejection, and dispose cleanup.
2. Implement `ManagedRuntimeProcessManager` with injected spawn/browser dependencies so tests exercise validation and lifecycle without starting external programs.
3. Generate actions only from deterministic Node or Python launch plans in the current profile. Accept only generated package-manager script commands and Python entrypoints. AI-only or unsupported launch text stays visible as evidence but never becomes executable.
4. On Windows, resolve npm to its JavaScript CLI and launch it with `process.execPath`; never invoke a command shell. Resolve Python as a direct executable.
5. Build tracing environment variables using the existing Node and Python probes. Capture stdout/stderr into a fixed-size, sanitized ring buffer.
6. For browser-capable components, discover Chrome or Edge from known install locations, reserve a loopback debugging port, launch a dedicated profile, attach the existing CDP probe, and keep the browser child under the same run owner.
7. Stop only owned children; dispose all owned children and probes during server shutdown.
8. Run the new unit test and `npx tsc --noEmit` in `gitnexus`.

## Task 3: Managed-run HTTP API

**Files:**
- Modify: `gitnexus/src/server/runtime-intelligence-api.ts`
- Modify: `gitnexus/src/server/api.ts`
- Modify: `gitnexus/test/unit/runtime-intelligence-api.test.ts`

1. Write failing route tests for list actions/runs, trusted-origin start/stop, invalid repository, stale generation, unknown action, and cross-repository stop.
2. Extend the mount function with the process manager.
3. Add `GET /api/runtime-intelligence/runs`, `POST /api/runtime-intelligence/runs`, and `POST /api/runtime-intelligence/runs/:runId/stop`.
4. Return stable safe error codes and user-safe messages; never return raw environment data.
5. Instantiate one manager in `createServer`, mount it beside Runtime Intelligence, and dispose it in graceful shutdown.
6. Run the route tests and server typecheck.

## Task 4: Web client and managed controls

**Files:**
- Modify: `gitnexus-web/src/services/runtime-intelligence-client.ts`
- Modify: `gitnexus-web/src/components/RuntimeIntelligencePanel.tsx`
- Modify: `gitnexus-web/test/unit/runtime-intelligence-client.test.ts`
- Create: `gitnexus-web/test/unit/runtime-intelligence-controls.test.tsx`

1. Write failing client tests proving active backend URL, bearer token, and opaque request bodies for list/start/stop.
2. Implement typed list/start/stop client calls through the existing backend/auth helpers.
3. Write failing component tests for plain-language prerequisites, start confirmation, lifecycle state, bounded output, stop, refresh, accessible names, and safe error recovery.
4. Replace command-only cards with plain-language app cards and server-advertised actions. Require a confirmation step before start.
5. Poll managed state only while the panel is open or a run is non-terminal.
6. Run the focused web tests and web typecheck.

## Task 5: One bottom Runtime Activity dock and Query placement

**Files:**
- Modify: `gitnexus-web/src/App.tsx`
- Modify: `gitnexus-web/src/components/GraphCanvas.tsx`
- Modify: `gitnexus-web/src/components/RuntimeActivityPanel.tsx`
- Modify: `gitnexus-web/src/components/QueryFAB.tsx`
- Modify: `gitnexus-web/test/unit/runtime-activity-intelligence.test.tsx`
- Modify: `gitnexus-web/test/unit/runtime-graph-controls.test.tsx`
- Create: `gitnexus-web/test/unit/runtime-dock-layout.test.tsx`

1. Write failing tests proving Runtime Activity renders once, is bottom-anchored, has a compact and expanded state, preserves the complete event header set, and exposes accessible expand/collapse controls.
2. Write a failing graph test proving the Runtime tab expands the dock without covering/replacing the graph.
3. Render the dock once inside the exploring page between the main workspace and status footer.
4. Convert the two variants into one dock. Keep connection, active count, event count, discovery status, filter, pause/resume, clear, process controls, headers, and rows.
5. Make `graphViewMode === 'runtime'` an expansion request; preserve the current graph layout mode when entering/leaving the shortcut.
6. Introduce a CSS custom property for dock height. Position Query and graph controls above it, including when expanded, without arbitrary duplicate offsets.
7. Verify narrow widths use wrapping controls and horizontal table scrolling while DOM focus order matches visual order.
8. Run focused component tests and web typecheck.

## Task 6: Remove upstream promotion surfaces

**Files:**
- Modify: `gitnexus-web/src/components/Header.tsx`
- Modify: `gitnexus-web/src/components/StatusBar.tsx`
- Modify: `gitnexus-web/src/components/HelpPanel.tsx`
- Modify: affected locale JSON files
- Modify: `gitnexus-web/test/unit/header.test.tsx`
- Create or modify: promotion surface component test

1. Write failing rendered tests showing the upstream repository and sponsor URLs are absent while current-repository data links remain untouched.
2. Remove the header star control, footer sponsor control, help-panel upstream link, dead icon imports, and now-unused translation keys in every locale.
3. Run focused tests and lint the changed files.

## Task 7: Layman-first Nexus AI runtime actions

**Files:**
- Modify: `gitnexus-web/src/core/llm/agent.ts`
- Modify: `gitnexus-web/src/core/llm/context-builder.ts`
- Modify: `gitnexus-web/src/hooks/useAppState.tsx`
- Modify: the chat message/action renderer selected by source inspection
- Modify: `gitnexus-web/test/unit/agent-prompt.test.ts`
- Add focused action-rendering tests

1. Write failing prompt tests requiring goal, prerequisite reason, success cue, next safe action, and a prohibition on claiming unsupported execution.
2. Add current server-advertised Runtime Intelligence actions and run state to the dynamic context using opaque IDs only.
3. Add a structured managed-action request format to the prompt and parser. Render it as a confirmation card rather than executing text from the model.
4. Execute only IDs still advertised by the server, return the real result to the conversation, and show manual guidance for unsupported actions.
5. Replace the outdated terminal-first Runtime Activity layout description with the GUI-first dock workflow and detailed fallback guidance.
6. Run prompt, parser, renderer, and agent tests.

## Task 8: Documentation and durable project record

**Files:**
- Modify: `RUNTIME-INTELLIGENCE.md`
- Modify: `ARCHITECTURE.md` or the existing runtime architecture document only where contracts changed
- Modify: the applicable runbook
- Modify: central Obsidian project/source/log notes according to the vault schema

1. Document the GUI start/stop workflow for a layperson, including what each step does, what success looks like, and safe recovery.
2. Document the managed execution boundary, supported Node/Python/browser adapters, dedicated browser profile, bounded output, and unsupported runtime behavior.
3. Record milestone/tag/worktree strategy and rollback instructions in source-adjacent project notes.
4. Update the Obsidian project record, index, and log using wikilinks and current frontmatter conventions.

## Task 9: Full validation and milestone-safe delivery

1. Run all focused red-green tests after refactors.
2. Run `npm test`, `npx tsc -b --noEmit`, and changed-file lint in `gitnexus-web`.
3. Run `npm test`, `npx tsc --noEmit`, and changed-file lint in `gitnexus`.
4. Run `git diff --check` and the Impeccable mechanical detector once over changed UI targets.
5. Stage the intended files, run `detect-changes --scope staged --repo GitNexus`, and rerun if partial or truncated.
6. Start the isolated backend and frontend on unused loopback ports. In a real browser verify promotion removal, bottom dock and Query placement, dock expansion, fixture start/event/stop/output, and a Nexus AI layman explanation with a confirmable action.
7. Commit only after all required checks pass. Do not push without explicit user authorization.

## Rollback anchors

- Milestone commit: `6f304340`
- Annotated tag: `milestone/runtime-intelligence-2026-08-16`
- Milestone branch: `codex/runtime-intelligence-milestone-2026-08-16`
- Feature branch: `codex/runtime-gui-controls`

The original checkout remains on the milestone branch. All implementation work occurs in `D:\projects\GitNexus-runtime-gui`.
