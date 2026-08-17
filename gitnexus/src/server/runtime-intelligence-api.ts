import type express from 'express';
import type { RuntimeIntelligenceCoordinator } from '../runtime-intelligence/coordinator.js';
import { RuntimeProfileConflictError } from '../runtime-intelligence/coordinator.js';
import {
  ManagedRuntimeProcessError,
  type ManagedRuntimeProcessManager,
} from '../runtime-intelligence/managed-process-manager.js';
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
  processManager: ManagedRuntimeProcessManager,
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

  app.get(
    '/api/runtime-intelligence/runs',
    createRouteLimiter({ limit: 120 }),
    async (req: express.Request, res: express.Response) => {
      try {
        const entry = await resolvedEntry(resolveRepo, req.query.repo, req, res);
        if (!entry) return;
        const profile = await coordinator.ensure(entry.path);
        res.json({
          profileGeneration: profile.generation,
          actions: processManager.actions(profile),
          runs: processManager.runs(entry.path),
        });
      } catch {
        res.status(500).json({ error: 'Managed runtime state could not be loaded' });
      }
    },
  );

  app.post(
    '/api/runtime-intelligence/runs',
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
        if (typeof body?.actionId !== 'string' || !/^runtime-[a-f0-9]{16}$/.test(body.actionId)) {
          res.status(400).json({ error: 'Expected a managed runtime action ID' });
          return;
        }
        const profile = await coordinator.ensure(entry.path);
        res
          .status(201)
          .json(
            await processManager.start(
              entry.path,
              profile,
              Number(body.expectedGeneration),
              body.actionId,
            ),
          );
      } catch (error) {
        respondManagedError(error, res);
      }
    },
  );

  app.post(
    '/api/runtime-intelligence/runs/:runId/stop',
    createRouteLimiter({ limit: 60 }),
    requireTrustedOrigin,
    async (req: express.Request, res: express.Response) => {
      try {
        const entry = await resolvedEntry(resolveRepo, req.body?.repo, req, res);
        if (!entry) return;
        const runId = req.params.runId;
        if (typeof runId !== 'string' || runId.length === 0 || runId.length > 200) {
          res.status(400).json({ error: 'Expected a managed run ID' });
          return;
        }
        res.json(await processManager.stop(entry.path, runId));
      } catch (error) {
        respondManagedError(error, res);
      }
    },
  );
}

const respondManagedError = (error: unknown, res: express.Response): void => {
  if (!(error instanceof ManagedRuntimeProcessError)) {
    res.status(500).json({ error: 'Managed runtime operation failed' });
    return;
  }
  const status =
    error.code === 'STALE_PROFILE'
      ? 409
      : error.code === 'RUN_NOT_FOUND'
        ? 404
        : error.code === 'SPAWN_FAILED'
          ? 500
          : 400;
  res.status(status).json({ code: error.code, error: error.message });
};
