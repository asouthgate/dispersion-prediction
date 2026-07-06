/**
 * Session auth helpers: token storage with expiry awareness and a 401
 * retry wrapper. The server issues tokens with a 24h sliding TTL
 * (see `api/routers/auth.py` / `api/middleware/auth.py`), returning
 * both `token` and `expires_at` (Unix epoch seconds). We persist both,
 * pro-actively re-issue before the expiry window elapses, and on any 401
 * force a fresh token and retry the request once.
 */

const API_BASE = '/api';
const TOKEN_KEY = 'session_token';
const EXPIRY_KEY = 'session_token_expires_at';
const SAFETY_MARGIN_MS = 60_000;

let mintingPromise: Promise<string | null> | null = null;

export function getStoredToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

/**
 * Returns the stored token only if it is believed still valid (and not
 * inside the safety margin). Synchronous — safe to call on every request.
 */
export function getTokenSync(): string | null {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const expirySec = Number(sessionStorage.getItem(EXPIRY_KEY) ?? 0);
  if (expirySec && Date.now() + SAFETY_MARGIN_MS > expirySec * 1000) {
    return null;
  }
  return token;
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXPIRY_KEY);
}

/** Mints a brand-new token from the server (unauthenticated endpoint). */
async function _mintToken(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/token`, { method: 'POST' });
    if (!res.ok) return null;
    const payload = (await res.json()) as { token: string; expires_at?: number };
    sessionStorage.setItem(TOKEN_KEY, payload.token);
    sessionStorage.setItem(EXPIRY_KEY, String(payload.expires_at ?? 0));
    return payload.token;
  } catch {
    return null;
  }
}

export async function mintToken(): Promise<string | null> {
  if (mintingPromise) return mintingPromise;
  mintingPromise = _mintToken().finally(() => { mintingPromise = null; });
  return mintingPromise;
}

/**
 * Returns a valid token. When `force`, clears any cached token first
 * (used after a 401 to guarantee a fresh mint). Otherwise returns the
 * stored token if still valid, else mints a new one.
 */
export async function ensureValidToken(force = false): Promise<string | null> {
  if (force) clearToken();
  if (!force) {
    const sync = getTokenSync();
    if (sync) return sync;
  }
  return mintToken();
}

/**
 * `fetch` wrapper that attaches a bearer token and, on 401, force-reissues
 * the token and retries the request exactly once. Other failures are
 * surfaced as the original response so callers can handle them.
 */
export async function fetchWithAuth(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await ensureValidToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res = await fetch(url, { ...init, headers });

  if (res.status === 401) {
    const fresh = await ensureValidToken(true);
    if (fresh) {
      headers.set('Authorization', `Bearer ${fresh}`);
      res = await fetch(url, { ...init, headers });
    }
  }
  return res;
}
