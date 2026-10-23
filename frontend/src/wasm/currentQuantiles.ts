/** Percentile colours for positive current; zero/missing cells stay at zero. */
export function currentQuantiles(data: Float32Array, nodata?: number): Float32Array {
  const sorted = data.filter(value => Number.isFinite(value) && value > 0 && value !== nodata).sort();
  const out = new Float32Array(data.length);
  if (sorted.length === 0) return out;
  const ranks = new Map<number, number>();
  for (let lo = 0; lo < sorted.length;) {
    let hi = lo + 1;
    while (hi < sorted.length && sorted[hi] === sorted[lo]) hi++;
    // Equal values share their average rank, independent of raster order.
    ranks.set(sorted[lo], sorted.length === 1 ? 50 : 100 * ((lo + hi - 1) / 2) / (sorted.length - 1));
    lo = hi;
  }
  for (let i = 0; i < data.length; i++) out[i] = ranks.get(data[i]) ?? 0;
  return out;
}
