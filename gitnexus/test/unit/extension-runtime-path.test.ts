import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureWindowsExtensionRuntimePath } from '../../src/core/lbug/extension-runtime-path.js';

const gitBin = String.raw`C:\Program Files\Git\mingw64\bin`;

describe('ensureWindowsExtensionRuntimePath', () => {
  it('prepends Git for Windows OpenSSL dependencies exactly once', () => {
    const env: NodeJS.ProcessEnv = { PATH: String.raw`C:\Windows\System32` };
    const exists = vi.fn().mockReturnValue(true);

    expect(ensureWindowsExtensionRuntimePath({ platform: 'win32', env, exists, gitBin })).toBe(
      gitBin,
    );
    expect(env.PATH?.split(path.win32.delimiter)).toEqual([
      gitBin,
      String.raw`C:\Windows\System32`,
    ]);

    ensureWindowsExtensionRuntimePath({ platform: 'win32', env, exists, gitBin });
    expect(env.PATH?.split(path.win32.delimiter)).toEqual([
      gitBin,
      String.raw`C:\Windows\System32`,
    ]);
  });

  it('does nothing outside Windows or when either OpenSSL DLL is absent', () => {
    const linuxEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    expect(
      ensureWindowsExtensionRuntimePath({
        platform: 'linux',
        env: linuxEnv,
        exists: vi.fn().mockReturnValue(true),
        gitBin,
      }),
    ).toBeNull();
    expect(linuxEnv.PATH).toBe('/usr/bin');

    const windowsEnv: NodeJS.ProcessEnv = { PATH: String.raw`C:\Windows\System32` };
    const exists = vi.fn((candidate: string) => candidate.endsWith('libssl-3-x64.dll'));
    expect(
      ensureWindowsExtensionRuntimePath({
        platform: 'win32',
        env: windowsEnv,
        exists,
        gitBin,
      }),
    ).toBeNull();
    expect(windowsEnv.PATH).toBe(String.raw`C:\Windows\System32`);
  });
});
