import type {
  RuntimeAdvisorDecision,
  RuntimeIntelligenceProfile,
  RuntimeManagedRun,
  RuntimeManagedRunSnapshot,
  RuntimeManagedRunStartRequest,
  RuntimeManagedRunStopRequest,
} from 'gitnexus-shared';
import { getAuthToken, getBackendUrl } from './backend-client';

export class RuntimeIntelligenceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const headers = (): Headers => {
  const result = new Headers({ 'Content-Type': 'application/json' });
  const token = getAuthToken();
  if (token) result.set('Authorization', `Bearer ${token}`);
  return result;
};

const jsonResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = `: ${body.error}`;
    } catch {
      // Status remains the useful fallback for non-JSON proxy errors.
    }
    throw new RuntimeIntelligenceRequestError(
      `Runtime Intelligence request failed (${response.status})${detail}`,
      response.status,
    );
  }
  return (await response.json()) as T;
};

const baseUrl = (explicit?: string | null): string =>
  (explicit ?? getBackendUrl()).replace(/\/$/, '');

export async function fetchRuntimeIntelligenceProfile(
  repo: string,
  backendUrl?: string | null,
): Promise<RuntimeIntelligenceProfile> {
  const base = baseUrl(backendUrl);
  return await jsonResponse<RuntimeIntelligenceProfile>(
    await fetch(`${base}/api/runtime-intelligence/profile?repo=${encodeURIComponent(repo)}`, {
      headers: headers(),
    }),
  );
}

export async function refreshRuntimeIntelligenceProfile(
  repo: string,
  backendUrl?: string | null,
): Promise<RuntimeIntelligenceProfile> {
  const base = baseUrl(backendUrl);
  return await jsonResponse<RuntimeIntelligenceProfile>(
    await fetch(`${base}/api/runtime-intelligence/profile/refresh`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ repo }),
    }),
  );
}

export async function saveRuntimeAdvisorDecision(
  repo: string,
  expectedGeneration: number,
  decision: RuntimeAdvisorDecision,
  backendUrl?: string | null,
): Promise<RuntimeIntelligenceProfile> {
  const base = baseUrl(backendUrl);
  return await jsonResponse<RuntimeIntelligenceProfile>(
    await fetch(`${base}/api/runtime-intelligence/profile/advisor`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ repo, expectedGeneration, decision }),
    }),
  );
}

export async function fetchRuntimeManagedRuns(
  repo: string,
  backendUrl?: string | null,
): Promise<RuntimeManagedRunSnapshot> {
  const base = baseUrl(backendUrl);
  return await jsonResponse<RuntimeManagedRunSnapshot>(
    await fetch(`${base}/api/runtime-intelligence/runs?repo=${encodeURIComponent(repo)}`, {
      headers: headers(),
    }),
  );
}

export async function startRuntimeManagedRun(
  request: RuntimeManagedRunStartRequest,
  backendUrl?: string | null,
): Promise<RuntimeManagedRun> {
  const base = baseUrl(backendUrl);
  return await jsonResponse<RuntimeManagedRun>(
    await fetch(`${base}/api/runtime-intelligence/runs`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(request),
    }),
  );
}

export async function stopRuntimeManagedRun(
  runId: string,
  request: RuntimeManagedRunStopRequest,
  backendUrl?: string | null,
): Promise<RuntimeManagedRun> {
  const base = baseUrl(backendUrl);
  return await jsonResponse<RuntimeManagedRun>(
    await fetch(`${base}/api/runtime-intelligence/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(request),
    }),
  );
}
