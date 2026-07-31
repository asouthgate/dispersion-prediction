// import { getStoredToken } from './auth';

const CONSENT_KEY = 'analytics-consent';

export function getConsent(): boolean {
  // Consent is assumed true for now. CONSENT_KEY is retained for future
  // use when a consent banner is introduced — see HelpPanel.tsx TODO.
  const stored = localStorage.getItem(CONSENT_KEY);
  if (stored !== null) {
    return stored === 'true';
  }
  return true;
}

export function setConsent(allow: boolean): void {
  localStorage.setItem(CONSENT_KEY, String(allow));
}

let _pageviewSent = false;

export async function trackPageview(token: string): Promise<void> {
  if (_pageviewSent) return;
  _pageviewSent = true;
  try {
//    const token = getStoredToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token && getConsent()) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    await fetch('/api/analytics/event', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'pageview',
        url: window.location.pathname,
        title: document.title,
        referrer: document.referrer,
        consent: getConsent(),
      }),
    });
  } catch {
    // analytics failure must never affect the app
  }
}
