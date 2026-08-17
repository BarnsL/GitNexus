import { useEffect, useState } from 'react';
import type {
  RuntimeManagedAction,
  RuntimeManagedRun,
  RuntimeManagedRunSnapshot,
} from 'gitnexus-shared';
import { useAppState } from '../hooks/useAppState';
import {
  fetchRuntimeManagedRuns,
  startRuntimeManagedRun,
  stopRuntimeManagedRun,
} from '../services/runtime-intelligence-client';

interface RuntimeActionCardProps {
  actionId: string;
}

const isActive = (run: RuntimeManagedRun | undefined): boolean =>
  run?.state === 'starting' || run?.state === 'running' || run?.state === 'stopping';

export const RuntimeActionCard = ({ actionId }: RuntimeActionCardProps) => {
  const { currentRepo, serverBaseUrl } = useAppState();
  const [snapshot, setSnapshot] = useState<RuntimeManagedRunSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!currentRepo) {
      setLoading(false);
      return;
    }
    fetchRuntimeManagedRuns(currentRepo, serverBaseUrl)
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error ? caught.message : 'Managed action state is unavailable.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actionId, currentRepo, serverBaseUrl]);

  if (loading) {
    return <div className="mt-3 text-xs text-text-muted">Checking this runtime action...</div>;
  }

  const action: RuntimeManagedAction | undefined = snapshot?.actions.find(
    (candidate) => candidate.id === actionId,
  );
  const run = snapshot?.runs.find((candidate) => candidate.actionId === actionId);

  if (!currentRepo || !snapshot || !action || !action.enabled) {
    return (
      <div className="mt-3 rounded-lg border border-yellow-500/25 bg-yellow-500/10 p-3 text-xs leading-5 text-yellow-200">
        This suggested action is no longer available. Open Runtime Intelligence and refresh
        discovery so Nexus can use the server&apos;s current launch plan.
        {error ? ` ${error}` : ''}
      </div>
    );
  }

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await startRuntimeManagedRun(
        {
          repo: currentRepo,
          expectedGeneration: snapshot.profileGeneration,
          actionId: action.id,
        },
        serverBaseUrl,
      );
      setSnapshot((prior) =>
        prior
          ? { ...prior, runs: [next, ...prior.runs.filter((item) => item.id !== next.id)] }
          : prior,
      );
      setConfirming(false);
    } catch (caught) {
      setError(
        `${caught instanceof Error ? caught.message : 'The app could not start.'} Refresh Runtime Intelligence, review the detected launch plan, and try again.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      const next = await stopRuntimeManagedRun(run.id, { repo: currentRepo }, serverBaseUrl);
      setSnapshot((prior) =>
        prior
          ? { ...prior, runs: prior.runs.map((item) => (item.id === next.id ? next : item)) }
          : prior,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The managed app could not stop.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={`Nexus action: ${action.title}`}
      className="mt-3 rounded-lg border border-cyan-400/25 bg-cyan-400/5 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-text-primary">{action.title}</div>
          <p className="mt-1 text-xs leading-5 text-text-secondary">{action.description}</p>
        </div>
        {run && (
          <span className="rounded bg-surface px-2 py-1 text-[11px] text-text-secondary">
            {run.state}
            {run.pid ? ` · PID ${run.pid}` : ''}
          </span>
        )}
      </div>

      <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <div className="font-medium text-text-primary">Before you start</div>
          <p className="mt-1 leading-5 text-text-muted">
            The detected runtime and project dependencies must already be installed.
          </p>
        </div>
        <div>
          <div className="font-medium text-text-primary">Success looks like</div>
          <p className="mt-1 leading-5 text-text-muted">
            This card says running and the bottom dock receives events while you use the app.
          </p>
        </div>
      </div>

      <div className="mt-3 rounded bg-surface px-3 py-2 font-mono text-[11px] text-text-secondary">
        {action.commandPreview}
      </div>

      {error && (
        <div role="alert" className="mt-3 text-xs leading-5 text-red-300">
          {error}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isActive(run) ? (
          <button
            type="button"
            disabled={busy || run?.state === 'stopping'}
            onClick={() => void stop()}
            className="rounded-md border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50"
          >
            {run?.state === 'stopping' ? 'Stopping' : 'Stop managed app'}
          </button>
        ) : confirming ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void start()}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-50"
            >
              {busy ? 'Starting' : 'Confirm and start'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <span className="text-[11px] text-text-muted">
              GitNexus owns this process until you stop it or close the server.
            </span>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim"
          >
            Prepare start
          </button>
        )}
      </div>

      {run && run.output.length > 0 && (
        <pre className="mt-3 max-h-28 overflow-auto rounded bg-deep p-2 text-[11px] leading-5 text-text-muted">
          {run.output.map((entry) => `[${entry.stream}] ${entry.text}`).join('\n')}
        </pre>
      )}
    </section>
  );
};
