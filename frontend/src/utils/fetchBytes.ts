import { fetchWithAuth } from '../auth';

/** Fetch bytes from an authenticated API URL or a local `blob:` URL. */
export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = url.startsWith('blob:') ? await fetch(url) : await fetchWithAuth(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
