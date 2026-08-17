import { getBackendUrl, streamSSE } from './backend-client';

export type RuntimeName = 'node' | 'python' | 'browser' | 'custom';
export type RuntimeKind = 'function' | 'process-start' | 'process-exit' | 'log';

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

export interface RuntimeActivityHandlers {
  onEvent: (event: RuntimeActivityEvent) => void;
  onOpen?: () => void;
  onDisconnect?: () => void;
  onError?: (message: string) => void;
}

/** Connect to the long-lived runtime activity stream for one registered repo. */
export function connectRuntimeActivity(
  repo: string,
  handlers: RuntimeActivityHandlers,
  backendUrl?: string | null,
): () => void {
  const base = (backendUrl ?? getBackendUrl()).replace(/\/$/, '');
  const url = `${base}/api/runtime/events?repo=${encodeURIComponent(repo)}`;
  let outageReported = false;

  const controller = streamSSE<RuntimeActivityEvent>(
    url,
    {
      onMessage: handlers.onEvent,
      onOpen: () => {
        outageReported = false;
        handlers.onOpen?.();
      },
      onReconnecting: () => {
        if (!outageReported) {
          outageReported = true;
          handlers.onDisconnect?.();
        }
      },
      onError: (message: string) => handlers.onError?.(message),
    },
    {
      maxRetries: Infinity,
      baseDelayMs: 500,
      capDelayMs: 5_000,
      retryOnHttpError: true,
    },
  );

  return () => controller.abort();
}
