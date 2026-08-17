/** Chrome/Edge DevTools Protocol runtime probe for browser-side JS/TS modules. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface BrowserProbeOptions {
  cdpBaseUrl: string;
  endpoint: string;
  repo: string;
  root: string;
  intervalMs: number;
  debug?: boolean;
}

interface BrowserProbeHandle {
  stop: () => Promise<void>;
}

interface CdpTarget {
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

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
  runtime: 'browser';
  kind: 'function' | 'process-start' | 'process-exit' | 'log';
  pid: number;
  filePath?: string;
  functionName?: string;
  line?: number;
  calls?: number;
  detail?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeSlashes = (value: string): string => value.replace(/\\/g, '/');
const isInside = (parent: string, candidate: string): boolean => {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const normalizeCdpBase = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
};

const mapBrowserUrlToFile = (root: string, rawUrl: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
    return null;
  }

  let candidate: string;
  if (parsed.protocol === 'file:') {
    try {
      candidate = fileURLToPath(parsed);
    } catch {
      return null;
    }
  } else {
    let pathname: string;
    try {
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      pathname = parsed.pathname;
    }
    if (pathname.startsWith('/@fs/')) {
      candidate = pathname.slice('/@fs/'.length);
      // Vite encodes Windows absolute paths as /@fs/C:/...
      if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(candidate))
        candidate = candidate.slice(1);
    } else {
      const rel = pathname.replace(/^\/+/, '');
      if (!rel || rel.startsWith('@') || rel.includes('/node_modules/')) return null;
      candidate = path.resolve(root, rel);
    }
  }

  candidate = path.resolve(candidate);
  if (!isInside(root, candidate)) return null;
  try {
    if (!fs.statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  return normalizeSlashes(path.relative(root, candidate));
};

export function startBrowserRuntimeProbe(options: BrowserProbeOptions): BrowserProbeHandle {
  const cdpBase = normalizeCdpBase(options.cdpBaseUrl);
  const root = path.resolve(options.root);
  let stopped = false;
  let activeSocket: WebSocket | null = null;

  const debug = (...args: unknown[]) => {
    // eslint-disable-next-line no-console -- debug diagnostics belong on stderr
    if (options.debug) console.error('[gitnexus browser runtime]', ...args);
  };

  const send = async (events: RuntimeEvent[]): Promise<void> => {
    if (events.length === 0 || stopped) return;
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: options.repo, events }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) debug(`ingest returned ${response.status}`);
    } catch (err) {
      debug('ingest failed', err instanceof Error ? err.message : String(err));
    }
  };

  const findTarget = async (): Promise<CdpTarget | null> => {
    try {
      const response = await fetch(`${cdpBase}/json`, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return null;
      const targets = (await response.json()) as CdpTarget[];
      return (
        targets.find(
          (target) =>
            target.type === 'page' &&
            !!target.webSocketDebuggerUrl &&
            !!target.url &&
            !target.url.startsWith('devtools://'),
        ) ?? null
      );
    } catch {
      return null;
    }
  };

  const traceTarget = async (target: CdpTarget): Promise<void> => {
    if (!target.webSocketDebuggerUrl) return;
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    activeSocket = socket;
    let nextId = 0;
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (reason: unknown) => void }
    >();
    const lineStarts = new Map<string, number[]>();

    const closed = new Promise<void>((resolve) => {
      socket.addEventListener('close', () => resolve(), { once: true });
      socket.addEventListener('error', () => resolve(), { once: true });
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP websocket failed')), {
        once: true,
      });
    });

    socket.addEventListener('message', (raw) => {
      try {
        const message = JSON.parse(String(raw.data)) as {
          id?: number;
          result?: unknown;
          error?: unknown;
        };
        if (message.id === undefined) return;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result ?? {});
      } catch {}
    });

    const post = <T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> => {
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    };

    const lineForOffset = async (scriptId: string, offset: number): Promise<number | undefined> => {
      let starts = lineStarts.get(scriptId);
      if (!starts) {
        try {
          const source = await post<{ scriptSource?: string }>('Debugger.getScriptSource', {
            scriptId,
          });
          const text = source.scriptSource ?? '';
          starts = [0];
          for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
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

    await post('Profiler.enable');
    await post('Debugger.enable');
    await post('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: false,
      allowTriggeredUpdates: false,
    });

    await send([
      {
        ts: Date.now(),
        runtime: 'browser',
        kind: 'process-start',
        pid: 0,
        detail: target.url || target.title || 'browser page',
      },
    ]);

    let polling = false;
    const poll = async (): Promise<void> => {
      if (polling || stopped || socket.readyState !== WebSocket.OPEN) return;
      polling = true;
      try {
        const result = await post<{ result?: ScriptCoverage[] }>('Profiler.takePreciseCoverage');
        const events: RuntimeEvent[] = [];
        for (const script of result.result ?? []) {
          const filePath = mapBrowserUrlToFile(root, script.url);
          if (!filePath) continue;
          for (const fn of script.functions) {
            const range = fn.ranges?.[0];
            if (!range || range.count <= 0) continue;
            const line = await lineForOffset(script.scriptId, range.startOffset);
            events.push({
              ts: Date.now(),
              runtime: 'browser',
              kind: 'function',
              pid: 0,
              filePath,
              functionName: fn.functionName || '<anonymous>',
              ...(line ? { line } : {}),
              calls: range.count,
              detail: script.url,
            });
            if (events.length >= 500) break;
          }
          if (events.length >= 500) break;
        }
        await send(events);
      } catch (err) {
        debug('coverage poll failed', err instanceof Error ? err.message : String(err));
      } finally {
        polling = false;
      }
    };

    const timer = setInterval(() => void poll(), options.intervalMs);
    try {
      await closed;
    } finally {
      clearInterval(timer);
      for (const waiter of pending.values()) waiter.reject(new Error('CDP connection closed'));
      pending.clear();
      if (activeSocket === socket) activeSocket = null;
    }
  };

  void (async () => {
    while (!stopped) {
      const target = await findTarget();
      if (!target) {
        await sleep(500);
        continue;
      }
      try {
        await traceTarget(target);
      } catch (err) {
        debug('browser target trace failed', err instanceof Error ? err.message : String(err));
      }
      if (!stopped) await sleep(500);
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      try {
        activeSocket?.close();
      } catch {}
      await sleep(20);
    },
  };
}
