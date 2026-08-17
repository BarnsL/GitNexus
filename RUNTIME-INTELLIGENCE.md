# Runtime Intelligence

Runtime Intelligence adds repository-specific application discovery and semantic runtime visualization to GitNexus. It keeps LadybugDB as the static graph, full-text search, and vector backend. Learned runtime metadata is stored separately as a small atomic JSON profile.

## Lifecycle

1. A successful server-side analysis publishes its healthy LadybugDB index through `backend.init()`.
2. The post-publish hook schedules deterministic reconnaissance. A collapsed or failed index does not run reconnaissance.
3. Reconnaissance detects root and direct-child Node packages, JavaScript package managers, common browser and server frameworks, Python markers, and starter Java, Go, and Rust markers.
4. The profile is atomically written to `<repo>/.gitnexus/runtime/profile.json`.
5. The web app loads the profile from the active server. If a Nexus AI provider is configured, the browser submits the profile and a bounded static graph sample to that provider.
6. The server validates the returned advisor decision and merges only permitted fields. Repository identity, schema version, observations, and deterministic evidence remain server-owned. AI rules and hypotheses receive `ai:` IDs, while launch, trace, and entrypoint deltas retain deterministic values and evidence.
7. Runtime Activity selects the highest-priority matching visualization rule for each execution event.
8. The server converts only deterministic launch evidence into opaque managed-action IDs. The browser can request one of those IDs, but it cannot submit an executable, arguments, environment variables, or a working directory.

The profile can also be created lazily by its read endpoint. This supports repositories indexed before Runtime Intelligence was installed.

## HTTP API

| Method | Route                                        | Purpose                                                                                            |
| ------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/runtime-intelligence/profile?repo=...` | Load or lazily create a profile.                                                                   |
| `POST` | `/api/runtime-intelligence/profile/refresh`  | Re-run deterministic reconnaissance. Requires a trusted origin.                                    |
| `POST` | `/api/runtime-intelligence/profile/advisor`  | Validate and merge a browser-side AI decision. Requires a trusted origin and `expectedGeneration`. |
| `GET`  | `/api/runtime-intelligence/runs?repo=...`    | List server-advertised actions and managed runs for the active repository.                         |
| `POST` | `/api/runtime-intelligence/runs`             | Start an advertised action by opaque ID and expected profile generation.                           |
| `POST` | `/api/runtime-intelligence/runs/:id/stop`    | Stop a process owned by this server for the active repository.                                     |

Advisor writes use optimistic concurrency. A response generated from an old profile generation receives HTTP 409 instead of overwriting newer reconnaissance.

## Safety boundary

- Provider credentials remain in the browser through the existing `createChatModel` path, including custom OpenAI-compatible base URLs.
- Advisor input is checked at the HTTP boundary for known component IDs, supported enums, bounded strings and collections, finite numbers, primitive tracer options, and a bounded safe subset of regular expressions.
- Runtime profiles use the existing atomic write helper and validate that their embedded repository path matches the profile location.
- Reconnaissance records evidence for inferred commands. It does not launch an application automatically.
- Profile generation is serialized per repository so refresh and advisor writes cannot race.
- Managed starts accept only a repository identity, profile generation, and server-advertised action ID. Client-supplied commands, paths, arguments, and environment variables are not accepted.
- Node GUI launches accept validated standard npm scripts with app launch roles (`dev`, `start`, or `worker`) and run npm through the current Node installation with `shell: false`. Test scripts are not advertised as app launches. Python GUI launches accept only detected Python entrypoints with bounded arguments. Unsupported runtimes stay visibly disabled.
- Browser tracing uses a loopback-only CDP port and a dedicated temporary browser profile. It refuses to start if the detected app port is already occupied, so the probe cannot silently attach to another app. The app, its Windows child-process tree, browser, and probe are stopped together if attachment fails, the user chooses Stop, or the GitNexus server shuts down.
- Output shown in the GUI is control-character sanitized, per-line bounded, and retained in a bounded ring.

## GUI workflow

The normal tracing workflow no longer requires the user to assemble terminal commands.

1. Open **Runtime Intelligence** in the compact bottom dock.
2. Review the detected app folder and launch plan. Each action explains what it does, what must already be installed, and what a successful start looks like.
3. Choose **Start with tracing** or **Start browser tracing**, then choose **Confirm start**. Nothing launches on the first click.
4. Use the traced application normally. The bottom dock changes from waiting to live as events arrive, and matching graph nodes pulse.
5. Expand the dock to filter events or inspect Time, Runtime, PID, Function, File, Calls, and Duration. The Query button remains directly above the dock.
6. Stop the process from the same action card. GitNexus also stops owned processes during server shutdown.

Nexus AI receives the current server-advertised actions in its codebase context. It explains the goal and prerequisites in plain language and may render a confirmation card only for an exact advertised action ID. A model response cannot start a process by itself, cannot invent a command, and cannot bypass the second confirmation click.

If no action is available, add a standard npm script or a detected Python entrypoint, choose **Refresh discovery**, and review the new plan. The CLI remains an advanced fallback:

```bash
gitnexus runtime -- npm run dev
gitnexus runtime -- python app.py
gitnexus runtime --browser-cdp http://127.0.0.1:9222 -- npm run dev
```

## Current adapter ceiling

The live execution layer currently supports Node V8 coverage, Python profiling, and browser CDP coverage. Managed GUI starts are intentionally narrower than the CLI: validated npm scripts for Node/browser apps and detected Python entrypoints. Java, Go, Rust, OpenTelemetry, observation learning, graph-label rule matching, and animated edge packets remain explicit future adapters. The profile can describe these candidates without claiming they are active.

Use `gitnexus runtime -- <command>` for live execution. The existing graph path command remains `gitnexus trace <from> <to>`.
