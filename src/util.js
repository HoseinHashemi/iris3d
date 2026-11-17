// Shared helpers: colormap, blur, sampling.

const T_STOPS = [
  [150, [0.12, 0.02, 0.32]],
  [200, [0.10, 0.22, 0.85]],
  [250, [0.08, 0.70, 0.95]],
  [290, [0.20, 0.82, 0.32]],
  [330, [1.00, 0.88, 0.10]],
  [380, [1.00, 0.38, 0.10]],
  [430, [0.85, 0.08, 0.10]],
  [480, [1.00, 1.00, 1.00]],
];

/** Clinical-style retinal thickness colour map (sRGB 0..1). */
export function thicknessColor(um) {
  if (!(um > T_STOPS[0][0])) return T_STOPS[0][1];
  for (let i = 1; i < T_STOPS.length; i++) {
    if (um <= T_STOPS[i][0]) {
      const [a, ca] = T_STOPS[i - 1], [b, cb] = T_STOPS[i];
      const t = (um - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
    }
  }
  return T_STOPS[T_STOPS.length - 1][1];
}

export function thicknessGradientCSS(min = 150, max = 450) {
  const parts = [];
  for (let i = 0; i <= 20; i++) {
    const um = min + ((max - min) * i) / 20;
    const c = thicknessColor(um).map((v) => Math.round(v * 255));
    parts.push(`rgb(${c}) ${i * 5}%`);
  }
  return `linear-gradient(90deg, ${parts.join(',')})`;
}

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return { k, r };
}

/** Separable gaussian blur on a w×h float grid (clamped edges). */
export function gaussBlur(src, w, h, sx, sy) {
  let a = Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  if (sx > 0.05) {
    const { k, r } = gaussKernel(sx);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = -r; j <= r; j++) {
          const xx = x + j < 0 ? 0 : x + j >= w ? w - 1 : x + j;
          s += a[row + xx] * k[j + r];
        }
        tmp[row + x] = s;
      }
    }
    a.set(tmp);
  }
  if (sy > 0.05 && h > 1) {
    const { k, r } = gaussKernel(sy);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = -r; j <= r; j++) {
          const yy = y + j < 0 ? 0 : y + j >= h ? h - 1 : y + j;
          s += a[yy * w + x] * k[j + r];
        }
        tmp[y * w + x] = s;
      }
    }
    a.set(tmp);
  }
  return a;
}

/** Bilinear sample of a w×h float grid at fractional (x, y). */
export function bilinear(arr, w, h, x, y) {
  x = Math.min(Math.max(x, 0), w - 1);
  y = Math.min(Math.max(y, 0), h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const a = arr[y0 * w + x0], b = arr[y0 * w + x1], c = arr[y1 * w + x0], d = arr[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

export const nextFrame = () => new Promise((r) => setTimeout(r, 0));
