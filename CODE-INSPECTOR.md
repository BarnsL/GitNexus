# Code Inspector

Last reviewed: 2026-08-17

The Code Inspector is the panel that opens beside the graph when you select a node or click one of Nexus's citations. It is now an editor rather than a read-only viewer: it supports editing with language-aware assistance, graph-aware warnings, and saving back to disk behind two independent gates.

## Editing is off by default

Two separate gates must both be open before a keystroke can reach disk.

**Server gate.** `PUT /api/file` is disabled unless the server allows writes. The default is on for loopback-bound servers (`127.0.0.1`, `localhost`, `::1`) and off for anything else, so exposing GitNexus on a network never silently adds a write surface. Override in either direction:

```bash
GITNEXUS_ALLOW_FILE_WRITES=1 gitnexus serve
```

`/api/info` advertises the current policy, so the UI hides its editing toggle rather than offering an action that would fail with 403.

**UI gate.** Each repository has its own **Read-only / Editing** toggle in the Inspector header, persisted in `localStorage`. This is a convenience gate, not a security boundary — its job is to stop a stray keystroke modifying your working tree.

## Saving

The header shows a **Save** button only when the buffer differs from what was loaded. `Ctrl+S` / `Cmd+S` works while the editor has focus.

What the write route guarantees:

- **Containment** — the resolved path must sit inside the indexed repository. The check is written inline at the sink with the `path.resolve` + `path.relative` idiom, because CodeQL's path-traversal sanitizer does not follow cross-module helpers.
- **No symlinks** — `lstat` rejects anything that is not a regular file, so a symlink inside the repository cannot redirect a write outside it.
- **Existing files only** — the route modifies files that are already there; it cannot create new ones.
- **Size cap** — 2 MB.
- **No lost updates** — the client sends the SHA-256 of the content it read. If the file changed on disk since then, the save is refused with `409` and your working copy is left alone. Reload before saving.
- **Atomic replace** — content goes to a sibling temp file, then `rename`s over the target, so an interrupted write cannot leave a truncated source file.
- **Rate limited and origin guarded**, matching every other mutating route.

After a successful save the graph is stale until re-indexed. The Inspector surfaces indexing state so you know when graph-aware diagnostics are trustworthy again.

## The editor

CodeMirror 6, chosen over Monaco for bundle size. Language packs load through dynamic `import()` the first time a file of that type is opened, so grammars stay out of the initial payload.

Beyond editing you get bracket matching, auto-indent, code folding, multi-cursor, search, undo history, and completion from the language pack.

Line numbers show **absolute file lines** even when only a window around a symbol was fetched, and the selected symbol is banded in cyan. That band conversion is worth calling out: the previous viewer compared an absolute 1-based line number against a graph `startLine` it treated as 0-based, so the band sat one line low on every symbol. Ingestion emits `startPosition.row + 1`, making graph lines 1-based; the editor now converts explicitly and a test pins it using a windowed offset.

### Language coverage

All sixteen indexed languages map to an editor grammar via `src/lib/editor-languages.ts`. First-class CodeMirror packages cover JavaScript, TypeScript, Python, Java, C, C++, Go, Rust, PHP, and Vue; C#, Ruby, Kotlin, Swift, Dart, and COBOL use legacy stream modes, which give highlighting and indentation but not syntax-tree folding. JSON, YAML, Markdown, HTML, CSS, SQL, and shell files are also handled.

The mapping is exhaustive over `SupportedLanguages` via `satisfies`, matching the convention in `language-detection.ts`: adding a language to the enum is a compile error until the editor mapping is updated too. A file with no mapping opens as plain text with editing still available — never a broken editor.

## Diagnostics

Diagnostics appear in the lint gutter, each tagged with the source that produced it. **They never block saving.** They inform; you decide.

### Graph-aware checks

The layer unique to GitNexus. The editor knows what calls the symbol you are editing, from the same graph data as impact analysis.

- Removing or renaming a symbol that has callers raises a **warning** naming the caller count: *"envBaseFor no longer appears in this file but has 4 callers in the graph. Removing or renaming it breaks them."*
- A symbol with no inbound edges produces an **info** note worded *"has no resolvable references"* — deliberately not "unused". An empty caller set can equally mean the callers are not resolvable by the index (dynamic dispatch, plain-object property access, cross-language calls). Treating it as proof of deadness is exactly the mistake the repository's impact-analysis rules warn against.

Recomputed on a 400 ms debounce, so it does not run on every keystroke.

### Language diagnostics

Bracket matching, indentation, and whatever linting each CodeMirror language pack provides.

## Nexus-proposed edits

Nexus can propose changes, but **only when you ask it to**, and it never writes to disk.

The flow has three gates:

1. You explicitly request a change. The system prompt forbids proposing edits you did not ask for — if Nexus spots a problem unprompted it describes it and offers.
2. Nexus renders a diff card in chat with **Apply to editor** and **Reject**. Applying stages the change in the editor buffer as unsaved.
3. You review it in context and press **Save**.

If editing is disabled for the repository, the tool refuses outright and tells Nexus to ask you to enable it, rather than producing a proposal that could not be applied.

A proposal is invalidated if the text it targets no longer matches the buffer, so a stale patch is reported rather than misapplied.

## Related

- [NEXUS-GRAPH-CONTROL.md](NEXUS-GRAPH-CONTROL.md) — how Nexus opens the Inspector
- [ARCHITECTURE.md](ARCHITECTURE.md) — where this sits in the system
- [GUARDRAILS.md](GUARDRAILS.md) — repository scope boundaries
