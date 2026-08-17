import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode, RuntimeIntelligenceProfile } from 'gitnexus-shared';
import { useAppState } from '../hooks/useAppState';
import { connectRuntimeActivity, type RuntimeActivityEvent } from '../services/runtime-client';
import { ChevronDown, ChevronUp, Pause, Play, Trash2, Terminal } from '@/lib/lucide-icons';
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

const symbolIdsForEvent = (nodes: readonly GraphNode[], event: RuntimeActivityEvent): string[] => {
  if (event.kind !== 'function' || !event.filePath) return [];
  const filePath = normalizePath(event.filePath);
  const names = normalizedNames(event.functionName);
  const scored: Array<{ id: string; score: number }> = [];
  for (const node of nodes) {
    if (!node?.properties?.filePath || node.label === 'File' || node.label === 'Folder') continue;
    const graphPath = normalizePath(String(node.properties.filePath));
    if (
      graphPath !== filePath &&
      !graphPath.endsWith(`/${filePath}`) &&
      !filePath.endsWith(`/${graphPath}`)
    ) {
      continue;
    }
    let score = 2;
    if (names.has(String(node.properties.name ?? ''))) score += 8;
    if (event.line && node.properties.startLine) {
      const start = Number(node.properties.startLine);
      const end = Number(node.properties.endLine ?? start);
      if (event.line >= start && event.line <= end) score += 6;
      else score -= Math.min(4, Math.abs(event.line - start) / 50);
    }
    scored.push({ id: String(node.id), score });
  }
  scored.sort((left, right) => right.score - left.score);
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
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export const RuntimeActivityPanel = ({ expanded, onExpandedChange }: RuntimeActivityPanelProps) => {
  const { viewMode, graph, currentRepo, serverBaseUrl, triggerNodeAnimation } = useAppState();
  const [events, setEvents] = useState<RuntimeActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState(expanded ?? false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [runtimeProfile, setRuntimeProfile] = useState<RuntimeIntelligenceProfile | null>(null);
  const [activityClock, setActivityClock] = useState(() => Date.now());
  const graphRef = useRef(graph);
  const pausedRef = useRef(paused);
  const runtimeProfileRef = useRef(runtimeProfile);

  useEffect(() => {
    if (expanded !== undefined) setOpen(expanded);
  }, [expanded]);
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

  useEffect(() => setEvents([]), [currentRepo]);
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
      if (event.kind === 'function') counts[event.runtime] = (counts[event.runtime] || 0) + 1;
    }
    return counts;
  }, [events]);

  const filteredEvents = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return events;
    return events.filter(
      (event) =>
        event.functionName?.toLowerCase().includes(query) ||
        event.filePath?.toLowerCase().includes(query) ||
        event.runtime?.toLowerCase().includes(query) ||
        event.detail?.toLowerCase().includes(query),
    );
  }, [events, filter]);

  if (viewMode !== 'exploring' || !currentRepo) return null;

  const setExpanded = (next: boolean): void => {
    setOpen(next);
    onExpandedChange?.(next);
  };

  return (
    <section
      data-testid="runtime-activity-dock"
      data-state={open ? 'expanded' : 'compact'}
      aria-label="Runtime Activity dock"
      className="flex-none border-t border-border-subtle bg-deep text-text-secondary"
    >
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-green-400' : 'bg-yellow-500'}`}
            aria-hidden="true"
          />
          <span className="text-sm font-semibold text-text-primary">
            {connected ? 'Live trace' : 'Waiting for trace'}
          </span>
          <span className="rounded-md bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-400">
            {activeFunctions} active
          </span>
          <span className="rounded-md bg-elevated px-2 py-0.5 text-xs text-text-muted">
            {events.length} events
          </span>
          {Object.entries(runtimeCounts).map(([runtime, count]) => (
            <span
              key={runtime}
              className={`rounded-md bg-elevated px-2 py-0.5 text-xs uppercase ${RUNTIME_COLORS[runtime] ?? 'text-text-muted'}`}
            >
              {runtime} ×{count}
            </span>
          ))}
          <RuntimeIntelligencePanel onProfileChange={handleProfileChange} />
        </div>

        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Collapse Runtime Activity' : 'Expand Runtime Activity'}
          onClick={() => setExpanded(!open)}
          className="flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-text-secondary hover:bg-hover hover:text-text-primary"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          {open ? 'Collapse' : 'Open activity'}
        </button>
      </div>

      {open && (
        <div className="border-t border-border-subtle" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <input
              type="search"
              aria-label="Filter runtime functions and files"
              placeholder="Filter functions, files..."
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="min-w-48 flex-1 rounded-md border border-border-subtle bg-elevated px-2.5 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent/60"
            />
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPaused((value) => !value)}
                className={`flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ${
                  paused
                    ? 'bg-yellow-500/20 text-yellow-400'
                    : 'text-text-secondary hover:bg-hover hover:text-text-primary'
                }`}
              >
                {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                {paused ? 'Resume' : 'Pause'}
              </button>
              <button
                type="button"
                onClick={() => setEvents([])}
                className="flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[760px]">
              <div className="grid grid-cols-[80px_64px_64px_minmax(160px,1fr)_minmax(220px,1.5fr)_80px_80px] gap-2 border-y border-border-subtle bg-elevated/50 px-4 py-1.5 text-[10px] font-medium tracking-wider text-text-muted uppercase">
                <span>Time</span>
                <span>Runtime</span>
                <span>PID</span>
                <span>Function</span>
                <span>File</span>
                <span className="text-right">Calls</span>
                <span className="text-right">Duration</span>
              </div>

              <div className="max-h-60 overflow-y-auto">
                {filteredEvents.length === 0 ? (
                  <div className="flex items-center justify-center gap-3 px-6 py-8 text-center">
                    <Terminal className="h-6 w-6 text-text-muted" />
                    <div>
                      <p className="text-sm font-medium text-text-secondary">
                        {filter
                          ? 'No events match your filter'
                          : 'Waiting for a traced application'}
                      </p>
                      {!filter && (
                        <p className="mt-1 text-xs text-text-muted">
                          Open Runtime Intelligence above, choose a detected app, and confirm Start.
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  filteredEvents.map((event) => {
                    const duration = formatDuration(event.durationMs);
                    return (
                      <div
                        key={`${event.seq}-${event.receivedAt}`}
                        className="grid grid-cols-[80px_64px_64px_minmax(160px,1fr)_minmax(220px,1.5fr)_80px_80px] gap-2 border-b border-border-subtle/40 px-4 py-2 text-xs hover:bg-hover/50"
                      >
                        <span className="font-mono text-text-muted">{formatClock(event.ts)}</span>
                        <span
                          className={`font-mono uppercase ${RUNTIME_COLORS[event.runtime] ?? 'text-text-muted'}`}
                        >
                          {event.runtime}
                        </span>
                        <span className="font-mono text-text-muted">{event.pid || ''}</span>
                        <span className="truncate font-mono text-text-primary">
                          {event.kind === 'function'
                            ? event.functionName || '<anonymous>'
                            : event.detail || event.kind}
                        </span>
                        <span className="truncate font-mono text-text-muted">
                          {event.filePath || ''}
                          {event.line ? `:${event.line}` : ''}
                        </span>
                        <span className="text-right font-mono text-text-muted">
                          {event.calls ? `×${event.calls}` : ''}
                        </span>
                        <span className="text-right font-mono text-text-muted">
                          {duration || ''}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
