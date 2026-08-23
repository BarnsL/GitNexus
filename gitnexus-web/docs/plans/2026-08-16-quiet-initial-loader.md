# Quiet Initial Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep GitNexus startup visually quiet until repository loading starts or a connection failure is confirmed.

**Architecture:** Keep the state classification inside `LoadingOverlay`, its sole visual consumer. The existing `PipelineProgress` phase and percentage already distinguish the initial validation range, active repository loading, and the error phase, so no shared contract change is needed.

**Tech Stack:** React, TypeScript, Vitest, React Testing Library, i18next.

## Global Constraints

- Preserve existing backend connection and onboarding-recovery behavior.
- Show translated failure text only after `phase === 'error'`.
- Keep initial validation accessible without exposing premature copy.
- Add behavior-focused tests before the implementation.

---

### Task 1: Cover loader visibility states

**Files:**
- Create: `gitnexus-web/test/unit/loading-overlay.test.tsx`
- Test: `gitnexus-web/test/unit/loading-overlay.test.tsx`

**Interfaces:**
- Consumes: `LoadingOverlay({ progress: PipelineProgress })`.
- Produces: regression coverage for initial validation, active graph loading, and confirmed error rendering.

- [x] **Step 1: Write failing tests**

```tsx
it('keeps initial server validation free of progress copy', () => {
  render(<LoadingOverlay progress={{ phase: 'extracting', percent: 0, message: 'Connecting...' }} />);
  expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
  expect(screen.queryByText('0%')).not.toBeInTheDocument();
});

it('shows progress after repository loading begins', () => {
  render(<LoadingOverlay progress={{ phase: 'extracting', percent: 50, message: 'Downloading graph...' }} />);
  expect(screen.getByText('Downloading graph...')).toBeInTheDocument();
  expect(screen.getByText('50%')).toBeInTheDocument();
});

it('shows confirmed connection errors without a zero-percent meter', () => {
  render(<LoadingOverlay progress={{ phase: 'error', percent: 0, message: 'Failed to connect to server' }} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Failed to connect to server');
  expect(screen.queryByText('0%')).not.toBeInTheDocument();
});
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `cd gitnexus-web && npx vitest run test/unit/loading-overlay.test.tsx`

Expected: FAIL because the current overlay always renders connection copy and `0%`.

### Task 2: Render only meaningful progress

**Files:**
- Modify: `gitnexus-web/src/components/LoadingOverlay.tsx:9-72`
- Modify: `gitnexus-web/docs/loading-overlay-states.md`
- Test: `gitnexus-web/test/unit/loading-overlay.test.tsx`

**Interfaces:**
- Consumes: the existing `PipelineProgress` object.
- Produces: a quiet initial state, a determinate active-progress state, and an accessible error state.

- [x] **Step 1: Classify the three display states**

```ts
const isError = progress.phase === 'error';
const hasVisibleProgress = !isError && progress.percent > 5;
const shouldShowStatus = isError || hasVisibleProgress;
```

- [x] **Step 2: Guard determinate progress UI and add live semantics**

Render the bar, statistics, and percentage only when `hasVisibleProgress`.
Render loading copy in a `role="status"` polite live region and failures in a
`role="alert"` region. Keep the animated orb in every state.

- [x] **Step 3: Document the contract**

Record the three states, the 0-to-5 validation threshold, and the fact that
backend connection behavior remains unchanged.

- [x] **Step 4: Run focused tests to verify they pass**

Run: `cd gitnexus-web && npx vitest run test/unit/loading-overlay.test.tsx`

Expected: PASS with all three state tests green.

### Task 3: Verify and push the finished work

**Files:**
- Verify: `gitnexus-web/src/components/LoadingOverlay.tsx`
- Verify: `gitnexus-web/test/unit/loading-overlay.test.tsx`

- [x] **Step 1: Run web validation**

Run: `cd gitnexus-web && npm test -- --run && npx tsc -b --noEmit && npm run build && npx eslint .`

Expected: all tests, typecheck, build, and lint complete without errors.

- [x] **Step 2: Run UI detector**

Run: `node "$HOME/.codex/skills/impeccable/scripts/detect.mjs" --json gitnexus-web/src/components/LoadingOverlay.tsx`

Expected: no unresolved detector finding caused by the change.

- [x] **Step 3: Analyze graph changes before committing**

Run: `node gitnexus/dist/cli/index.js detect-changes --scope all --repo .`

Expected: the diff maps to `LoadingOverlay`; review all reported impact before staging.

- [ ] **Step 4: Commit logical units and push the private branch**

Commit the existing provider-persistence files separately from the loader files,
then push `fix/stale-wal-recovery` to the `purple` remote. Do not stage
unrelated workspace artifacts.
