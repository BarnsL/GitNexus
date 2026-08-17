import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode, RuntimeIntelligenceProfile } from 'gitnexus-shared';
import { useAppState } from '../hooks/useAppState';
import { connectRuntimeActivity, type RuntimeActivityEvent } from '../services/runtime-client';
import { Pause, Play, Trash2, Terminal } from '@/lib/lucide-icons';
import { visualizationForRuntimeEvent } from '../core/runtime-intelligence/visualizer';
import { RuntimeIntelligencePanel } from './RuntimeIntelligencePanel';

const MAX_ROWS = 500;
const ACTIVE_WINDOW_MS = 2_000;

const normalizePath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

const normalizedNames = (value: string | undefined): Set<string> => {
  const out = new Set<string>();
  if (!value) return out;
  const raw = value.trim();
  if (!raw || raw === '<anonymous>') return out;
  out.add(raw);
  out.add(raw.replace(/^(get|set|async)\s+/, ''));
  const dot = raw.split('.').filter(Boolean).at(-1);
  if (dot) out.add(dot);
  return out;
};

/** Match a runtime execution event to the best static graph symbols. */
const symbolIdsForEvent = (nodes: readonly GraphNode[], event: RuntimeActivityEvent): string[] => {
  if (event.kind !== 'function' || !event.filePath) return [];
  const filePath = normalizePath(event.filePath);
  const names = normalizedNames(event.functionName);

  const scored: Array<{ id: string; score: number }> = [];
  for (const node of nodes) {
    if (!node?.properties?.filePath || node.label === 'File' || node.label === 'Folder') continue;
    const graphPath = normalizePath(String(node.properties.filePath));
    const fileMatch =
      graphPath === filePath ||
      graphPath.endsWith(`/${filePath}`) ||
      filePath.endsWith(`/${graphPath}`);
    if (!fileMatch) continue;

    let score = 2;
    const nodeName = String(node.properties.name ?? '');
    if (names.has(nodeName)) score += 8;
    if (event.line && node.properties.startLine) {
      const start = Number(node.properties.startLine);
      const end = Number(node.properties.endLine ?? start);
      if (event.line >= start && event.line <= end) score += 6;
      else score -= Math.min(4, Math.abs(event.line - start) / 50);
    }
    scored.push({ id: String(node.id), score });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  return scored
    .filter((row) => row.score >= Math.max(5, best - 2))
    .slice(0, 6)
    .map((row) => row.id);
};

const formatClock = (ts: number): string => {
  try {
    return new Date(ts).toLocaleTimeString([], { hour12: false });
  } catch {
    return '';
  }
};

const formatDuration = (value: number | undefined): string | null => {
  if (value === undefined || value <= 0) return null;
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 1000) return `${value.toFixed(1)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
};

const RUNTIME_COLORS: Record<string, string> = {
  node: 'text-green-400',
  browser: 'text-blue-400',
  python: 'text-yellow-400',
  custom: 'text-purple-400',
};

interface RuntimeActivityPanelProps {
  /** 'floating' = bottom-left overlay (default). 'fullpage' = fills the graph canvas area. */
  variant?: 'floating' | 'fullpage';
}

export const RuntimeActivityPanel = ({ variant = 'floating' }: RuntimeActivityPanelProps) => {
  const { viewMode, graph, currentRepo, serverBaseUrl, triggerNodeAnimation } = useAppState();
  const [events, setEvents] = useState<RuntimeActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState(true);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [runtimeProfile, setRuntimeProfile] = useState<RuntimeIntelligenceProfile | null>(null);
  const [activityClock, setActivityClock] = useState(() => Date.now());
  const graphRef = useRef(graph);
  const pausedRef = useRef(paused);
  const runtimeProfileRef = useRef(runtimeProfile);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    runtimeProfileRef.current = runtimeProfile;
  }, [runtimeProfile]);
  const handleProfileChange = useCallback((profile: RuntimeIntelligenceProfile | null) => {
    runtimeProfileRef.current = profile;
    setRuntimeProfile(profile);
  }, []);

  useEffect(() => {
    if (viewMode !== 'exploring' || !currentRepo) {
      setConnected(false);
      return;
    }

    return connectRuntimeActivity(
      currentRepo,
      {
        onOpen: () => setConnected(true),
        onDisconnect: () => setConnected(false),
        onError: () => setConnected(false),
        onEvent: (event) => {
          if (pausedRef.current) return;
          setEvents((prior) => [event, ...prior].slice(0, MAX_ROWS));

          const currentGraph = graphRef.current;
          if (currentGraph && event.kind === 'function') {
            const ids = symbolIdsForEvent(currentGraph.nodes, event);
            if (ids.length > 0) {
              const visualization = visualizationForRuntimeEvent(runtimeProfileRef.current, event);
              triggerNodeAnimation(ids, visualization.animation, visualization.durationMs);
            }
          }
        },
      },
      serverBaseUrl,
    );
  }, [viewMode, currentRepo, serverBaseUrl, triggerNodeAnimation]);

  useEffect(() => {
    setEvents([]);
  }, [currentRepo]);

  const hasEvents = events.length > 0;
  useEffect(() => {
    if (!hasEvents) return;
    const interval = window.setInterval(() => setActivityClock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasEvents]);

  const activeFunctions = useMemo(() => {
    const cutoff = activityClock - ACTIVE_WINDOW_MS;
    return new Set(
      events
        .filter((event) => event.kind === 'function' && event.ts >= cutoff)
        .map((event) => `${event.filePath ?? ''}:${event.functionName ?? ''}:${event.line ?? ''}`),
    ).size;
  }, [activityClock, events]);

  const runtimeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const event of events) {
      if (event.kind === 'function') {
        counts[event.runtime] = (counts[event.runtime] || 0) + (event.calls || 1);
      }
    }
    return counts;
  }, [events]);

  const filteredEvents = useMemo(() => {
    if (!filter.trim()) return events;
    const q = filter.toLowerCase();
    return events.filter(
      (event) =>
        event.functionName?.toLowerCase().includes(q) ||
        event.filePath?.toLowerCase().includes(q) ||
        event.runtime?.toLowerCase().includes(q) ||
        event.detail?.toLowerCase().includes(q),
    );
  }, [events, filter]);

  if (viewMode !== 'exploring' || !currentRepo) return null;

  // Floating variant (bottom-left overlay, used from App.tsx)
  if (variant === 'floating') {
    return (
      <div className="fixed bottom-12 left-3 z-40 flex max-w-[min(560px,calc(100vw-24px))] flex-col items-start gap-2">
        {open && (
          <div className="w-[min(560px,calc(100vw-24px))] overflow-hidden rounded-xl border border-border-subtle bg-surface/95 shadow-xl backdrop-blur">
            <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${connected ? 'bg-green-400' : 'bg-yellow-400'}`}
                />
                <span className="text-sm font-medium text-text-primary">Runtime activity</span>
                <span className="rounded-md bg-elevated px-2 py-0.5 text-xs text-text-muted">
                  {activeFunctions} active
                </span>
              </div>
              <div className="flex items-center gap-1">
                <RuntimeIntelligencePanel onProfileChange={handleProfileChange} />
                <button
                  type="button"
                  onClick={() => setPaused((value) => !value)}
                  className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
                >
                  {paused ? 'Resume' : 'Pause'}
                </button>
                <button
                  type="button"
                  onClick={() => setEvents([])}
                  className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
                >
                  Hide
                </button>
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto">
              {events.length === 0 ? (
                <div className="px-3 py-5 text-sm text-text-muted">
                  Waiting for a traced app. Run{' '}
                  <span className="font-mono">gitnexus runtime -- &lt;command&gt;</span>.
                </div>
              ) : (
                events.map((event) => {
                  const duration = formatDuration(event.durationMs);
                  return (
                    <div
                      key={`${event.seq}-${event.receivedAt}`}
                      className="grid grid-cols-[70px_54px_minmax(0,1fr)_auto] gap-2 border-b border-border-subtle/60 px-3 py-2 text-xs last:border-b-0"
                    >
                      <span className="font-mono text-text-muted">{formatClock(event.ts)}</span>
                      <span className="text-text-muted uppercase">{event.runtime}</span>
                      <div className="min-w-0">
                        {event.kind === 'function' ? (
                          <>
                            <div className="truncate font-mono text-text-primary">
                              {event.functionName || '<anonymous>'}
                            </div>
                            <div className="truncate text-text-muted">
                              {event.filePath || 'unknown'}
                              {event.line ? `:${event.line}` : ''}
                            </div>
                          </>
                        ) : (
                          <div className="truncate text-text-secondary">
                            {event.kind === 'process-start'
                              ? `process ${event.pid} started`
                              : event.kind === 'process-exit'
                                ? `process ${event.pid} exited`
                                : event.detail || event.kind}
                          </div>
                        )}
                      </div>
                      <div className="text-right text-text-muted">
                        {event.calls ? <div>×{event.calls}</div> : null}
                        {duration ? <div>{duration}</div> : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg border border-border-subtle bg-surface/95 px-3 py-2 text-sm text-text-secondary shadow-lg backdrop-blur hover:bg-hover hover:text-text-primary"
          >
            Runtime {connected ? '●' : '○'} {activeFunctions > 0 ? ` ${activeFunctions}` : ''}
          </button>
        )}
      </div>
    );
  }

  // Full-page variant (used as a tab in GraphCanvas)
  return (
    <div className="flex h-full w-full flex-col bg-deep">
      {/* Stats bar */}
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 rounded-full ${connected ? 'animate-pulse bg-green-400' : 'bg-yellow-500'}`}
            />
            <span className="text-sm font-semibold text-text-primary">
              {connected ? 'Live' : 'Waiting for trace'}
            </span>
          </div>
          <div className="h-4 w-px bg-border-subtle" />
          <span className="rounded-md bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-400">
            {activeFunctions} active
          </span>
          <span className="rounded-md bg-elevated px-2 py-0.5 text-xs text-text-muted">
            {events.length} events
          </span>
          {Object.entries(runtimeCounts).map(([rt, count]) => (
            <span
              key={rt}
              className={`rounded-md bg-elevated px-2 py-0.5 text-xs uppercase ${RUNTIME_COLORS[rt] || 'text-text-muted'}`}
            >
              {rt} ×{count}
            </span>
          ))}
          <RuntimeIntelligencePanel onProfileChange={handleProfileChange} />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Filter functions, files..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-48 rounded-md border border-border-subtle bg-elevated px-2.5 py-1 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent/60"
          />
          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
              paused
                ? 'bg-yellow-500/20 text-yellow-400'
                : 'text-text-secondary hover:bg-hover hover:text-text-primary'
            }`}
          >
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={() => setEvents([])}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </button>
        </div>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[80px_64px_64px_minmax(0,1fr)_minmax(0,1.5fr)_80px_80px] gap-2 border-b border-border-subtle bg-elevated/50 px-4 py-1.5 text-[10px] font-medium tracking-wider text-text-muted uppercase">
        <span>Time</span>
        <span>Runtime</span>
        <span>PID</span>
        <span>Function</span>
        <span>File</span>
        <span className="text-right">Calls</span>
        <span className="text-right">Duration</span>
      </div>

      {/* Event list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-20">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border-subtle bg-elevated">
              <Terminal className="h-8 w-8 text-text-muted" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-text-secondary">
                {filter ? 'No events match your filter' : 'Waiting for a traced application'}
              </p>
              {!filter && (
                <p className="mt-1.5 text-xs text-text-muted">
                  Run{' '}
                  <code className="rounded bg-elevated px-1.5 py-0.5 font-mono text-accent">
                    gitnexus runtime -- npm run dev
                  </code>{' '}
                  in another terminal to start tracing
                </p>
              )}
            </div>
          </div>
        ) : (
          filteredEvents.map((event) => {
            const duration = formatDuration(event.durationMs);
            const runtimeColor = RUNTIME_COLORS[event.runtime] || 'text-text-muted';
            return (
              <div
                key={`${event.seq}-${event.receivedAt}`}
                className="grid grid-cols-[80px_64px_64px_minmax(0,1fr)_minmax(0,1.5fr)_80px_80px] gap-2 border-b border-border-subtle/40 px-4 py-2 text-xs transition-colors hover:bg-hover/50"
              >
                <span className="font-mono text-text-muted">{formatClock(event.ts)}</span>
                <span className={`font-mono uppercase ${runtimeColor}`}>{event.runtime}</span>
                <span className="font-mono text-text-muted">{event.pid || ''}</span>
                <div className="min-w-0">
                  {event.kind === 'function' ? (
                    <span className="truncate font-mono text-text-primary">
                      {event.functionName || '<anonymous>'}
                    </span>
                  ) : (
                    <span className="truncate text-text-secondary">
                      {event.kind === 'process-start'
                        ? 'process started'
                        : event.kind === 'process-exit'
                          ? 'process exited'
                          : event.detail || event.kind}
                    </span>
                  )}
                </div>
                <div className="min-w-0 truncate font-mono text-text-muted">
                  {event.filePath || ''}
                  {event.line ? `:${event.line}` : ''}
                </div>
                <div className="text-right font-mono text-text-muted">
                  {event.calls ? `×${event.calls}` : ''}
                </div>
                <div className="text-right font-mono text-text-muted">{duration || ''}</div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
