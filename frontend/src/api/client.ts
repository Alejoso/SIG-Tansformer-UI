/**
 * HTTP plumbing for the FastAPI backend.
 *
 * Nothing calls this yet — `src/api/index.ts` is wired to the mock adapter.
 * It exists so that swapping the mocks for the real server is a matter of
 * changing the implementations in `index.ts`, not the call sites.
 */

/** Vite proxies `/api` to uvicorn in dev; same-origin once FastAPI serves the build. */
export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly detail?: unknown;

  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });

  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    throw new ApiError(`${init?.method ?? 'GET'} ${path} failed`, res.status, detail);
  }

  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/**
 * Server-sent events, used for processing progress. The backend watches the
 * results folder with `watchfiles` and pushes a `ProcessingProgress` per tick.
 */
export function subscribe<T>(
  path: string,
  onMessage: (payload: T) => void,
  onError?: (err: Event) => void,
): () => void {
  const source = new EventSource(`${API_BASE}${path}`);
  source.onmessage = (e) => onMessage(JSON.parse(e.data) as T);
  if (onError) source.onerror = onError;
  return () => source.close();
}
