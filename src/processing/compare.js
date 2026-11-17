// Validation against the device's own segmentation (e.g. Heidelberg Spectralis layers in .vol / XML).
import { LAYERS } from '../state.js';
import { computeAnalysis } from './analysis.js';

/** Fill invalid (NaN) device boundary samples by interpolation so they can be rendered/analysed. */
export function fillDeviceSeg(dev, vol) {
  const { w, d } = vol, out = {};
  for (const L of LAYERS) {
    const S = Float32Array.from(dev[L.key] || new Float32Array(w * d).fill(NaN));
    const rowOk = new Array(d).fill(false);
    for (let k = 0; k < d; k++) {
      const r = S.subarray(k * w, (k + 1) * w);
      let last = -1;
      for (let x = 0; x < w; x++) {
        if (!Number.isFinite(r[x])) continue;
        if (last < 0) r.fill(r[x], 0, x);
        else for (let i = last + 1; i < x; i++) r[i] = r[last] + ((r[x] - r[last]) * (i - last)) / (x - last);
        last = x;
      }
      if (last >= 0) { r.fill(r[last], last + 1); rowOk[k] = true; }
    }
    for (let k = 0; k < d; k++) {
      if (rowOk[k]) continue;
      let n = -1;
      for (let dk = 1; dk < d && n < 0; dk++) { if (k - dk >= 0 && rowOk[k - dk]) n = k - dk; else if (k + dk < d && rowOk[k + dk]) n = k + dk; }
      S.set(n >= 0 ? S.subarray(n * w, (n + 1) * w) : new Float32Array(w).fill(vol.h / 2), k * w);
    }
    out[L.key] = S;
  }
  for (let i = 0; i < w * d; i++) for (let j = 1; j < LAYERS.length; j++) {
    const a = out[LAYERS[j - 1].key], b = out[LAYERS[j].key];
    if (b[i] < a[i]) b[i] = a[i];
  }
  return out;
}

function stats(diffs) {
  if (!diffs.length) return null;
  const n = diffs.length;
  let s = 0, a = 0;
  for (const v of diffs) { s += v; a += Math.abs(v); }
  const abs = diffs.map(Math.abs).sort((p, q) => p - q);
  return { bias: s / n, mae: a / n, p95: abs[Math.floor(n * 0.95)], n };
}

export function compareToDevice(state) {
  const { volume: vol, seg, deviceSeg: dev, analysis } = state;
  if (!seg || !dev || seg.device) return null;
  const { w, d } = vol, um = (vol.depthMM * 1000) / vol.h;
  const layers = {};
  for (const key of ['ILM', 'BM', 'RPE', 'EZ', 'RNFL']) {
    const D = dev[key], S = seg.surfaces[key], diffs = [];
    if (!D) continue;
    for (let i = 0; i < w * d; i++) if (Number.isFinite(D[i])) diffs.push((S[i] - D[i]) * um);
    layers[key] = stats(diffs);
  }
  const tdiffs = [];
  for (let i = 0; i < w * d; i++) {
    if (Number.isFinite(dev.ILM[i]) && Number.isFinite(dev.BM[i])) tdiffs.push(analysis.thickness[i] - (dev.BM[i] - dev.ILM[i]) * um);
  }
  const devAnalysis = computeAnalysis(vol, { surfaces: fillDeviceSeg(dev, vol) }, state.laterality);
  const rep = state.deviceStats;
  const reported = rep ? {
    C: rep.C0, S1: rep.S1, N1: rep.N1, I1: rep.I1, T1: rep.T1,
    S3: rep.S2, N3: rep.N2, I3: rep.I2, T3: rep.T2, volume: rep.volume,
  } : null;
  return { layers, thickness: stats(tdiffs), devAnalysis, reported };
}
