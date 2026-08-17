/**
 * Runtime activity relay for GitNexus.
 *
 * Instrumented applications POST compact execution batches here. The server
 * keeps a bounded per-repo ring buffer and fans events out to browser clients
 * over SSE so the graph UI can animate symbols while the application runs.
 */

import type express from 'express';
import { EventEmitter } from 'node:events';
import { createRouteLimiter } from './validation.js';

export type RuntimeKind = 'function' | 'process-start' | 'process-exit' | 'log';
export type RuntimeName = 'node' | 'python' | 'browser' | 'custom';

export interface RuntimeActivityEvent {
  seq: number;
  ts: number;
  receivedAt: number;
  runtime: RuntimeName;
  kind: RuntimeKind;
  pid: number;
  filePath?: string;
  functionName?: string;
  line?: number;
  calls?: number;
  durationMs?: number;
  threadId?: number;
  detail?: string;
}

interface RuntimeActivityInput {
  ts?: unknown;
  runtime?: unknown;
  kind?: unknown;
  pid?: unknown;
  filePath?: unknown;
  functionName?: unknown;
  line?: unknown;
  calls?: unknown;
  durationMs?: unknown;
  threadId?: unknown;
  detail?: unknown;
}

interface ResolvedRuntimeRepo {
  path: string;
  __timedOut?: boolean;
}

const MAX_HISTORY = 500;
const MAX_BATCH = 500;
const MAX_TEXT = 2_000;

const boundedString = (value: unknown, max = MAX_TEXT): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  return clean ? clean.slice(0, max) : undefined;
};

const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
};

const positiveInt = (value: unknown, fallback = 0, max = 1_000_000): number => {
  const n = finiteNumber(value);
  if (n === undefined) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(n)));
};

const sanitizeRuntime = (value: unknown): RuntimeName => {
  if (value === 'python' || value === 'browser' || value === 'custom') return value;
  return 'node';
};

const sanitizeKind = (value: unknown): RuntimeKind => {
  if (value === 'process-start' || value === 'process-exit' || value === 'log') return value;
  return 'function';
};

const sanitizeEvent = (input: RuntimeActivityInput, seq: number): RuntimeActivityEvent => {
  const now = Date.now();
  const rawTs = finiteNumber(input.ts);
  const ts = rawTs !== undefined && rawTs > 0 && rawTs < now + 86_400_000 ? rawTs : now;
  const durationMs = finiteNumber(input.durationMs);
  const line = positiveInt(input.line, 0, 10_000_000);
  const threadId = positiveInt(input.threadId, 0, Number.MAX_SAFE_INTEGER);

  return {
    seq,
    ts,
    receivedAt: now,
    runtime: sanitizeRuntime(input.runtime),
    kind: sanitizeKind(input.kind),
    pid: positiveInt(input.pid, 0, 10_000_000),
    ...(boundedString(input.filePath, 4_096)
      ? { filePath: boundedString(input.filePath, 4_096) }
      : {}),
    ...(boundedString(input.functionName, 1_024)
      ? { functionName: boundedString(input.functionName, 1_024) }
      : {}),
    ...(line > 0 ? { line } : {}),
    ...(positiveInt(input.calls, 0) > 0 ? { calls: positiveInt(input.calls, 0) } : {}),
    ...(durationMs !== undefined && durationMs >= 0
      ? { durationMs: Math.min(durationMs, 3_600_000) }
      : {}),
    ...(threadId > 0 ? { threadId } : {}),
    ...(boundedString(input.detail) ? { detail: boundedString(input.detail) } : {}),
  };
};

export class RuntimeActivityHub {
  private readonly emitter = new EventEmitter();
  private readonly history = new Map<string, RuntimeActivityEvent[]>();
  private seq = 0;

  publish(repoPath: string, rawEvents: readonly RuntimeActivityInput[]): RuntimeActivityEvent[] {
    const accepted = rawEvents.slice(0, MAX_BATCH).map((event) => sanitizeEvent(event, ++this.seq));
    if (accepted.length === 0) return accepted;

    const prior = this.history.get(repoPath) ?? [];
    prior.push(...accepted);
    if (prior.length > MAX_HISTORY) prior.splice(0, prior.length - MAX_HISTORY);
    this.history.set(repoPath, prior);

    for (const event of accepted) this.emitter.emit(repoPath, event);
    return accepted;
  }

  recent(repoPath: string, count = 100): RuntimeActivityEvent[] {
    const rows = this.history.get(repoPath) ?? [];
    return rows.slice(-Math.max(0, Math.min(MAX_HISTORY, count)));
  }

  subscribe(repoPath: string, listener: (event: RuntimeActivityEvent) => void): () => void {
    this.emitter.on(repoPath, listener);
    return () => this.emitter.off(repoPath, listener);
  }

  dispose(): void {
    this.emitter.removeAllListeners();
    this.history.clear();
  }
}

const sseWrite = (res: express.Response, event: RuntimeActivityEvent): void => {
  if (res.destroyed || res.writableEnded) return;
  res.write(`id: ${event.seq}\n`);
  res.write('event: runtime\n');
  res.write(`data: ${JSON.stringify(event)}\n\n`);
};

/**
 * Mount runtime ingest + SSE relay endpoints.
 *
 * GET is read-only and follows the server's normal CORS policy. POST is guarded
 * as a write-like route because it consumes server memory and is intended for
 * local tracer processes (which carry no Origin header and therefore remain
 * compatible with the existing trusted-origin policy).
 */
export function mountRuntimeActivityEndpoints(
  app: express.Express,
  resolveRepo: (
    repoName?: string,
    isRetry?: boolean,
    req?: express.Request,
  ) => Promise<ResolvedRuntimeRepo | null | undefined>,
  hub: RuntimeActivityHub,
  requireTrustedOrigin: express.RequestHandler,
): void {
  app.get(
    '/api/runtime/events',
    createRouteLimiter({ limit: 120 }),
    async (req: express.Request, res: express.Response) => {
      try {
        const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined;
        const entry = await resolveRepo(repo, false, req);
        if (!entry || entry.__timedOut) {
          res.status(entry?.__timedOut ? 503 : 404).json({ error: 'Repository not found' });
          return;
        }

        res.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.flushHeaders();
        res.write(':runtime-ok\n\n');

        // Replay a small recent window so opening the panel does not start empty.
        const rawLastEventId = req.get('Last-Event-ID');
        const lastEventId =
          rawLastEventId && /^\d+$/.test(rawLastEventId) ? Number.parseInt(rawLastEventId, 10) : 0;
        for (const event of hub.recent(entry.path, 100)) {
          if (event.seq > lastEventId) sseWrite(res, event);
        }

        const unsubscribe = hub.subscribe(entry.path, (event) => sseWrite(res, event));
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(':runtime-ping\n\n');
        }, 15_000);

        req.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      } catch (error: unknown) {
        if (!res.headersSent) {
          res.status(500).json({
            error: error instanceof Error ? error.message : 'Runtime stream failed',
          });
        }
      }
    },
  );

  app.post(
    '/api/runtime/events',
    createRouteLimiter({ limit: 600 }),
    requireTrustedOrigin,
    async (req: express.Request, res: express.Response) => {
      try {
        const body = req.body as { repo?: unknown; events?: unknown } | undefined;
        if (!body || typeof body.repo !== 'string' || !Array.isArray(body.events)) {
          res.status(400).json({ error: 'Expected { repo: string, events: [] }' });
          return;
        }
        if (body.events.length > MAX_BATCH) {
          res.status(413).json({ error: `Runtime batch exceeds ${MAX_BATCH} events` });
          return;
        }

        const entry = await resolveRepo(body.repo);
        if (!entry || entry.__timedOut) {
          res.status(entry?.__timedOut ? 503 : 404).json({ error: 'Repository not found' });
          return;
        }

        const accepted = hub.publish(entry.path, body.events as RuntimeActivityInput[]);
        res.status(202).json({ accepted: accepted.length, lastSeq: accepted.at(-1)?.seq ?? null });
      } catch (error: unknown) {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Runtime ingest failed',
        });
      }
    },
  );
}
