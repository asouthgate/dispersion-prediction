export function rasterToPngDataUrl(data: Float32Array, m: number, n: number): string {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  const range = max - min || 1;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = m;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const imgData = ctx.createImageData(n, m);

  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const px = i * 4;
    if (Number.isFinite(v)) {
      const val = Math.floor(((v - min) / range) * 255);
      imgData.data[px] = val;
      imgData.data[px + 1] = val;
      imgData.data[px + 2] = val;
      imgData.data[px + 3] = 255;
    } else {
      imgData.data[px + 3] = 0;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
}
