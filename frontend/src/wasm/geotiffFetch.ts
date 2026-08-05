import { fromArrayBuffer } from 'geotiff';
import { fetchWithAuth } from '../auth';

export interface RasterData {
  data: Float32Array;
  m: number;
  n: number;
}

export async function fetchRaster(url: string): Promise<RasterData> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  const buffer = await response.arrayBuffer();
  const tif = await fromArrayBuffer(buffer);
  const image = await tif.getImage();
  const rasters = await image.readRasters();
  const data = rasters[0] as Float32Array;
  return { data, m: image.getHeight(), n: image.getWidth() };
}

export async function fetchRasters(
  urls: Record<string, string>,
): Promise<Record<string, RasterData>> {
  const entries = await Promise.all(
    Object.entries(urls).map(async ([key, url]) => [key, await fetchRaster(url)] as const),
  );
  return Object.fromEntries(entries);
}
