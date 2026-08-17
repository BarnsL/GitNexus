import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  RuntimeComponentProfile,
  RuntimeIntelligenceProfile,
  RuntimeManagedAction,
  RuntimeManagedRun,
  RuntimeManagedOutputEntry,
} from 'gitnexus-shared';
import { startBrowserRuntimeProbe, type BrowserProbeHandle } from '../cli/browser-runtime.js';

const _require = createRequire(import.meta.url);
const DEFAULT_MAX_OUTPUT_ENTRIES = 200;
const MAX_OUTPUT_TEXT = 2_000;

type Spawn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof nodeSpawn>[2],
) => ChildProcessWithoutNullStreams;

type TerminateProcess = (child: ChildProcessWithoutNullStreams) => Promise<void>;

interface ManagedProcessDependencies {
  spawn?: Spawn;
  resolveNpmCli?: () => string | null;
  resolveBrowser?: () => string | null;
  isTargetPortAvailable?: (port: number) => Promise<boolean>;
  terminateProcess?: TerminateProcess;
  startBrowserProbe?: typeof startBrowserRuntimeProbe;
  nodeProbePath?: string;
  pythonProbeDir?: string;
  endpoint?: string;
  maxOutputEntries?: number;
  runId?: () => string;
  now?: () => number;
}

interface SpawnPlan {
  command: string;
  args: string[];
  cwd: string;
}

interface InternalRun {
  repoPath: string;
  run: RuntimeManagedRun;
  child: ChildProcessWithoutNullStreams;
  browserChild?: ChildProcessWithoutNullStreams;
  browserProbe?: BrowserProbeHandle;
}

export class ManagedRuntimeProcessError extends Error {
  constructor(
    readonly code:
      | 'STALE_PROFILE'
      | 'UNKNOWN_ACTION'
      | 'UNSAFE_PATH'
      | 'ADAPTER_UNAVAILABLE'
      | 'SPAWN_FAILED'
      | 'RUN_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

const isInside = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const defaultNpmCli = (): string | null => {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  try {
    candidates.push(_require.resolve('npm/bin/npm-cli.js'));
  } catch {
    // The Node installation candidate is the normal packaged fallback.
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
};

const defaultBrowser = (): string | null => {
  const roots = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value));
  const suffixes = [
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ];
  for (const root of roots) {
    for (const suffix of suffixes) {
      const candidate = path.join(root, ...suffix);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
};

const defaultProbePaths = (): { nodeProbePath: string; pythonProbeDir: string } => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const isDev = fileURLToPath(import.meta.url).endsWith('.ts');
  return {
    nodeProbePath: path.resolve(here, '..', 'server', `runtime-node-probe.${isDev ? 'ts' : 'js'}`),
    pythonProbeDir: path.resolve(here, '..', '..', 'scripts', 'runtime-python'),
  };
};

const actionId = (componentId: string, launchIndex: number, kind: string): string =>
  `runtime-${createHash('sha256')
    .update(`${componentId}\0${launchIndex}\0${kind}`)
    .digest('hex')
    .slice(0, 16)}`;

const deterministicLaunch = (component: RuntimeComponentProfile, launchIndex: number): boolean => {
  const launch = component.launch[launchIndex];
  return Boolean(
    launch &&
    launch.evidence.some(
      (item) => item.source === 'script' || item.source === 'manifest' || item.source === 'user',
    ),
  );
};

const safeOutputText = (value: unknown): string =>
  String(value)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, MAX_OUTPUT_TEXT);

const reserveLoopbackPort = async (): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

const canBindLoopback = async (port: number, host: string): Promise<boolean> =>
  await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'EADDRNOTAVAIL');
    });
    server.listen(port, host, () => server.close(() => resolve(true)));
  });

const isLoopbackPortAvailable = async (port: number): Promise<boolean> => {
  const availability = await Promise.all([
    canBindLoopback(port, '127.0.0.1'),
    canBindLoopback(port, '::1'),
  ]);
  return availability.every(Boolean);
};

const terminateOwnedProcess: TerminateProcess = async (child) => {
  if (child.killed || !child.pid) return;
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = nodeSpawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => {
      if (!child.killed) child.kill('SIGTERM');
      resolve();
    });
    killer.once('exit', () => resolve());
  });
};

export class ManagedRuntimeProcessManager {
  private readonly spawn: Spawn;
  private readonly resolveNpmCli: () => string | null;
  private readonly resolveBrowser: () => string | null;
  private readonly isTargetPortAvailable: (port: number) => Promise<boolean>;
  private readonly terminateProcess: TerminateProcess;
  private readonly startBrowserProbe: typeof startBrowserRuntimeProbe;
  private readonly nodeProbePath: string;
  private readonly pythonProbeDir: string;
  private readonly endpoint: string;
  private readonly maxOutputEntries: number;
  private readonly makeRunId: () => string;
  private readonly now: () => number;
  private readonly managed = new Map<string, InternalRun>();
  private outputSeq = 0;

  constructor(dependencies: ManagedProcessDependencies = {}) {
    const defaults = defaultProbePaths();
    this.spawn = dependencies.spawn ?? (nodeSpawn as Spawn);
    this.resolveNpmCli = dependencies.resolveNpmCli ?? defaultNpmCli;
    this.resolveBrowser = dependencies.resolveBrowser ?? defaultBrowser;
    this.isTargetPortAvailable = dependencies.isTargetPortAvailable ?? isLoopbackPortAvailable;
    this.terminateProcess = dependencies.terminateProcess ?? terminateOwnedProcess;
    this.startBrowserProbe = dependencies.startBrowserProbe ?? startBrowserRuntimeProbe;
    this.nodeProbePath = dependencies.nodeProbePath ?? defaults.nodeProbePath;
    this.pythonProbeDir = dependencies.pythonProbeDir ?? defaults.pythonProbeDir;
    this.endpoint = dependencies.endpoint ?? 'http://127.0.0.1:4747/api/runtime/events';
    this.maxOutputEntries = Math.max(
      1,
      dependencies.maxOutputEntries ?? DEFAULT_MAX_OUTPUT_ENTRIES,
    );
    this.makeRunId = dependencies.runId ?? randomUUID;
    this.now = dependencies.now ?? Date.now;
  }

  actions(profile: RuntimeIntelligenceProfile): RuntimeManagedAction[] {
    const repoRoot = path.resolve(profile.repoPath);
    const actions: RuntimeManagedAction[] = [];
    for (const component of profile.components) {
      component.launch.forEach((launch, launchIndex) => {
        if (
          !deterministicLaunch(component, launchIndex) ||
          !['dev', 'start', 'worker'].includes(launch.role)
        )
          return;
        const cwd = path.resolve(repoRoot, launch.cwd ?? component.root);
        const unsafe = !isInside(repoRoot, cwd);
        const spawnPlan = unsafe ? null : this.spawnPlan(component, launchIndex, cwd);
        const enabledTracers = component.trace
          .filter((trace) => trace.enabled)
          .map((trace) => trace.tracer);
        const unavailable = unsafe
          ? 'The discovered working directory is outside the registered repository.'
          : spawnPlan.error;
        if (
          enabledTracers.includes('node-v8-coverage') ||
          enabledTracers.includes('python-profile')
        ) {
          actions.push({
            id: actionId(component.id, launchIndex, 'trace-app'),
            componentId: component.id,
            kind: 'trace-app',
            title: `Start ${component.name} with tracing`,
            description:
              'GitNexus starts this app from its detected project folder and streams function activity into the dock.',
            commandPreview: launch.command,
            workingDirectory: path.relative(repoRoot, cwd).replace(/\\/g, '/') || '.',
            tracers: enabledTracers,
            enabled: !unavailable,
            ...(unavailable ? { disabledReason: unavailable } : {}),
          });
        }

        const browserTrace = component.trace.find(
          (trace) => trace.enabled && trace.tracer === 'browser-cdp-coverage',
        );
        if (browserTrace) {
          const browser = this.resolveBrowser();
          const browserUnavailable =
            unavailable ??
            (browser ? undefined : 'Chrome or Edge was not found in a standard install location.');
          actions.push({
            id: actionId(component.id, launchIndex, 'trace-browser'),
            componentId: component.id,
            kind: 'trace-browser',
            title: `Start ${component.name} with browser tracing`,
            description:
              'GitNexus starts the app and a separate Chrome or Edge profile, then watches browser-side functions through a loopback debugging connection.',
            commandPreview: launch.command,
            workingDirectory: path.relative(repoRoot, cwd).replace(/\\/g, '/') || '.',
            tracers: enabledTracers,
            enabled: !browserUnavailable,
            ...(browserUnavailable ? { disabledReason: browserUnavailable } : {}),
          });
        }
      });
    }
    return actions;
  }

  runs(repoPath: string): RuntimeManagedRun[] {
    const normalizedRepo = path.resolve(repoPath);
    return [...this.managed.values()]
      .filter((entry) => entry.repoPath === normalizedRepo)
      .map((entry) => ({ ...entry.run, output: [...entry.run.output] }))
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  async start(
    repoPath: string,
    profile: RuntimeIntelligenceProfile,
    expectedGeneration: number,
    requestedActionId: string,
  ): Promise<RuntimeManagedRun> {
    if (profile.generation !== expectedGeneration) {
      throw new ManagedRuntimeProcessError(
        'STALE_PROFILE',
        'Runtime discovery changed. Refresh the app list and try again.',
      );
    }
    const action = this.actions(profile).find((candidate) => candidate.id === requestedActionId);
    if (!action) {
      throw new ManagedRuntimeProcessError(
        'UNKNOWN_ACTION',
        'That runtime action is no longer available. Refresh the app list and try again.',
      );
    }
    if (!action.enabled) {
      throw new ManagedRuntimeProcessError(
        action.disabledReason?.toLowerCase().includes('outside')
          ? 'UNSAFE_PATH'
          : 'ADAPTER_UNAVAILABLE',
        action.disabledReason ?? 'The selected runtime adapter is unavailable.',
      );
    }

    const component = profile.components.find((candidate) => candidate.id === action.componentId);
    if (!component) {
      throw new ManagedRuntimeProcessError(
        'UNKNOWN_ACTION',
        'The discovered app no longer exists.',
      );
    }
    const launchIndex = component.launch.findIndex(
      (_launch, index) =>
        action.id === actionId(component.id, index, action.kind) &&
        deterministicLaunch(component, index),
    );
    const repoRoot = path.resolve(repoPath);
    const cwd = path.resolve(repoRoot, component.launch[launchIndex]?.cwd ?? component.root);
    if (launchIndex < 0 || !isInside(repoRoot, cwd)) {
      throw new ManagedRuntimeProcessError('UNSAFE_PATH', 'The discovered app path is unsafe.');
    }
    const plan = this.spawnPlan(component, launchIndex, cwd);
    if (plan.error || !plan.value) {
      throw new ManagedRuntimeProcessError(
        'ADAPTER_UNAVAILABLE',
        plan.error ?? 'The selected runtime adapter is unavailable.',
      );
    }
    if (action.kind === 'trace-browser') {
      const targetPort = component.ports?.[0] ?? 5173;
      if (!(await this.isTargetPortAvailable(targetPort))) {
        throw new ManagedRuntimeProcessError(
          'ADAPTER_UNAVAILABLE',
          `Browser tracing expects the app on port ${targetPort}, but that port is already in use. Stop the existing app or configure a different detected port, then try again.`,
        );
      }
    }

    const id = this.makeRunId();
    const run: RuntimeManagedRun = {
      id,
      actionId: action.id,
      componentId: component.id,
      kind: action.kind,
      state: 'starting',
      startedAt: this.now(),
      output: [],
    };
    const env = this.traceEnvironment(repoRoot);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawn(plan.value.command, plan.value.args, {
        cwd: plan.value.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new ManagedRuntimeProcessError(
        'SPAWN_FAILED',
        'GitNexus could not start the app. Check that its runtime is installed, then try again.',
      );
    }

    const internal: InternalRun = { repoPath: repoRoot, run, child };
    this.managed.set(id, internal);
    run.pid = child.pid;
    run.state = 'running';
    this.capture(internal, child.stdout, 'stdout');
    this.capture(internal, child.stderr, 'stderr');
    child.once('error', () => {
      run.state = 'failed';
      run.errorCode = 'SPAWN_FAILED';
      run.error = 'The app process failed. Review its output, fix the startup problem, and retry.';
      run.endedAt = this.now();
    });
    child.once('exit', (code) => {
      if (run.state !== 'failed') {
        run.state = 'exited';
        run.exitCode = code ?? undefined;
        run.endedAt = this.now();
      }
      void internal.browserProbe?.stop();
      if (internal.browserChild) void this.terminateProcess(internal.browserChild);
    });

    if (action.kind === 'trace-browser') {
      try {
        await this.attachBrowser(internal, component, repoRoot);
      } catch (caught) {
        run.state = 'failed';
        run.errorCode = 'SPAWN_FAILED';
        run.error =
          'Browser tracing could not attach. GitNexus stopped the app and browser; refresh discovery and try again.';
        run.endedAt = this.now();
        await internal.browserProbe?.stop().catch(() => undefined);
        if (internal.browserChild) await this.terminateProcess(internal.browserChild);
        await this.terminateProcess(internal.child);
        if (caught instanceof ManagedRuntimeProcessError) throw caught;
        throw new ManagedRuntimeProcessError('SPAWN_FAILED', run.error);
      }
    }
    return { ...run, output: [...run.output] };
  }

  async stop(repoPath: string, runId: string): Promise<RuntimeManagedRun> {
    const internal = this.managed.get(runId);
    if (!internal || internal.repoPath !== path.resolve(repoPath)) {
      throw new ManagedRuntimeProcessError(
        'RUN_NOT_FOUND',
        'That managed run does not belong to this repository.',
      );
    }
    if (internal.run.state === 'running' || internal.run.state === 'starting') {
      internal.run.state = 'stopping';
      await internal.browserProbe?.stop();
      if (internal.browserChild) await this.terminateProcess(internal.browserChild);
      await this.terminateProcess(internal.child);
    }
    return { ...internal.run, output: [...internal.run.output] };
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.managed.values()].map(async (internal) => {
        await internal.browserProbe?.stop();
        if (internal.browserChild) await this.terminateProcess(internal.browserChild);
        await this.terminateProcess(internal.child);
      }),
    );
  }

  private spawnPlan(
    component: RuntimeComponentProfile,
    launchIndex: number,
    cwd: string,
  ): { value?: SpawnPlan; error?: string } {
    const command = component.launch[launchIndex]?.command.trim() ?? '';
    const npm = /^npm run ([A-Za-z0-9:_-]+)$/.exec(command);
    if (component.kind === 'node' || component.kind === 'browser') {
      if (!npm || component.packageManager !== 'npm') {
        return { error: 'GUI launch currently supports detected npm scripts for Node apps.' };
      }
      const npmCli = this.resolveNpmCli();
      if (!npmCli) return { error: 'npm could not be resolved from this Node installation.' };
      return { value: { command: process.execPath, args: [npmCli, 'run', npm[1]], cwd } };
    }

    if (component.kind === 'python') {
      const parts = command.split(/\s+/);
      const executable = parts.shift();
      const entrypoint = parts[0];
      if (
        (executable !== 'python' && executable !== 'python3') ||
        !entrypoint ||
        !/^[A-Za-z0-9_./\\-]+\.py$/.test(entrypoint) ||
        !component.entrypoints.includes(entrypoint.replace(/\\/g, '/')) ||
        parts.slice(1).some((part) => !/^[A-Za-z0-9_./:=\\-]+$/.test(part))
      ) {
        return { error: 'GUI launch could not validate this Python entrypoint.' };
      }
      return { value: { command: executable, args: parts, cwd } };
    }
    return { error: 'This runtime does not have a managed GUI adapter yet.' };
  }

  private traceEnvironment(repoRoot: string): NodeJS.ProcessEnv {
    const isDev = this.nodeProbePath.endsWith('.ts');
    const nodeImports: string[] = [];
    if (isDev) nodeImports.push(`--import=${pathToFileURL(_require.resolve('tsx/esm')).href}`);
    nodeImports.push(`--import=${pathToFileURL(this.nodeProbePath).href}`);
    return {
      ...process.env,
      GITNEXUS_RUNTIME_ENABLED: '1',
      GITNEXUS_RUNTIME_ENDPOINT: this.endpoint,
      GITNEXUS_RUNTIME_REPO: repoRoot,
      GITNEXUS_RUNTIME_ROOT: repoRoot,
      GITNEXUS_RUNTIME_INTERVAL_MS: '100',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, ...nodeImports].filter(Boolean).join(' '),
      PYTHONPATH: process.env.PYTHONPATH
        ? `${this.pythonProbeDir}${path.delimiter}${process.env.PYTHONPATH}`
        : this.pythonProbeDir,
    };
  }

  private capture(
    internal: InternalRun,
    stream: NodeJS.ReadableStream,
    kind: RuntimeManagedOutputEntry['stream'],
  ): void {
    stream.on('data', (chunk) => {
      for (const rawLine of String(chunk).split(/\r?\n/)) {
        const text = safeOutputText(rawLine);
        if (!text) continue;
        internal.run.output.push({ seq: ++this.outputSeq, ts: this.now(), stream: kind, text });
        if (internal.run.output.length > this.maxOutputEntries) {
          internal.run.output.splice(0, internal.run.output.length - this.maxOutputEntries);
        }
      }
    });
  }

  private async attachBrowser(
    internal: InternalRun,
    component: RuntimeComponentProfile,
    repoRoot: string,
  ): Promise<void> {
    const browser = this.resolveBrowser();
    if (!browser) {
      throw new ManagedRuntimeProcessError(
        'ADAPTER_UNAVAILABLE',
        'Chrome or Edge was not found in a standard install location.',
      );
    }
    const port = await reserveLoopbackPort();
    const profileDir = path.join(os.tmpdir(), 'gitnexus-runtime-browser', internal.run.id);
    fs.mkdirSync(profileDir, { recursive: true });
    const targetPort = component.ports?.[0] ?? 5173;
    internal.browserChild = this.spawn(
      browser,
      [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profileDir}`,
        `http://127.0.0.1:${targetPort}`,
      ],
      {
        cwd: repoRoot,
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    internal.browserProbe = this.startBrowserProbe({
      cdpBaseUrl: `http://127.0.0.1:${port}`,
      endpoint: this.endpoint,
      repo: repoRoot,
      root: repoRoot,
      intervalMs: 100,
    });
  }
}
