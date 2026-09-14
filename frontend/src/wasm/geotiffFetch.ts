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
  const first = rasters[0] as ArrayLike<number>;
  const data = first instanceof Float32Array ? first : Float32Array.from(first);
  return { data, m: image.getHeight(), n: image.getWidth() };
}

