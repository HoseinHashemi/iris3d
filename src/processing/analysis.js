// Quantitative analysis: thickness map, automatic fovea, ETDRS sectors, macular volume, en-face.
import { gaussBlur } from '../util.js';

export function computeAnalysis(vol, seg, laterality) {
  const { w, h, d, widthMM: W, lengthMM: L, depthMM: D } = vol;
  const um = (D * 1000) / h;
  const { ILM, BM } = seg.surfaces;
  const T = new Float32Array(w * d);
  for (let i = 0; i < w * d; i++) T[i] = Math.max(0, BM[i] - ILM[i]) * um;

  const dxmm = W / Math.max(1, w - 1), dzmm = d > 1 ? L / (d - 1) : 1;
  const xmm = (i) => (i / Math.max(1, w - 1) - 0.5) * W;
  const zmm = (k) => (d > 1 ? (k / (d - 1) - 0.5) * L : 0);

  // Fovea = minimum of the smoothed thickness map within 1.5 mm of the scan centre
  const Ts = gaussBlur(T, w, d, 0.12 / dxmm, d > 1 ? 0.12 / dzmm : 0);
  let fi = w >> 1, fk = d >> 1, best = Infinity;
  for (let k = 0; k < d; k++) for (let i = 0; i < w; i++) {
    if (Math.hypot(xmm(i), zmm(k)) > 1.5) continue;
    if (Ts[k * w + i] < best) { best = Ts[k * w + i]; fi = i; fk = k; }
  }
  const fovea = { x: xmm(fi), z: zmm(fk), i: fi, k: fk };

  // ETDRS (1, 3, 6 mm diameters). Nasal is towards the disc: +x for OD, −x for OS.
  const keys = ['C', 'S1', 'N1', 'I1', 'T1', 'S3', 'N3', 'I3', 'T3'];
  const sum = Object.fromEntries(keys.map((k) => [k, 0])), cnt = Object.fromEntries(keys.map((k) => [k, 0]));
  let vol6 = 0, area6 = 0, tMin = Infinity, tMax = 0, tSum = 0;
  const cell = dxmm * (d > 1 ? dzmm : 0);
  for (let k = 0; k < d; k++) for (let i = 0; i < w; i++) {
    const t = T[k * w + i];
    tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); tSum += t;
    const dx = xmm(i) - fovea.x, dz = zmm(k) - fovea.z, r = Math.hypot(dx, dz);
    if (r > 3) continue;
    vol6 += (t / 1000) * cell; area6 += cell;
    let key;
    if (r <= 0.5) key = 'C';
    else {
      const ring = r <= 1.5 ? '1' : '3';
      const nasal = laterality === 'OD' ? dx : -dx;
      if (Math.abs(dz) >= Math.abs(dx)) key = (dz < 0 ? 'S' : 'I') + ring;
      else key = (nasal > 0 ? 'N' : 'T') + ring;
    }
    sum[key] += t; cnt[key]++;
  }
  const sectors = Object.fromEntries(keys.map((k) => [k, cnt[k] ? sum[k] / cnt[k] : NaN]));

  // En-face projection (mean reflectivity between ILM and BM)
  const enface = new Float32Array(w * d);
  let eMax = 1;
  for (let k = 0; k < d; k++) for (let i = 0; i < w; i++) {
    const a = Math.max(0, Math.floor(ILM[k * w + i])), b = Math.min(h - 1, Math.ceil(BM[k * w + i]) + 4);
    let s = 0;
    for (let y = a; y <= b; y++) s += vol.data[k * w * h + y * w + i];
    const v = s / Math.max(1, b - a + 1);
    enface[k * w + i] = v; if (v > eMax) eMax = v;
  }
  for (let i = 0; i < enface.length; i++) enface[i] /= eMax;

  return {
    thickness: T, fovea, sectors, enface,
    centralPoint: T[fk * w + fi],
    macularVolume: vol6, coverage: area6 / (Math.PI * 9),
    tMin, tMax, tMean: tSum / (w * d), umPerPx: um,
  };
}
