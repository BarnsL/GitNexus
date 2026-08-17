import type express from 'express';
import type { RuntimeIntelligenceCoordinator } from '../runtime-intelligence/coordinator.js';
import { RuntimeProfileConflictError } from '../runtime-intelligence/coordinator.js';
import {
  RuntimeAdvisorValidationError,
  validateRuntimeAdvisorDecision,
} from '../runtime-intelligence/validation.js';
import { createRouteLimiter } from './validation.js';

type ResolveRepo = (
  repoName?: string,
  isRetry?: boolean,
  req?: express.Request,
) => Promise<unknown>;

interface ResolvedRepoEntry {
  path: string;
  __timedOut?: boolean;
}

const resolvedEntry = async (
  resolveRepo: ResolveRepo,
  repo: unknown,
  req: express.Request,
  res: express.Response,
): Promise<ResolvedRepoEntry | null> => {
  if (typeof repo !== 'string' || repo.length === 0 || repo.length > 500) {
    res.status(400).json({ error: 'Expected a repository name' });
    return null;
  }
  const candidate = await resolveRepo(repo, false, req);
  const entry =
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Partial<ResolvedRepoEntry>)
      : null;
  if (!entry || entry.__timedOut || typeof entry.path !== 'string') {
    res.status(entry?.__timedOut ? 503 : 404).json({ error: 'Repository not found' });
    return null;
  }
  return entry as ResolvedRepoEntry;
};

export function mountRuntimeIntelligenceEndpoints(
  app: express.Express,
  resolveRepo: ResolveRepo,
  coordinator: RuntimeIntelligenceCoordinator,
  requireTrustedOrigin: express.RequestHandler,
): void {
  app.get(
    '/api/runtime-intelligence/profile',
    createRouteLimiter({ limit: 120 }),
    async (req: express.Request, res: express.Response) => {
      try {
        const entry = await resolvedEntry(resolveRepo, req.query.repo, req, res);
        if (!entry) return;
        res.json(await coordinator.ensure(entry.path));
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Runtime reconnaissance failed',
        });
      }
    },
  );

  app.post(
    '/api/runtime-intelligence/profile/refresh',
    createRouteLimiter({ limit: 12 }),
    requireTrustedOrigin,
    async (req: express.Request, res: express.Response) => {
      try {
        const entry = await resolvedEntry(resolveRepo, req.body?.repo, req, res);
        if (!entry) return;
        res.json(await coordinator.ensure(entry.path, true));
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Runtime reconnaissance failed',
        });
      }
    },
  );

  app.post(
    '/api/runtime-intelligence/profile/advisor',
    createRouteLimiter({ limit: 30 }),
    requireTrustedOrigin,
    async (req: express.Request, res: express.Response) => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const entry = await resolvedEntry(resolveRepo, body?.repo, req, res);
        if (!entry) return;
        if (!Number.isInteger(body?.expectedGeneration) || Number(body?.expectedGeneration) < 1) {
          res.status(400).json({ error: 'Expected a positive integer profile generation' });
          return;
        }

        const profile = await coordinator.ensure(entry.path);
        const decision = validateRuntimeAdvisorDecision(
          body?.decision,
          new Set(profile.components.map((component) => component.id)),
        );
        res.json(
          await coordinator.applyAdvisorDecision(
            entry.path,
            Number(body?.expectedGeneration),
            decision,
          ),
        );
      } catch (error) {
        if (error instanceof RuntimeAdvisorValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        if (error instanceof RuntimeProfileConflictError) {
          res.status(409).json({ error: error.message });
          return;
        }
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Runtime advisor merge failed',
        });
      }
    },
  );
}
