import { useEffect, useRef, useState } from 'react';
import type { RuntimeIntelligenceProfile } from 'gitnexus-shared';
import { getActiveProviderConfig } from '../core/llm/settings-service';
import { runRuntimeAdvisor } from '../core/runtime-intelligence/advisor';
import { useAppState } from '../hooks/useAppState';
import {
  fetchRuntimeIntelligenceProfile,
  refreshRuntimeIntelligenceProfile,
  RuntimeIntelligenceRequestError,
  saveRuntimeAdvisorDecision,
} from '../services/runtime-intelligence-client';

interface RuntimeIntelligencePanelProps {
  onProfileChange: (profile: RuntimeIntelligenceProfile | null) => void;
}

type Status = 'discovering' | 'thinking' | 'ready' | 'error';

export const RuntimeIntelligencePanel = ({ onProfileChange }: RuntimeIntelligencePanelProps) => {
  const { currentRepo, graph, serverBaseUrl } = useAppState();
  const [profile, setProfile] = useState<RuntimeIntelligenceProfile | null>(null);
  const [status, setStatus] = useState<Status>('discovering');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const reviewedGeneration = useRef<string | null>(null);

  const publish = (next: RuntimeIntelligenceProfile | null): void => {
    setProfile(next);
    onProfileChange(next);
  };

  useEffect(() => {
    if (!currentRepo) return;
    let cancelled = false;
    reviewedGeneration.current = null;
    setStatus('discovering');
    setError(null);
    publish(null);
    fetchRuntimeIntelligenceProfile(currentRepo, serverBaseUrl)
      .then((next) => {
        if (cancelled) return;
        publish(next);
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
    // `onProfileChange` is stable in RuntimeActivityPanel. Including the local
    // publish function would make this refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRepo, onProfileChange, serverBaseUrl]);

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
      .then((next) => {
        if (cancelled) return;
        publish(next);
        setStatus('ready');
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
    // The graph is a snapshot input, not a reason to re-run the same profile generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRepo, profile?.generation, profile?.needsAiReview, serverBaseUrl]);

  if (!currentRepo) return null;

  const refresh = async (): Promise<void> => {
    setStatus('discovering');
    setError(null);
    try {
      const next = await refreshRuntimeIntelligenceProfile(currentRepo, serverBaseUrl);
      reviewedGeneration.current = null;
      publish(next);
      setStatus('ready');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : 'Runtime discovery failed');
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
          className="fixed top-20 left-1/2 z-[70] w-[min(680px,calc(100vw-24px))] -translate-x-1/2 rounded-xl border border-border-subtle bg-surface/98 p-4 shadow-2xl backdrop-blur"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Runtime Intelligence</h2>
              <p className="mt-1 text-xs text-text-muted">
                Repository-specific launch, tracing, and graph animation evidence.
              </p>
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={status === 'discovering' || status === 'thinking'}
                onClick={() => void refresh()}
                className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-hover disabled:opacity-50"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-hover"
              >
                Close
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <div className="mt-3 max-h-[55vh] space-y-2 overflow-y-auto">
            {profile?.components.map((component) => (
              <div
                key={component.id}
                className="rounded-lg border border-border-subtle bg-elevated p-3"
              >
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-medium text-text-primary">{component.name}</span>
                  <span className="text-text-muted">
                    {component.framework ?? component.kind} ·{' '}
                    {Math.round(component.confidence * 100)}%
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-text-muted">
                  launch: {component.launch[0]?.command ?? 'not resolved'}
                </div>
                <div className="truncate font-mono text-[11px] text-text-muted">
                  trace:{' '}
                  {component.trace
                    .filter((plan) => plan.enabled)
                    .map((plan) => plan.tracer)
                    .join(', ') || 'adapter not enabled'}
                </div>
              </div>
            ))}
            {profile && profile.components.length === 0 && (
              <div className="rounded-lg bg-elevated p-3 text-xs text-text-muted">
                No deterministic application component was found. The graph remains usable and AI
                review can add hypotheses, but it cannot invent a component ID.
              </div>
            )}
          </div>

          {profile && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3 text-[11px] text-text-muted">
              <span>
                generation {profile.generation} · {profile.visualizationRules.length} rules ·{' '}
                {profile.hypotheses.length} hypotheses
              </span>
              <span>{Math.round(profile.confidence * 100)}% overall confidence</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
