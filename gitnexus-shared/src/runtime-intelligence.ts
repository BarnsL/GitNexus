/** Repository-specific runtime metadata shared by the server and web UI. */
export type RuntimeAppKind =
  | 'browser'
  | 'node'
  | 'python'
  | 'java'
  | 'dotnet'
  | 'go'
  | 'rust'
  | 'native'
  | 'unknown';

export type RuntimeTracerKind =
  | 'browser-cdp-coverage'
  | 'node-v8-coverage'
  | 'python-profile'
  | 'opentelemetry'
  | 'custom';

export type RuntimeSemanticKind =
  | 'function'
  | 'ui-action'
  | 'render'
  | 'http-request'
  | 'database'
  | 'queue'
  | 'websocket'
  | 'state-change'
  | 'error'
  | 'process';

export type RuntimeAnimationType = 'pulse' | 'ripple' | 'glow';

export interface RuntimeEvidence {
  source: 'manifest' | 'dependency' | 'script' | 'graph' | 'runtime' | 'ai' | 'user';
  detail: string;
  confidence: number;
  filePath?: string;
}

export interface RuntimeLaunchCommand {
  command: string;
  cwd?: string;
  role: 'dev' | 'start' | 'test' | 'worker' | 'unknown';
  confidence: number;
  evidence: RuntimeEvidence[];
}

export interface RuntimeTracePlan {
  tracer: RuntimeTracerKind;
  enabled: boolean;
  confidence: number;
  options?: Record<string, string | number | boolean>;
  evidence: RuntimeEvidence[];
}

export interface RuntimeComponentProfile {
  id: string;
  name: string;
  root: string;
  kind: RuntimeAppKind;
  framework?: string;
  packageManager?: string;
  entrypoints: string[];
  launch: RuntimeLaunchCommand[];
  trace: RuntimeTracePlan[];
  ports?: number[];
  confidence: number;
  evidence: RuntimeEvidence[];
}

export interface RuntimeVisualizationRule {
  id: string;
  semanticKind: RuntimeSemanticKind;
  animation: RuntimeAnimationType;
  durationMs: number;
  priority: number;
  enabled: boolean;
  match?: {
    runtime?: string;
    functionRegex?: string;
    pathRegex?: string;
    detailRegex?: string;
    graphLabel?: string;
  };
  edgeAnimation?: 'none' | 'flow';
  label?: string;
  evidence: RuntimeEvidence[];
}

export interface RuntimeHypothesis {
  id: string;
  statement: string;
  status: 'proposed' | 'confirmed' | 'rejected' | 'uncertain';
  confidence: number;
  evidence: RuntimeEvidence[];
}

export interface RuntimeObservationSummary {
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  semanticKind: RuntimeSemanticKind;
  componentId?: string;
  filePath?: string;
  functionName?: string;
}

export interface RuntimeIntelligenceProfile {
  schemaVersion: 1;
  repoPath: string;
  generatedAt: number;
  updatedAt: number;
  generation: number;
  source: 'heuristic' | 'heuristic+ai' | 'manual';
  confidence: number;
  needsAiReview: boolean;
  components: RuntimeComponentProfile[];
  visualizationRules: RuntimeVisualizationRule[];
  hypotheses: RuntimeHypothesis[];
  observations: RuntimeObservationSummary[];
  notes?: string[];
}

/**
 * Narrow AI output. Repository identity, schema, generation, observations, and
 * deterministic evidence remain owned by the server-side profile.
 */
export interface RuntimeAdvisorDecision {
  summary?: string;
  componentUpdates?: Array<{
    componentId: string;
    framework?: string;
    kind?: RuntimeAppKind;
    entrypoints?: string[];
    launch?: RuntimeLaunchCommand[];
    trace?: RuntimeTracePlan[];
    confidence?: number;
    evidence?: RuntimeEvidence[];
  }>;
  visualizationRules?: RuntimeVisualizationRule[];
  hypotheses?: RuntimeHypothesis[];
  confidence?: number;
}

export type RuntimeManagedActionKind = 'trace-app' | 'trace-browser';

export type RuntimeManagedRunState = 'starting' | 'running' | 'stopping' | 'exited' | 'failed';

export interface RuntimeManagedAction {
  id: string;
  componentId: string;
  kind: RuntimeManagedActionKind;
  title: string;
  description: string;
  commandPreview: string;
  workingDirectory: string;
  tracers: RuntimeTracerKind[];
  enabled: boolean;
  disabledReason?: string;
}

export interface RuntimeManagedOutputEntry {
  seq: number;
  ts: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface RuntimeManagedRun {
  id: string;
  actionId: string;
  componentId: string;
  kind: RuntimeManagedActionKind;
  state: RuntimeManagedRunState;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  errorCode?: string;
  error?: string;
  output: RuntimeManagedOutputEntry[];
}

export interface RuntimeManagedRunSnapshot {
  profileGeneration: number;
  actions: RuntimeManagedAction[];
  runs: RuntimeManagedRun[];
}

export interface RuntimeManagedRunStartRequest {
  repo: string;
  expectedGeneration: number;
  actionId: string;
}

export interface RuntimeManagedRunStopRequest {
  repo: string;
}
