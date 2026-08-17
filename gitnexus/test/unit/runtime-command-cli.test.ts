import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeCommand = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../src/cli/trace.js', () => ({ traceCommand: runtimeCommand }));

describe('runtime execution CLI command', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
    runtimeCommand.mockClear();
    vi.resetModules();
  });

  it('dispatches runtime execution without shadowing the graph trace command', async () => {
    process.argv = [
      'node',
      'gitnexus',
      'runtime',
      '--server',
      'http://127.0.0.1:4747',
      '--',
      'node',
      '--watch',
      'app.js',
    ];

    await import('../../src/cli/index.js');

    await vi.waitFor(() => {
      expect(runtimeCommand).toHaveBeenCalledTimes(1);
      expect(runtimeCommand.mock.calls[0]?.[0]).toEqual(['node', '--watch', 'app.js']);
      expect(runtimeCommand.mock.calls[0]?.[1]).toMatchObject({
        server: 'http://127.0.0.1:4747',
      });
    });
  });
});
