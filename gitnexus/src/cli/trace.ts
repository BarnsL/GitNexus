/**
 * Launch an application with GitNexus runtime probes enabled.
 *
 * Node child processes receive an auto-imported V8 precise-coverage probe.
 * Python child processes auto-load scripts/runtime-python/sitecustomize.py via
 * PYTHONPATH. Both probes report to the same GitNexus runtime event endpoint.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBrowserRuntimeProbe } from './browser-runtime.js';

const _require = createRequire(import.meta.url);

interface TraceOptions {
  server?: string;
  repo?: string;
  interval?: string;
  debug?: boolean;
  browserCdp?: string;
}

const parseOptions = (value: unknown): TraceOptions => {
  if (
    value &&
    typeof value === 'object' &&
    'opts' in value &&
    typeof (value as any).opts === 'function'
  ) {
    return (value as any).opts() as TraceOptions;
  }
  return (value && typeof value === 'object' ? value : {}) as TraceOptions;
};

const normalizeServer = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://localhost:4747';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
};

const appendEnvPath = (head: string, prior: string | undefined): string =>
  prior ? `${head}${path.delimiter}${prior}` : head;

export async function traceCommand(commandArg: unknown, commandObject?: unknown): Promise<void> {
  const command = Array.isArray(commandArg) ? commandArg.map(String) : [];
  const options = parseOptions(commandObject);

  if (command.length === 0) {
    process.stderr.write(
      'Usage: gitnexus runtime [--server http://localhost:4747] [--repo PATH] -- <command> [args...]\n',
    );
    process.exitCode = 1;
    return;
  }

  const repoRoot = path.resolve(options.repo ?? process.cwd());
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throw new Error(`Trace repository does not exist or is not a directory: ${repoRoot}`);
  }

  const interval = Number.parseInt(options.interval ?? '100', 10);
  if (!Number.isInteger(interval) || interval < 50 || interval > 5_000) {
    throw new Error('--interval must be an integer from 50 to 5000 milliseconds');
  }

  const server = normalizeServer(
    options.server ?? process.env.GITNEXUS_SERVER ?? 'http://localhost:4747',
  );
  const endpoint = `${server}/api/runtime/events`;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const isDev = fileURLToPath(import.meta.url).endsWith('.ts');
  const nodeProbePath = path.resolve(
    here,
    '..',
    'server',
    `runtime-node-probe.${isDev ? 'ts' : 'js'}`,
  );
  const pythonProbeDir = path.resolve(here, '..', '..', 'scripts', 'runtime-python');

  if (!fs.existsSync(nodeProbePath)) {
    throw new Error(`GitNexus Node runtime probe is missing: ${nodeProbePath}`);
  }
  if (!fs.existsSync(path.join(pythonProbeDir, 'sitecustomize.py'))) {
    throw new Error(`GitNexus Python runtime probe is missing: ${pythonProbeDir}`);
  }

  const nodeImports: string[] = [];
  if (isDev) {
    nodeImports.push(`--import=${pathToFileURL(_require.resolve('tsx/esm')).href}`);
  }
  nodeImports.push(`--import=${pathToFileURL(nodeProbePath).href}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITNEXUS_RUNTIME_ENABLED: '1',
    GITNEXUS_RUNTIME_ENDPOINT: endpoint,
    GITNEXUS_RUNTIME_REPO: repoRoot,
    GITNEXUS_RUNTIME_ROOT: repoRoot,
    GITNEXUS_RUNTIME_INTERVAL_MS: String(interval),
    ...(options.debug ? { GITNEXUS_RUNTIME_DEBUG: '1' } : {}),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, ...nodeImports].filter(Boolean).join(' '),
    PYTHONPATH: appendEnvPath(pythonProbeDir, process.env.PYTHONPATH),
  };

  console.log(`GitNexus runtime trace: ${repoRoot}`);
  console.log(`Runtime relay: ${endpoint}`);
  console.log(`Sampling window: ${interval} ms`);
  console.log(`Launching: ${command.join(' ')}`);

  const child = spawn(command[0], command.slice(1), {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    // npm/yarn/pnpm are .cmd shims on Windows. The user explicitly supplied
    // this command, so shell execution here has the same authority as typing it
    // in their terminal while preserving direct argv spawning on POSIX.
    shell: process.platform === 'win32',
  });

  const browserProbe = options.browserCdp
    ? startBrowserRuntimeProbe({
        cdpBaseUrl: options.browserCdp,
        endpoint,
        repo: repoRoot,
        root: repoRoot,
        intervalMs: interval,
        debug: options.debug,
      })
    : null;
  if (browserProbe) console.log(`Browser CDP trace: ${options.browserCdp}`);

  const forward = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) resolve(128);
      else resolve(code ?? 0);
    });
  });

  await browserProbe?.stop();
  process.exitCode = exitCode;
}
