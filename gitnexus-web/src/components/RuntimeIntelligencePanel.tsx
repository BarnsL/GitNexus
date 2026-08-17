import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  RuntimeIntelligenceProfile,
  RuntimeManagedAction,
  RuntimeManagedRun,
  RuntimeManagedRunSnapshot,
} from 'gitnexus-shared';
import { getActiveProviderConfig } from '../core/llm/settings-service';
import { runRuntimeAdvisor } from '../core/runtime-intelligence/advisor';
import { useAppState } from '../hooks/useAppState';
import {
  fetchRuntimeIntelligenceProfile,
  fetchRuntimeManagedRuns,
  refreshRuntimeIntelligenceProfile,
  RuntimeIntelligenceRequestError,
  saveRuntimeAdvisorDecision,
  startRuntimeManagedRun,
  stopRuntimeManagedRun,
} from '../services/runtime-intelligence-client';

interface RuntimeIntelligencePanelProps {
  onProfileChange: (profile: RuntimeIntelligenceProfile | null) => void;
}

type Status = 'discovering' | 'thinking' | 'ready' | 'error';

const activeRun = (run: RuntimeManagedRun | undefined): boolean =>
  run?.state === 'starting' || run?.state === 'running' || run?.state === 'stopping';

const actionLabel = (action: RuntimeManagedAction): string =>
  action.kind === 'trace-browser' ? 'Start browser tracing' : 'Start with tracing';

export const RuntimeIntelligencePanel = ({ onProfileChange }: RuntimeIntelligencePanelProps) => {
  const { currentRepo, graph, serverBaseUrl } = useAppState();
  const [profile, setProfile] = useState<RuntimeIntelligenceProfile | null>(null);
  const [managed, setManaged] = useState<RuntimeManagedRunSnapshot | null>(null);
  const [status, setStatus] = useState<Status>('discovering');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [confirmActionId, setConfirmActionId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const reviewedGeneration = useRef<string | null>(null);

  const publish = useCallback(
    (next: RuntimeIntelligenceProfile | null): void => {
      setProfile(next);
      onProfileChange(next);
    },
    [onProfileChange],
  );

  const loadManaged = useCallback(async (): Promise<RuntimeManagedRunSnapshot | null> => {
    if (!currentRepo) return null;
    const snapshot = await fetchRuntimeManagedRuns(currentRepo, serverBaseUrl);
    setManaged(snapshot);
    return snapshot;
  }, [currentRepo, serverBaseUrl]);

  useEffect(() => {
    if (!currentRepo) return;
    let cancelled = false;
    reviewedGeneration.current = null;
    setStatus('discovering');
    setError(null);
    publish(null);
    Promise.all([
      fetchRuntimeIntelligenceProfile(currentRepo, serverBaseUrl),
      fetchRuntimeManagedRuns(currentRepo, serverBaseUrl),
    ])
      .then(([nextProfile, nextManaged]) => {
        if (cancelled) return;
        publish(nextProfile);
        setManaged(nextManaged);
        setStatus('ready');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setError(caught instanceof Error ? caught.message : 'Runtime discovery failed');
      });
    return () => {
      cancelled = true;
    };
  }, [currentRepo, publish, serverBaseUrl]);

  useEffect(() => {
    if (!currentRepo || !profile?.needsAiReview || !getActiveProviderConfig()) return;
    const reviewKey = `${currentRepo}:${profile.generation}`;
    if (reviewedGeneration.current === reviewKey) return;
    reviewedGeneration.current = reviewKey;
    let cancelled = false;
    setStatus('thinking');
    setError(null);

    runRuntimeAdvisor(profile, graph)
      .then((decision) =>
        saveRuntimeAdvisorDecision(currentRepo, profile.generation, decision, serverBaseUrl),
      )
      .then(async (next) => {
        if (cancelled) return;
        publish(next);
        await loadManaged();
        if (!cancelled) setStatus('ready');
      })
      .catch(async (caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof RuntimeIntelligenceRequestError && caught.status === 409) {
          try {
            const latest = await fetchRuntimeIntelligenceProfile(currentRepo, serverBaseUrl);
            if (!cancelled) publish(latest);
          } catch {
            // Preserve the usable heuristic profile below.
          }
        } else {
          console.warn('Runtime Intelligence AI review failed:', caught);
        }
        if (!cancelled) setStatus('ready');
      });

    return () => {
      cancelled = true;
    };
  }, [currentRepo, graph, loadManaged, profile, publish, serverBaseUrl]);

  const hasActiveRun = managed?.runs.some(activeRun) ?? false;
  useEffect(() => {
    if (!currentRepo || (!open && !hasActiveRun)) return;
    const timer = window.setInterval(() => {
      void loadManaged().catch(() => {
        // The next explicit action surfaces a detailed error; background polling stays quiet.
      });
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [currentRepo, hasActiveRun, loadManaged, open]);

  if (!currentRepo) return null;

  const refresh = async (): Promise<void> => {
    setStatus('discovering');
    setError(null);
    try {
      const next = await refreshRuntimeIntelligenceProfile(currentRepo, serverBaseUrl);
      reviewedGeneration.current = null;
      publish(next);
      await loadManaged();
      setStatus('ready');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : 'Runtime discovery failed');
    }
  };

  const start = async (action: RuntimeManagedAction): Promise<void> => {
    if (!managed) return;
    setBusyId(action.id);
    setError(null);
    try {
      const run = await startRuntimeManagedRun(
        {
          repo: currentRepo,
          expectedGeneration: managed.profileGeneration,
          actionId: action.id,
        },
        serverBaseUrl,
      );
      setManaged((prior) =>
        prior
          ? { ...prior, runs: [run, ...prior.runs.filter((item) => item.id !== run.id)] }
          : prior,
      );
      setConfirmActionId(null);
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : 'The managed app could not start.';
      setError(
        `${detail.replace(/[.]+$/, '')}. Review the app output or refresh discovery, then try again.`,
      );
    } finally {
      setBusyId(null);
    }
  };

  const stop = async (run: RuntimeManagedRun): Promise<void> => {
    setBusyId(run.id);
    setError(null);
    try {
      const next = await stopRuntimeManagedRun(run.id, { repo: currentRepo }, serverBaseUrl);
      setManaged((prior) =>
        prior
          ? { ...prior, runs: prior.runs.map((item) => (item.id === next.id ? next : item)) }
          : prior,
      );
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : 'The managed app could not stop.';
      setError(`${detail.replace(/[.]+$/, '')}. Refresh managed state and try again.`);
    } finally {
      setBusyId(null);
    }
  };

  const statusLabel =
    status === 'thinking'
      ? 'AI learning'
      : status === 'discovering'
        ? 'Discovering'
        : status === 'error'
          ? 'Discovery error'
          : profile?.source === 'heuristic+ai'
            ? 'AI model'
            : 'Heuristic model';

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="rounded-md border border-border-subtle bg-elevated px-2 py-1 text-[11px] text-text-secondary hover:bg-hover hover:text-text-primary"
      >
        {statusLabel} · {profile?.components.length ?? 0} app
        {(profile?.components.length ?? 0) === 1 ? '' : 's'}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Runtime Intelligence model"
          className="fixed top-20 left-1/2 z-[70] w-[min(760px,calc(100vw-24px))] -translate-x-1/2 rounded-xl border border-border-subtle bg-surface p-4 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Runtime Intelligence</h2>
              <p className="mt-1 max-w-[68ch] text-xs leading-5 text-text-muted">
                Start a detected app here. GitNexus uses only the saved launch plan shown below,
                watches what runs, and keeps the process under this panel&apos;s control.
              </p>
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={status === 'discovering' || status === 'thinking'}
                onClick={() => void refresh()}
                className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-hover disabled:opacity-50"
              >
                Refresh discovery
              </button>
              <button
                type="button"
                aria-label="Close Runtime Intelligence"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-hover"
              >
                Close
              </button>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs leading-5 text-red-300"
            >
              {error}
            </div>
          )}

          <div className="mt-3 max-h-[62vh] space-y-3 overflow-y-auto pr-1">
            {managed?.actions.map((action) => {
              const run = managed.runs.find((candidate) => candidate.actionId === action.id);
              const confirming = confirmActionId === action.id;
              return (
                <section
                  key={action.id}
                  aria-label={action.title}
                  className="rounded-lg border border-border-subtle bg-elevated p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium text-text-primary">{action.title}</h3>
                      <p className="mt-1 max-w-[68ch] text-xs leading-5 text-text-secondary">
                        {action.description}
                      </p>
                    </div>
                    {run && (
                      <span
                        aria-live="polite"
                        className="rounded-md bg-surface px-2 py-1 text-[11px] font-medium text-text-secondary"
                      >
                        {run.state}
                        {run.pid ? ` · PID ${run.pid}` : ''}
                      </span>
                    )}
                  </div>

                  <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
                    <div>
                      <div className="font-medium text-text-primary">What this does</div>
                      <p className="mt-1 leading-5 text-text-muted">
                        Starts the detected app and sends live function activity to the bottom dock.
                      </p>
                    </div>
                    <div>
                      <div className="font-medium text-text-primary">Before you start</div>
                      <p className="mt-1 leading-5 text-text-muted">
                        The app&apos;s runtime and dependencies must already be installed.
                      </p>
                    </div>
                    <div>
                      <div className="font-medium text-text-primary">Success looks like</div>
                      <p className="mt-1 leading-5 text-text-muted">
                        This card says running and new events appear when you use the app.
                      </p>
                    </div>
                  </div>

                  <dl className="mt-3 grid gap-1 rounded-md bg-surface px-3 py-2 text-[11px] sm:grid-cols-[120px_1fr]">
                    <dt className="text-text-muted">Detected folder</dt>
                    <dd className="font-mono text-text-secondary">{action.workingDirectory}</dd>
                    <dt className="text-text-muted">Launch plan</dt>
                    <dd className="font-mono text-text-secondary">{action.commandPreview}</dd>
                  </dl>

                  {!action.enabled && (
                    <p className="mt-3 text-xs leading-5 text-yellow-300">
                      Not available: {action.disabledReason}
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {run && activeRun(run) ? (
                      <button
                        type="button"
                        aria-label="Stop managed run"
                        disabled={busyId === run.id || run.state === 'stopping'}
                        onClick={() => void stop(run)}
                        className="rounded-md border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        {run.state === 'stopping' ? 'Stopping' : 'Stop'}
                      </button>
                    ) : confirming ? (
                      <>
                        <button
                          type="button"
                          aria-label="Confirm start"
                          disabled={busyId === action.id}
                          onClick={() => void start(action)}
                          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-50"
                        >
                          {busyId === action.id ? 'Starting' : 'Confirm start'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmActionId(null)}
                          className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-hover"
                        >
                          Cancel
                        </button>
                        <span className="text-[11px] text-text-muted">
                          GitNexus will own this process until you stop it or close the server.
                        </span>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={!action.enabled}
                        onClick={() => setConfirmActionId(action.id)}
                        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {actionLabel(action)}
                      </button>
                    )}
                  </div>

                  {run && run.output.length > 0 && (
                    <div className="mt-3" aria-label="Managed process output">
                      <div className="mb-1 text-[11px] font-medium text-text-secondary">
                        Latest app output
                      </div>
                      <pre className="max-h-28 overflow-auto rounded-md bg-deep p-2 text-[11px] leading-5 text-text-muted">
                        {run.output.map((entry) => `[${entry.stream}] ${entry.text}`).join('\n')}
                      </pre>
                    </div>
                  )}
                </section>
              );
            })}

            {managed && managed.actions.length === 0 && (
              <div className="rounded-lg bg-elevated p-3 text-xs leading-5 text-text-muted">
                No safe GUI launch plan was found. Refresh discovery after adding a standard npm
                script or Python entrypoint. GitNexus will not run an invented command.
              </div>
            )}
          </div>

          {profile && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3 text-[11px] text-text-muted">
              <span>
                generation {profile.generation} · {profile.visualizationRules.length} rules ·{' '}
                {profile.hypotheses.length} hypotheses
              </span>
              <span>{Math.round(profile.confidence * 100)}% discovery confidence</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
