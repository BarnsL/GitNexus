import type { RuntimeAdvisorDecision, RuntimeIntelligenceProfile } from 'gitnexus-shared';
import { logger } from '../core/logger.js';
import { mergeRuntimeAdvisorDecision } from './merge-advisor.js';
import { loadRuntimeProfile, saveRuntimeProfile } from './profile-store.js';
import { buildHeuristicRuntimeProfile } from './reconnaissance.js';

export class RuntimeProfileConflictError extends Error {}

export class RuntimeIntelligenceCoordinator {
  private readonly mutations = new Map<string, Promise<unknown>>();

  private async mutate<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(repoPath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.mutations.set(repoPath, current);
    try {
      return await current;
    } finally {
      if (this.mutations.get(repoPath) === current) this.mutations.delete(repoPath);
    }
  }

  async ensure(repoPath: string, force = false): Promise<RuntimeIntelligenceProfile> {
    if (!force) {
      const existing = await loadRuntimeProfile(repoPath);
      if (existing) return existing;
    }

    return await this.mutate(repoPath, async () => {
      const existing = await loadRuntimeProfile(repoPath);
      if (existing && !force) return existing;
      const profile = await buildHeuristicRuntimeProfile(repoPath);
      if (existing) profile.generation = existing.generation + 1;
      await saveRuntimeProfile(repoPath, profile);
      return profile;
    });
  }

  async applyAdvisorDecision(
    repoPath: string,
    expectedGeneration: number,
    decision: RuntimeAdvisorDecision,
  ): Promise<RuntimeIntelligenceProfile> {
    return await this.mutate(repoPath, async () => {
      const base =
        (await loadRuntimeProfile(repoPath)) ?? (await buildHeuristicRuntimeProfile(repoPath));
      if (base.generation !== expectedGeneration) {
        throw new RuntimeProfileConflictError(
          `Runtime profile generation changed from ${expectedGeneration} to ${base.generation}`,
        );
      }
      const merged = mergeRuntimeAdvisorDecision(base, decision);
      await saveRuntimeProfile(repoPath, merged);
      return merged;
    });
  }

  /** Best-effort refresh invoked only after a healthy index is published. */
  schedule(repoPath: string): void {
    void this.ensure(repoPath, true).catch((error) => {
      logger.warn({ error, repoPath }, 'Runtime Intelligence reconnaissance failed');
    });
  }
}
