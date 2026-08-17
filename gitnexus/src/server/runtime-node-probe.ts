/**
 * Auto-imported Node.js runtime probe used by `gitnexus runtime`.
 *
 * It uses V8 precise coverage with callCount=true. `takePreciseCoverage`
 * returns execution counts since the previous poll and resets those counters,
 * so each emitted `calls` value is the number of executions observed in that
 * sampling window. No user source transformation is required.
 */

import inspector from 'node:inspector';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const enabled = process.env.GITNEXUS_RUNTIME_ENABLED === '1';
const endpoint = process.env.GITNEXUS_RUNTIME_ENDPOINT;
const repo = process.env.GITNEXUS_RUNTIME_REPO;
const root = process.env.GITNEXUS_RUNTIME_ROOT;
const debug = process.env.GITNEXUS_RUNTIME_DEBUG === '1';
const intervalMs = Math.max(
  50,
  Math.min(5_000, Number.parseInt(process.env.GITNEXUS_RUNTIME_INTERVAL_MS ?? '100', 10) || 100),
);

interface ScriptCoverage {
  scriptId: string;
  url: string;
  functions: Array<{
    functionName: string;
    ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
  }>;
}

interface RuntimeEvent {
  ts: number;
  runtime: 'node';
  kind: 'function' | 'process-start' | 'process-exit' | 'log';
  pid: number;
  filePath?: string;
  functionName?: string;
  line?: number;
  calls?: number;
  detail?: string;
}

const log = (...args: unknown[]) => {
  // eslint-disable-next-line no-console -- injected probe diagnostics belong on stderr
  if (debug) console.error('[gitnexus runtime probe]', ...args);
};

const isInside = (parent: string, candidate: string): boolean => {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const normalizeSlashes = (value: string): string => value.replace(/\\/g, '/');

const runtimeRoot = root ? path.resolve(root) : null;

const ignoredPath = (absPath: string): boolean => {
  const p = normalizeSlashes(absPath).toLowerCase();
  return (
    p.includes('/node_modules/') ||
    p.includes('/.git/') ||
    p.includes('/.gitnexus/') ||
    p.endsWith('/runtime-node-probe.ts') ||
    p.endsWith('/runtime-node-probe.js')
  );
};

const toSourcePath = (url: string): string | null => {
  try {
    if (url.startsWith('file://')) return fileURLToPath(url);
    if (path.isAbsolute(url)) return url;
  } catch {
    return null;
  }
  return null;
};

const relPath = (absPath: string): string | null => {
  if (!runtimeRoot || !isInside(runtimeRoot, absPath) || ignoredPath(absPath)) return null;
  const rel = path.relative(runtimeRoot, absPath);
  return normalizeSlashes(rel || path.basename(absPath));
};

const send = async (events: RuntimeEvent[]): Promise<void> => {
  if (!endpoint || !repo || events.length === 0) return;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, events }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) log(`ingest returned ${response.status}`);
  } catch (err) {
    log('ingest failed', err instanceof Error ? err.message : String(err));
  }
};

const start = async (): Promise<void> => {
  if (!enabled || !endpoint || !repo || !runtimeRoot) return;

  const session = new inspector.Session();
  try {
    session.connect();
  } catch (err) {
    log('inspector connect failed', err);
    return;
  }

  const post = <T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      session.post(method as any, params as any, (err: Error | null, result?: T) => {
        if (err) reject(err);
        else resolve((result ?? {}) as T);
      });
    });

  const lineStarts = new Map<string, number[]>();

  const lineForOffset = async (scriptId: string, offset: number): Promise<number | undefined> => {
    let starts = lineStarts.get(scriptId);
    if (!starts) {
      try {
        const source = await post<{ scriptSource?: string }>('Debugger.getScriptSource', {
          scriptId,
        });
        const text = source.scriptSource ?? '';
        starts = [0];
        for (let i = 0; i < text.length; i++) {
          if (text.charCodeAt(i) === 10) starts.push(i + 1);
        }
        lineStarts.set(scriptId, starts);
      } catch {
        return undefined;
      }
    }

    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi + 1;
  };

  try {
    await post('Profiler.enable');
    await post('Debugger.enable');
    await post('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: false,
      allowTriggeredUpdates: false,
    });
  } catch (err) {
    log('precise coverage unavailable', err);
    try {
      session.disconnect();
    } catch {}
    return;
  }

  void send([
    {
      ts: Date.now(),
      runtime: 'node',
      kind: 'process-start',
      pid: process.pid,
      detail: process.argv.slice(0, 8).join(' '),
    },
  ]);

  let polling = false;
  let stopping = false;

  const poll = async (): Promise<void> => {
    if (polling || stopping) return;
    polling = true;
    try {
      const response = await post<{ result?: ScriptCoverage[] }>('Profiler.takePreciseCoverage');
      const scripts = response.result ?? [];
      const rows: RuntimeEvent[] = [];

      for (const script of scripts) {
        const absPath = toSourcePath(script.url);
        if (!absPath) continue;
        const filePath = relPath(absPath);
        if (!filePath) continue;

        for (const fn of script.functions) {
          const range = fn.ranges?.[0];
          if (!range || range.count <= 0) continue;
          const line = await lineForOffset(script.scriptId, range.startOffset);
          rows.push({
            ts: Date.now(),
            runtime: 'node',
            kind: 'function',
            pid: process.pid,
            filePath,
            functionName: fn.functionName || '<anonymous>',
            ...(line ? { line } : {}),
            calls: range.count,
          });
          if (rows.length >= 500) break;
        }
        if (rows.length >= 500) break;
      }

      await send(rows);
    } catch (err) {
      log('coverage poll failed', err instanceof Error ? err.message : String(err));
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => void poll(), intervalMs);
  timer.unref();

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    try {
      await poll();
    } catch {}
    void send([
      {
        ts: Date.now(),
        runtime: 'node',
        kind: 'process-exit',
        pid: process.pid,
      },
    ]);
    try {
      await post('Profiler.stopPreciseCoverage');
    } catch {}
    try {
      session.disconnect();
    } catch {}
  };

  process.once('beforeExit', () => void stop());
};

void start();
