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

The profile can also be created lazily by its read endpoint. This supports repositories indexed before Runtime Intelligence was installed.

## HTTP API

| Method | Route                                        | Purpose                                                                                            |
| ------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/runtime-intelligence/profile?repo=...` | Load or lazily create a profile.                                                                   |
| `POST` | `/api/runtime-intelligence/profile/refresh`  | Re-run deterministic reconnaissance. Requires a trusted origin.                                    |
| `POST` | `/api/runtime-intelligence/profile/advisor`  | Validate and merge a browser-side AI decision. Requires a trusted origin and `expectedGeneration`. |

Advisor writes use optimistic concurrency. A response generated from an old profile generation receives HTTP 409 instead of overwriting newer reconnaissance.

## Safety boundary

- Provider credentials remain in the browser through the existing `createChatModel` path, including custom OpenAI-compatible base URLs.
- Advisor input is checked at the HTTP boundary for known component IDs, supported enums, bounded strings and collections, finite numbers, primitive tracer options, and a bounded safe subset of regular expressions.
- Runtime profiles use the existing atomic write helper and validate that their embedded repository path matches the profile location.
- Reconnaissance records evidence for inferred commands. It does not launch an application automatically.
- Profile generation is serialized per repository so refresh and advisor writes cannot race.

## Current adapter ceiling

The live execution layer currently supports Node V8 coverage, Python profiling, and optional browser CDP coverage. Java, Go, Rust, OpenTelemetry, observation learning, automatic workflow confirmation, graph-label rule matching, and animated edge packets remain explicit future adapters. The profile can describe these candidates without claiming they are active.

Use `gitnexus runtime -- <command>` for live execution. The existing graph path command remains `gitnexus trace <from> <to>`.
