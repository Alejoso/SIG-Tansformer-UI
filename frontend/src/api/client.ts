/**
 * HTTP plumbing for the FastAPI backend.
 *
 * Only `src/api/index.ts` imports this, which is what keeps the call sites
 * free of fetch details — and what made swapping each mock for the real
 * server a change in one file.
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

/**
 * Pull a readable sentence out of a FastAPI error body.
 *
 * A plain rejection is `{detail: "No such folder"}`; a validation failure is
 * `{detail: [{msg, loc}, …]}`. Both are worth showing; neither is worth making
 * every call site unpack.
 */
function describe(detail: unknown): string | null {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'detail' in detail) {
    const inner = (detail as { detail: unknown }).detail;
    if (typeof inner === 'string') return inner;
    if (Array.isArray(inner)) {
      const messages = inner
        .map((item) =>
          item && typeof item === 'object' && 'msg' in item ? String((item as { msg: unknown }).msg) : null,
        )
        .filter((m): m is string => Boolean(m));
      if (messages.length) return messages.join('; ').replace(/^Value error, /, '');
    }
  }
  return null;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });

  if (!res.ok) {
    // Read the body once. A response body is a stream that can only be
    // consumed a single time, so trying `.json()` and then falling back to
    // `.text()` throws "body stream already read" — and that replaces the
    // real failure with a meaningless one. Take the text, then try to parse.
    const raw = await res.text().catch(() => '');
    let detail: unknown = raw;
    try {
      detail = JSON.parse(raw);
    } catch {
      // Not JSON: an HTML error page, or the dev proxy saying the backend is
      // not listening. The text is what is useful in that case.
    }

    // FastAPI puts the useful sentence in `detail` — surface it as the error
    // message so the UI can show what actually went wrong rather than "500".
    const fallback = raw.trim() || `${init?.method ?? 'GET'} ${path} failed (${res.status})`;
    throw new ApiError(describe(detail) ?? fallback, res.status, detail);
  }

  if (res.status === 204) return undefined as T;

  // Same one-read rule on the success path, so a non-JSON 200 — which is what
  // a misrouted request looks like — reports what actually arrived.
  const body = await res.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ApiError(
      `${init?.method ?? 'GET'} ${path} returned ${res.status} but not JSON. Is the backend running?`,
      res.status,
      body.slice(0, 500),
    );
  }
}

/**
 * Server-sent events. Unused: processing progress is polled instead, which
 * over loopback costs nothing and has no reconnect logic to get wrong. Kept
 * for the first endpoint that genuinely needs a push — the payload shape on
 * both sides is already stream-ready.
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
