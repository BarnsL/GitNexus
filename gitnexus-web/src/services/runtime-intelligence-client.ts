import type { RuntimeAdvisorDecision, RuntimeIntelligenceProfile } from 'gitnexus-shared';
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

const profileResponse = async (response: Response): Promise<RuntimeIntelligenceProfile> => {
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
  return (await response.json()) as RuntimeIntelligenceProfile;
};

const baseUrl = (explicit?: string | null): string =>
  (explicit ?? getBackendUrl()).replace(/\/$/, '');

export async function fetchRuntimeIntelligenceProfile(
  repo: string,
  backendUrl?: string | null,
): Promise<RuntimeIntelligenceProfile> {
  const base = baseUrl(backendUrl);
  return await profileResponse(
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
  return await profileResponse(
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
  return await profileResponse(
    await fetch(`${base}/api/runtime-intelligence/profile/advisor`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ repo, expectedGeneration, decision }),
    }),
  );
}
