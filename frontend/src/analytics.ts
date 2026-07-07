import { getTokenSync } from './auth';

const CONSENT_KEY = 'analytics-consent';

export function getConsent(): boolean {
  return localStorage.getItem(CONSENT_KEY) === 'true';
}

export function setConsent(allow: boolean): void {
  localStorage.setItem(CONSENT_KEY, String(allow));
}

let _pageviewSent = false;

export async function trackPageview(): Promise<void> {
  if (_pageviewSent) return;
  _pageviewSent = true;
  try {
    const token = getTokenSync();
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
