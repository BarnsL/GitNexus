# Runtime GUI Controls Design

**Date:** 2026-08-16
**Status:** Approved for implementation
**Scope:** GitNexus web UI, local server runtime process management, Nexus AI guidance, tests, and source-adjacent documentation

## 1. Goal

Make Runtime Intelligence usable without copying commands into a terminal. Remove the displayed upstream repository and sponsor promotions, move runtime activity into a bottom dock, keep Query immediately above that dock, and let Nexus AI explain and start supported tracing workflows through constrained GUI actions.

## 2. User experience

The graph remains the primary workspace. Runtime status, event counts, filtering, pause, clear, and table columns live in a bottom dock. The dock is compact when idle, expands to show events and controls, and never covers the footer. Query remains anchored directly above the dock so its location stays predictable as the dock changes height.

The Runtime Intelligence control opens a setup panel containing discovered applications. Each application shows a plain-language description, its working directory, how it will start, which tracers are available, and the evidence used to discover it. Supported controls are:

- Start app with tracing
- Start browser tracing when a browser-capable plan is available
- Stop a process that GitNexus started
- Refresh discovery
- View bounded process output and current state

Starting a trace requires an explicit button press. The UI shows starting, running, stopping, exited, and failed states. Errors explain what happened and the next safe action in ordinary language.

## 3. Promotion removal

Remove the displayed link to the upstream GitNexus repository from the header and help panel. Remove the sponsor button from the footer. Remove imports and translation keys that become unused. Repository links that describe the user's currently indexed repository remain because they are project data, not product promotion.

## 4. Runtime dock layout

Runtime Activity becomes one app-wide bottom dock rendered inside the exploring workspace. It is not duplicated between the application root and graph canvas.

The compact row contains connection state, active function count, event count, discovered app status, and expand or collapse control. The expanded dock adds filters, pause or resume, clear, managed process controls, the event headers, and the scrollable event list. The graph canvas reserves the dock's height so graph controls, the Query button, and nodes remain reachable.

Runtime Activity may remain selectable from the graph view tabs as a shortcut that expands and focuses the dock. It must not replace the graph canvas with a separate full-page table.

## 5. Managed execution boundary

The browser never sends free-form shell text to the server. It sends a registered repository identity, deterministic component ID, launch-plan ID, and trace-plan IDs that already exist in the server-owned Runtime Intelligence profile.

The server validates every request against the current profile and registered repository before spawning anything. It resolves the working directory inside the registered repository, uses argument arrays without a shell, rejects stale or unknown IDs, and never accepts a client-supplied executable, argument list, environment map, or working directory.

The process manager owns only processes it launched. It assigns an opaque run ID, keeps a bounded output buffer, reports lifecycle state, and permits stop operations only for that run ID in the same repository. Server shutdown attempts graceful termination of managed children. Existing user processes are never discovered, attached to, or terminated.

Browser tracing uses a server-owned browser launch plan. On Windows, the server may discover installed Chrome or Edge executables from known installation locations. It launches a dedicated Runtime Intelligence profile directory with a server-selected loopback debugging port and then starts the browser trace adapter. If no supported browser is found, the UI explains the missing prerequisite and offers no unsafe fallback.

## 6. Nexus AI behavior

Nexus AI receives current Runtime Intelligence capabilities and managed run state. Runtime answers default to layman-friendly guidance:

1. State the user's goal in plain language.
2. Explain each prerequisite and why it matters.
3. Describe what the user will see when the step succeeds.
4. Present a structured managed action when the server can perform the step.
5. Clearly separate supported actions from manual or unsupported work.

The AI may request only action IDs advertised by the server. The UI renders those requests as confirmable action cards. The AI cannot invent commands or silently execute an action. After execution, the result is returned to the conversation so the AI can explain the actual outcome instead of assuming success.

## 7. API and state model

Add local-server endpoints for runtime runs:

- List current managed runs for a registered repository.
- Start a run from server-owned component, launch, and trace plan IDs.
- Stop one managed run.
- Stream or poll bounded run state and output.

Mutating endpoints use the existing trusted-origin and authentication boundary. Request and response shapes live in `gitnexus-shared`. The web client uses the active backend URL and auth token, matching existing Runtime Intelligence requests.

## 8. Error handling

The server returns stable error codes for unknown repositories, stale profiles, invalid plan IDs, unavailable adapters, unsafe paths, spawn failures, and missing runs. User-facing copy translates those codes into a short explanation and a concrete next step. Raw command strings, secrets, and environment values are never included in errors or logs returned to the browser.

If the Runtime Intelligence profile cannot be loaded, the dock still receives runtime events and offers Refresh Discovery. If a managed process exits unexpectedly, its output remains available within the bounded buffer and the UI offers a restart using the same validated plan.

## 9. Accessibility and responsive behavior

Every icon-only control has an accessible name and tooltip. Dock expansion, run state, and errors are announced through appropriate ARIA state or live regions. Keyboard users can reach Query, dock controls, application cards, and confirmation actions in visual order. At narrow widths, counters wrap and the event table scrolls horizontally without obscuring process controls.

## 10. Testing and verification

Implementation follows test-first development.

- Component tests prove promotional links are absent, Runtime Activity is rendered once, the dock is bottom-anchored, Query is above it, and keyboard or accessible labels are present.
- Client tests prove the active backend URL and auth boundary are used.
- Server tests prove only server-owned plans can launch, paths cannot escape the repository, shell execution is absent, output is bounded, and one repository cannot stop another repository's run.
- Nexus AI tests prove runtime explanations contain purpose, prerequisites, success cues, and only validated managed action IDs.
- Existing web and server tests, TypeScript checks, formatting checks, and graph change analysis remain required.
- Browser verification covers removal of all three promotional surfaces, dock positioning, query positioning, expand and collapse behavior, starting a fixture trace, receiving events, stopping it, and viewing a layman-readable Nexus AI explanation with a confirmable action.

## 11. Documentation

Update `RUNTIME-INTELLIGENCE.md` with the GUI workflow, execution boundary, lifecycle, troubleshooting, and adapter limits. Update architecture and runbook material only where the new process manager changes a documented contract. Record the material project decision in the central Obsidian Vault using its schema, wikilinks, index, and log conventions.

## 12. Non-goals

- No arbitrary terminal or shell emulator.
- No silent AI execution.
- No attachment to or termination of processes GitNexus did not start.
- No Java, Go, Rust, OpenTelemetry, or production-browser tracing adapter added by this change.
- No unrelated visual redesign or graph-engine refactor.

## 13. Acceptance criteria

The feature is accepted when the app contains no displayed upstream GitNexus or sponsor promotion, the runtime controls live in a bottom dock with Query directly above it, a discovered Node or Python application can be started and stopped with tracing entirely through the GUI, supported browser tracing can be launched through the GUI when a supported browser exists, and Nexus AI explains and offers those actions in language a non-developer can follow. All actions must pass the managed execution boundary and the visible browser workflow must be verified against a live local backend.
