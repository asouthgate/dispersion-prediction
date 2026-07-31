const API_BASE = '/api';
const TOKEN_KEY = 'session_token';
const EXPIRY_KEY = 'session_token_expires_at';
const SAFETY_MARGIN_MS = 60_000;
const COOLDOWN_MS = 5_500;

// Event bus to wake up waiting calls early when a token is minted
const authBus = new EventTarget();

let lastTokenRequest = 0;

export class AuthError extends Error {
  name = 'AuthError';
}

export function getStoredToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

/**
 * Safely clears storage ONLY if the target token matches what's currently stored.
 * If targetToken is omitted, clears unconditionally.
 */
export function clearToken(targetToken?: string): void {
  const current = getStoredToken();
  if (!targetToken || current === targetToken) {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXPIRY_KEY);
  }
}

function isTokenValid(): boolean {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) return false;
  const expirySec = Number(sessionStorage.getItem(EXPIRY_KEY) ?? 0);
  if (!expirySec) return true;
  return Date.now() + SAFETY_MARGIN_MS <= expirySec * 1000;
}

/**
 * Sleep helper that wakes up EARLY if a 'token_updated' event fires.
 */
function sleepOrTokenUpdated(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      authBus.removeEventListener('token_updated', onUpdate);
      resolve();
    }, ms);

    function onUpdate() {
      clearTimeout(timer);
      authBus.removeEventListener('token_updated', onUpdate);
      resolve();
    }

    authBus.addEventListener('token_updated', onUpdate);
  });
}

function debug_log_token(stringo: string) {
  console.warn(stringo, {
      tokenPresent: !!sessionStorage.getItem(TOKEN_KEY),
      tokenPrefix: (sessionStorage.getItem(TOKEN_KEY) ?? '').slice(0, 8),
      expiry: sessionStorage.getItem(EXPIRY_KEY),
      lastTokenRequest,
      now: Date.now(),
    });
}

export async function acquireToken(): Promise<string> {
  // 1. Fast-path: Check if a valid token is already in sessionStorage
  const stored = getStoredToken();
  if (stored && isTokenValid()) {
    return stored;
  }

  // 2. Cross-thread lock managed by the browser engine
  return await navigator.locks.request('acquire_auth_token', async () => {
    // 3. RE-CHECK storage!
    // If Worker #1 acquired the lock and minted a token, Worker #2 gets the lock
    // next and immediately finds the fresh token here without calling the API.
    const freshStored = getStoredToken();
    if (freshStored && isTokenValid()) {
      return freshStored;
    }

    // Cooldown check
    const waitMs = lastTokenRequest + COOLDOWN_MS - Date.now();
    if (waitMs > 0) {
      await sleepOrTokenUpdated(waitMs);
      const afterWait = getStoredToken();
      if (afterWait && isTokenValid()) return afterWait;
    }

    lastTokenRequest = Date.now();
    debug_log_token('minting new token inside lock');

    const res = await fetch(`${API_BASE}/auth/token`, { method: 'POST' });
    if (!res.ok) throw new AuthError('Server error');
    const payload = await res.json();

    sessionStorage.setItem(TOKEN_KEY, payload.token);
    if (payload.expires_at) {
      sessionStorage.setItem(EXPIRY_KEY, String(payload.expires_at));
    }

    authBus.dispatchEvent(new Event('token_updated'));

    return payload.token;
  });
}


export async function fetchWithAuth(url: string, init: RequestInit = {}): Promise<Response> {

  debug_log_token('fetchWithAuth called');

  const token = await acquireToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);

  let res = await fetch(url, { ...init, headers });

  if (res.status === 401) {
    // SAFE CLEAR: Only wipe storage if the bad token is still the one stored.
    // If another request already minted a newer token, this leaves it intact.
    debug_log_token('got 401, wiping token');
    clearToken(token);

    try {
      const fresh = await acquireToken();
      headers.set('Authorization', `Bearer ${fresh}`);
      res = await fetch(url, { ...init, headers });
    } catch {
      /* Return original 401 on failure */
    }
  }
  return res;
}