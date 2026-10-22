import type { PidGains } from './robot-data.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: {
      Accept: 'application/json',
      ...init.headers,
    },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Use the HTTP status when a proxy returns a non-JSON error page.
  }
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body &&
      typeof body.error === 'string' ? body.error : `http_${response.status}`;
    throw new ApiError(response.status, code);
  }
  return body as T;
}

export interface PidCommandResponse {
  requestId: string;
  baseRevision: number;
  status: 'pending';
}

export function sendPidCommand(
  robotId: string,
  gains: PidGains,
  adminToken: string,
): Promise<PidCommandResponse> {
  return requestJson<PidCommandResponse>(
    `/api/robots/${encodeURIComponent(robotId)}/pid`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(gains),
    },
  );
}
