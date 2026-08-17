import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeIntelligenceProfile } from 'gitnexus-shared';
import { writeFileAtomic } from '../storage/fs-atomic.js';

export const runtimeProfilePath = (repoPath: string): string =>
  path.join(repoPath, '.gitnexus', 'runtime', 'profile.json');

const samePath = (left: string, right: string): boolean => {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
};

const isProfile = (value: unknown, repoPath: string): value is RuntimeIntelligenceProfile => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Partial<RuntimeIntelligenceProfile>;
  return (
    profile.schemaVersion === 1 &&
    typeof profile.repoPath === 'string' &&
    samePath(profile.repoPath, repoPath) &&
    Number.isInteger(profile.generation) &&
    Number(profile.generation) > 0 &&
    typeof profile.confidence === 'number' &&
    Array.isArray(profile.components) &&
    Array.isArray(profile.visualizationRules) &&
    Array.isArray(profile.hypotheses) &&
    Array.isArray(profile.observations)
  );
};

export async function loadRuntimeProfile(
  repoPath: string,
): Promise<RuntimeIntelligenceProfile | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(runtimeProfilePath(repoPath), 'utf8'));
    return isProfile(parsed, repoPath) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveRuntimeProfile(
  repoPath: string,
  profile: RuntimeIntelligenceProfile,
): Promise<void> {
  if (!samePath(profile.repoPath, repoPath)) {
    throw new Error('Runtime profile repository identity does not match its storage location');
  }
  const target = runtimeProfilePath(repoPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, `${JSON.stringify(profile, null, 2)}\n`);
}
