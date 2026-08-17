import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_GIT_FOR_WINDOWS_BIN = String.raw`C:\Program Files\Git\mingw64\bin`;
const OPENSSL_RUNTIME_FILES = ['libssl-3-x64.dll', 'libcrypto-3-x64.dll'] as const;

interface RuntimePathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  gitBin?: string;
}

/**
 * Make the OpenSSL runtime bundled with Git for Windows visible to LadybugDB's
 * optional extensions for this process only. LadybugDB's Windows FTS and
 * VECTOR DLLs depend on OpenSSL 3, while the native database module itself
 * does not, so the failure otherwise appears only at `LOAD EXTENSION` time.
 *
 * The fixed Program Files location is deliberate: adding a user-writable
 * directory to the DLL search path would create a DLL-preloading risk. This is
 * best-effort and leaves PATH unchanged unless both required DLLs exist.
 */
export function ensureWindowsExtensionRuntimePath(options: RuntimePathOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return null;

  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const gitBin = options.gitBin ?? DEFAULT_GIT_FOR_WINDOWS_BIN;
  if (!OPENSSL_RUNTIME_FILES.every((file) => exists(path.win32.join(gitBin, file)))) {
    return null;
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const current = env[pathKey] ?? '';
  const normalizedGitBin = path.win32.normalize(gitBin).toLowerCase();
  const alreadyPresent = current
    .split(path.win32.delimiter)
    .filter(Boolean)
    .some((entry) => path.win32.normalize(entry).toLowerCase() === normalizedGitBin);

  if (!alreadyPresent) {
    env[pathKey] = current ? `${gitBin}${path.win32.delimiter}${current}` : gitBin;
  }
  return gitBin;
}
