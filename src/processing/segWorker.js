// Retinal layer segmentation worker.
// Per B-scan: graph-search via dynamic programming (minimum-cost path across A-scans with a bounded
// slope and a smoothness penalty, à la Chiu et al. 2010), boundaries found in anatomical order with
// each one constraining the search region of the next. Then sub-pixel refinement and 3D smoothing
// across neighbouring B-scans.
import { gaussBlur } from '../util.js';

const NAMES = ['ILM', 'RNFL', 'EZ', 'RPE', 'BM'];
let acc = null, from = null;

function dpPath(cost, w, h, lo, hi, maxStep, pen, stepAt = null) {
  if (!acc || acc.length < w * h) { acc = new Float32Array(w * h); from = new Int16Array(w * h); }
  for (let y = lo[0]; y <= hi[0]; y++) acc[y * w] = cost[y * w];
  for (let x = 1; x < w; x++) {
    const plo = lo[x - 1], phi = hi[x - 1];
    for (let y = lo[x]; y <= hi[x]; y++) {
      let best = Infinity, by = -1;
      const ms = stepAt ? stepAt[x] : maxStep;
      const a = Math.max(plo, y - ms), b = Math.min(phi, y + ms);
      for (let yp = a; yp <= b; yp++) {
        const v = acc[yp * w + x - 1] + pen * Math.abs(y - yp);
        if (v < best) { best = v; by = yp; }
      }
      if (by < 0) { by = Math.min(phi, Math.max(plo, y)); best = acc[by * w + x - 1] + pen * Math.abs(y - by) + 1; }
      acc[y * w + x] = cost[y * w + x] + best;
      from[y * w + x] = by;
    }
  }
  let y = lo[w - 1], best = Infinity;
  for (let yy = lo[w - 1]; yy <= hi[w - 1]; yy++) if (acc[yy * w + w - 1] < best) { best = acc[yy * w + w - 1]; y = yy; }
  const path = new Float32Array(w);
  for (let x = w - 1; x >= 0; x--) { path[x] = y; if (x > 0) y = from[y * w + x]; }
  return path;
}

/** Parabolic sub-pixel refinement of a path on a score image (higher = better). */
function refine(path, score, w, h) {
  for (let x = 0; x < w; x++) {
    const y = path[x] | 0;
    if (y < 1 || y > h - 2) continue;
    const a = score[(y - 1) * w + x], b = score[y * w + x], c = score[(y + 1) * w + x];
    const den = a - 2 * b + c;
    if (den < 0) { const o = (0.5 * (a - c)) / den; if (Math.abs(o) < 1) path[x] = y + o; }
  }
}

/** Move each path point to the strongest local edge (removes DP/cost-term bias), then sub-pixel. */
function snap(path, score, w, h, a, b) {
  for (let x = 0; x < w; x++) {
    const y0 = Math.round(path[x]);
    let best = -Infinity, by = y0;
    for (let y = Math.max(1, y0 - a); y <= Math.min(h - 2, y0 + b); y++) {
      const v = 0.25 * (score[y * w + Math.max(0, x - 1)] + score[y * w + Math.min(w - 1, x + 1)]) + 0.5 * score[y * w + x];
      if (v > best) { best = v; by = y; }
    }
    path[x] = by;
  }
  refine(path, score, w, h);
}

/** out[y] = max(f[y .. y+L-1]) (van Herk / Gil-Werman, O(n)). */
function windowMax(f, L, out) {
  const n = f.length, g = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = i % L === 0 ? f[i] : Math.max(g[i - 1], f[i]);
  for (let i = n - 1; i >= 0; i--) r[i] = i === n - 1 || (i + 1) % L === 0 ? f[i] : Math.max(r[i + 1], f[i]);
  for (let i = 0; i < n; i++) { const j = Math.min(n - 1, i + L - 1); out[i] = Math.max(r[i], g[j]); }
}

function pct(values, q) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < values.length; i += 3) hist[Math.max(0, Math.min(255, values[i] | 0))]++;
  const target = (values.length / 3) * q;
  let s = 0;
  for (let i = 0; i < 256; i++) { s += hist[i]; if (s >= target) return i; }
  return 255;
}

export const TUNE = { belowW: 0.6, belowF: 0.5 };
export function segmentBscan(img, w, h, um, latUm, prior = null) {
  const RPE_BELOW_W = TUNE.belowW, RPE_BELOW_F = TUNE.belowF;
  const I = gaussBlur(img, w, h, 2.0, 1.2);
  const p20 = pct(I, 0.2), p995 = pct(I, 0.995), range = Math.max(8, p995 - p20);
  const G = new Float32Array(w * h);
  for (let y = 2; y < h - 2; y++) for (let x = 0; x < w; x++) G[y * w + x] = I[(y + 2) * w + x] - I[(y - 2) * w + x];
  const samp = [];
  for (let i = 0; i < G.length; i += 7) samp.push(Math.abs(G[i]));
  samp.sort((a, b) => a - b);
  const gmax = Math.max(4, samp[Math.floor(samp.length * 0.99)]);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const px = (umv) => Math.max(1, Math.round(umv / um));
  const stepPx = Math.max(2, Math.min(15, Math.ceil((0.8 * latUm) / um) + 1));
  const cost = new Float32Array(w * h).fill(10);
  const lo = new Int32Array(w), hi = new Int32Array(w);
  const setRange = (fnLo, fnHi) => {
    for (let x = 0; x < w; x++) {
      let a = Math.max(1, Math.min(h - 2, Math.round(fnLo(x)))), b = Math.max(1, Math.min(h - 2, Math.round(fnHi(x))));
      if (b < a) b = a;
      lo[x] = a; hi[x] = b;
    }
  };

  // vitreous noise level from the top 10 % of rows (the vitreous is always above the retina)
  const topRows = Math.max(3, Math.floor(h * 0.1)), topVals = [];
  for (let y = 0; y < topRows; y++) for (let x = 0; x < w; x += 3) topVals.push(I[y * w + x]);
  topVals.sort((a, b) => a - b);
  const noise = Math.max(p20, topVals[Math.floor(topVals.length * 0.5)]);
  const Inorm = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) Inorm[i] = clamp01((I[i] - noise) / Math.max(8, p995 - noise));

  // --- RPE (first): deepest very bright band, followed by a bright→dark transition ---
  const offB = px(8);
  if (prior) setRange((x) => prior[x] - px(90), (x) => prior[x] + px(40));
  else setRange(() => 4 + px(60), () => h - 3);
  // the RPE is the deepest bright band: penalise candidates that have bright tissue 20–300 µm below
  const a0 = px(20), L = Math.max(1, px(300) - a0), col = new Float32Array(h), wmax = new Float32Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = Inorm[y * w + x];
    windowMax(col, L, wmax);
    for (let y = lo[x]; y <= hi[x]; y++) {
      const yb = Math.min(h - 1, y + offB), below = y + a0 < h ? wmax[y + a0] : 0;
      cost[y * w + x] = 1 - (0.6 * Inorm[y * w + x] + 0.3 * clamp01(-G[yb * w + x] / gmax) + 0.1 * ((y - lo[x]) / Math.max(1, hi[x] - lo[x])))
        + RPE_BELOW_W * Math.max(0, below - RPE_BELOW_F * Inorm[y * w + x]);
    }
  }
  const RPE = dpPath(cost, w, h, lo, hi, Math.max(2, Math.ceil(stepPx * 0.7)), 0.02);
  // the RPE is the deepest of the closely spaced outer bands (EZ, IZ, RPE): move down to a deeper
  // local intensity peak within 20 µm when it is nearly as bright
  {
    const Ir = new Float32Array(w * h);
    const Is = gaussBlur(img, w, h, 3.0, 0.8);
    Ir.set(Is);
    const dpx = px(20);
    const deeper = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const y0 = Math.round(RPE[x]);
      let best = y0;
      for (let y = y0 + 2; y <= Math.min(h - 2, y0 + dpx); y++) {
        const v = Ir[y * w + x];
        if (v >= Ir[(y - 1) * w + x] && v >= Ir[(y + 1) * w + x] && v >= 0.85 * Ir[y0 * w + x]) best = y;
      }
      deeper[x] = best - y0;
    }
    // apply the shift only where it is laterally consistent (median over ±6 columns)
    const buf = [];
    for (let x = 0; x < w; x++) {
      buf.length = 0;
      for (let dx = -6; dx <= 6; dx++) buf.push(deeper[Math.min(w - 1, Math.max(0, x + dx))]);
      buf.sort((p, q) => p - q);
      RPE[x] += buf[6];
    }
    refine(RPE, Ir, w, h);
  }

  // --- ILM: first dark→bright edge above the outer retina. The edge strength is normalised per
  // A-scan (dim inner retina still gives a full-strength ILM) and depth is penalised by the
  // fraction of tissue signal lying above the candidate. ---
  const thr = noise + 0.15 * Math.max(8, p995 - noise);
  // full-thickness defects (macular hole): columns with no tissue at all in the 200 µm above the RPE
  // (no EZ, no ONL) may have their ILM on the defect floor, reached through near-vertical walls.
  const hole = new Uint8Array(w);
  {
    const raw = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let m = 0, n = 0, mo = 0, no = 0;
      for (let y = Math.max(0, Math.round(RPE[x] - px(200))); y <= Math.round(RPE[x] - px(22)); y++) {
        const v = Inorm[y * w + x]; m += v; n++;
        if (y >= RPE[x] - px(70)) { mo += v; no++; }
      }
      // a neurosensory detachment also has a dark gap above the RPE, but thick retina above it:
      // only call it a hole when there is < 60 µm of tissue-bright signal in the whole column above
      let thick = 0;
      for (let y = 4; y < RPE[x] - px(22); y++) if (Inorm[y * w + x] > 0.3) thick++;
      raw[x] = n > 0 && m / n < 0.1 && mo / Math.max(1, no) < 0.14 && thick < px(60) ? 1 : 0;
    }
    // keep only defects at least ~60 µm wide (single dark columns are shadowing, not holes)
    const minRun = Math.max(3, Math.round(60 / latUm));
    for (let x = 0; x < w;) {
      if (!raw[x]) { x++; continue; }
      let e = x; while (e < w && raw[e]) e++;
      if (e - x >= minRun) hole.fill(1, x, e);
      x = e;
    }
  }
  const anyHole = hole.some((v) => v);
  const stepAt = anyHole ? new Int32Array(w) : null;
  if (anyHole) for (let x = 0; x < w; x++) stepAt[x] = hole[x] || hole[Math.max(0, x - 1)] || hole[Math.min(w - 1, x + 1)] ? h : stepPx;
  setRange(() => 4, (x) => RPE[x] - (hole[x] ? px(4) : px(60)));
  const colMax = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let m = 0;
    for (let y = lo[x]; y <= hi[x]; y++) if (G[y * w + x] > m) m = G[y * w + x];
    colMax[x] = m;
  }
  for (let x = 0; x < w; x++) {
    let ref = 0;
    for (let dx = -4; dx <= 4; dx++) ref = Math.max(ref, colMax[Math.min(w - 1, Math.max(0, x + dx))]);
    ref = Math.max(ref, 0.5 * gmax);
    let total = 0;
    for (let y = lo[x]; y <= hi[x]; y++) total += Math.max(0, I[y * w + x] - thr);
    let cum = 0;
    // penalty for tissue above the candidate, scaled down where the column holds very little tissue
    // (e.g. only an operculum or the posterior hyaloid over a macular hole)
    const T0 = px(60) * 0.35 * Math.max(8, p995 - noise), sc = hole[x] ? Math.min(1, total / T0) : 1;
    for (let y = lo[x]; y <= hi[x]; y++) {
      cost[y * w + x] = 1 - clamp01(G[y * w + x] / ref) + (total > 0 ? 1.5 * sc * (cum / total) : 0);
      cum += Math.max(0, I[y * w + x] - thr);
    }
  }
  const ILM = dpPath(cost, w, h, lo, hi, stepPx, 0.01, stepAt);
  if (anyHole) { // remove 1–2 column spikes to an operculum/flap at the hole margin
    const c = ILM.slice(), buf = [];
    for (let x = 0; x < w; x++) {
      if (stepAt[x] !== h && !hole[Math.max(0, x - 3)] && !hole[Math.min(w - 1, x + 3)]) continue;
      buf.length = 0;
      for (let dx = -3; dx <= 3; dx++) buf.push(c[Math.min(w - 1, Math.max(0, x + dx))]);
      buf.sort((p, q) => p - q);
      ILM[x] = buf[3];
    }
  }
  snap(ILM, G, w, h, 3, 3);

  // --- Bruch's membrane: strongest bright→dark edge just below the RPE peak ---
  setRange((x) => RPE[x], (x) => RPE[x] + px(32));
  for (let x = 0; x < w; x++) for (let y = lo[x]; y <= hi[x]; y++) cost[y * w + x] = 1 - clamp01(-G[y * w + x] / gmax);
  const BM = dpPath(cost, w, h, lo, hi, Math.max(2, Math.ceil(stepPx * 0.6)), 0.02);
  const negG = G.map((v) => -v);
  const I2 = gaussBlur(img, w, h, 2.0, 0.7), G1 = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 0; x < w; x++) G1[y * w + x] = I2[(y - 1) * w + x] - I2[(y + 1) * w + x];
  snap(BM, G1, w, h, 3, 2);

  // --- Ellipsoid zone: bright band 27–80 µm inner to the RPE centre ---
  setRange((x) => Math.max(ILM[x] + 2, RPE[x] - px(80)), (x) => Math.max(ILM[x] + 2, RPE[x] - px(27))); // skip the interdigitation zone
  for (let x = 0; x < w; x++) for (let y = lo[x]; y <= hi[x]; y++) cost[y * w + x] = 1 - Inorm[y * w + x];
  const EZ = dpPath(cost, w, h, lo, hi, Math.max(2, Math.ceil(stepPx * 0.7)), 0.02);
  refine(EZ, I, w, h);

  // --- RNFL/GCL: first bright→dark edge below the ILM (approximate) ---
  const span = px(220);
  setRange((x) => ILM[x] + 2, (x) => Math.max(ILM[x] + 3, Math.min(ILM[x] + span, EZ[x] - px(110))));
  for (let x = 0; x < w; x++) for (let y = lo[x]; y <= hi[x]; y++)
    cost[y * w + x] = 1 - clamp01(-G[y * w + x] / gmax) + 0.4 * ((y - ILM[x]) / span);
  const RNFL = dpPath(cost, w, h, lo, hi, stepPx, 0.015);
  refine(RNFL, negG, w, h);

  return { ILM, RNFL, EZ, RPE, BM };
}

function median3x3(a, w, d) {
  const out = new Float32Array(a.length), buf = [];
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    buf.length = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -2; dx <= 2; dx++) {
      const zz = Math.min(d - 1, Math.max(0, z + dz)), xx = Math.min(w - 1, Math.max(0, x + dx));
      buf.push(a[zz * w + xx]);
    }
    buf.sort((p, q) => p - q);
    out[z * w + x] = buf[buf.length >> 1];
  }
  return out;
}

function fitSurface(S, w, d, cPx) {
  const basis = (u, v) => [1, u, v, u * u, u * v, v * v, u * u * u, u * u * v, u * v * v, v * v * v];
  const P = 10, pts = [];
  const sx = Math.max(1, Math.floor(w / 96)), sz = Math.max(1, Math.floor(d / 64));
  for (let z = 0; z < d; z += sz) for (let x = 0; x < w; x += sx)
    pts.push([basis(2 * x / (w - 1) - 1, d > 1 ? 2 * z / (d - 1) - 1 : 0), S[z * w + x]]);
  let coef = new Float64Array(P), wts = new Float64Array(pts.length).fill(1);
  for (let it = 0; it < 8; it++) {
    const A = Array.from({ length: P }, () => new Float64Array(P + 1));
    pts.forEach(([b, y], n) => { const wt = wts[n]; for (let i = 0; i < P; i++) { for (let j = 0; j < P; j++) A[i][j] += wt * b[i] * b[j]; A[i][P] += wt * b[i] * y; } });
    for (let i = 0; i < P; i++) A[i][i] += 1e-6;
    for (let i = 0; i < P; i++) { // gaussian elimination with partial pivoting
      let m = i; for (let r = i + 1; r < P; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
      [A[i], A[m]] = [A[m], A[i]];
      for (let r = 0; r < P; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c <= P; c++) A[r][c] -= f * A[i][c]; }
    }
    coef = coef.map((_, i) => A[i][P] / A[i][i]);
    const c = it < 3 ? cPx * 3 : cPx;
    pts.forEach(([b, y], n) => { let f = 0; for (let i = 0; i < P; i++) f += coef[i] * b[i]; const r = (y - f) / c; wts[n] = Math.abs(r) < 1 ? (1 - r * r) ** 2 : 0; });
  }
  const out = new Float32Array(w * d);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    const b = basis(2 * x / (w - 1) - 1, d > 1 ? 2 * z / (d - 1) - 1 : 0);
    let f = 0; for (let i = 0; i < P; i++) f += coef[i] * b[i];
    out[z * w + x] = f;
  }
  return out;
}

self.onmessage = (e) => {
  const { data, w, h, d, umPerPx, latUm, latUmZ, smooth } = e.data;
  const surf = {};
  NAMES.forEach((n) => (surf[n] = new Float32Array(w * d)));
  const img = new Float32Array(w * h);
  // Devices pad regions without data with exact zeros (e.g. top rows of Spectralis .vol). That padding
  // creates a false 'dark→bright' edge, so zeros are replaced by the slice's noise floor.
  const load = (z) => {
    const off = z * w * h;
    let zeros = 0;
    const hist = new Uint32Array(256);
    for (let i = 0; i < w * h; i++) { const v = data[off + i]; img[i] = v; if (v === 0) zeros++; else hist[v]++; }
    // saturated (255) padding at the top of an A-scan (exports that pad tilt-corrected B-scans with
    // white, e.g. the Duke DME set): the vitreous is never saturated, so extend the first real samples up
    for (let x = 0; x < w; x++) {
      let y0 = 0;
      while (y0 < h && img[y0 * w + x] === 255) y0++;
      if (y0 < 3 || y0 >= h - 8) continue;
      let m = 0;
      for (let y = y0; y < y0 + 8; y++) m += img[y * w + x];
      for (let y = 0; y < y0; y++) img[y * w + x] = m / 8;
      hist[255] -= y0;
    }
    // …and at the bottom (the deepest-bright-band RPE criterion would otherwise lock onto it)
    for (let x = 0; x < w; x++) {
      let y1 = h - 1;
      while (y1 >= 0 && img[y1 * w + x] === 255) y1--;
      const run = h - 1 - y1;
      if (run < 2 || y1 < 8) continue;
      let m = 0;
      for (let y = y1 - 7; y <= y1; y++) m += img[y * w + x];
      for (let y = y1 + 1; y < h; y++) img[y * w + x] = m / 8;
      hist[255] -= run;
    }
    // device padding: a leading run of exact zeros in an A-scan, followed by (mostly non-zero) signal.
    // Its boundary can be curved, so it is detected per column and filled by extending the first real
    // samples upwards (no artificial step edge). A genuinely dark vitreous (sparse speckle) is left alone.
    let padMode = false;
    if (zeros > 0) {
      // padding mode only if, below each column's leading zero run, the upper image is mostly non-zero noise
      let cnt = 0, zc = 0;
      for (let x = 0; x < w; x += 2) {
        let y0 = 0;
        while (y0 < h && img[y0 * w + x] === 0) y0++;
        for (let y = y0; y < Math.min(h, y0 + Math.floor(h * 0.15)); y++) { cnt++; if (img[y * w + x] === 0) zc++; }
      }
      padMode = cnt > 0 && zc / cnt < 0.5;
    }
    if (padMode) {
      for (let x = 0; x < w; x++) {
        let y0 = 0;
        while (y0 < h && img[y0 * w + x] === 0) y0++;
        if (y0 < 3 || y0 >= h - 8) continue;
        let nz = 0;
        for (let y = y0; y < y0 + 8; y++) if (img[y * w + x] === 0) nz++;
        if (nz > 2) continue;
        let m = 0, n = 0;
        for (let y = y0; y < Math.min(h, y0 + 8); y++) if (img[y * w + x] > 0) { m += img[y * w + x]; n++; }
        for (let y = 0; y < y0; y++) img[y * w + x] = m / Math.max(1, n);
      }
    }
    // remaining exact zeros (sparse 'no signal' samples in the noise) → noise floor
    if (zeros > 0) {
      let target = (w * h - zeros) * 0.3, acc = 0, floor = 0;
      for (let v = 1; v < 256; v++) { acc += hist[v]; if (acc >= target) { floor = v; break; } }
      for (let i = 0; i < w * h; i++) if (img[i] === 0) img[i] = floor;
    }
  };
  // pass 1: independent B-scans
  for (let z = 0; z < d; z++) {
    load(z);
    const r = segmentBscan(img, w, h, umPerPx, latUm);
    for (const n of NAMES) surf[n].set(r[n], z * w);
    if (z % 2 === 0) self.postMessage({ type: 'progress', value: 0.5 * (z + 1) / d });
  }
  // robust smooth 3D prior for Bruch's membrane (cubic surface, Tukey-reweighted) → rejects
  // vessel-wall / shadow mis-detections, then pass 2 re-segments the outer retina near the prior
  const prior = fitSurface(surf.BM, w, d, 70 / umPerPx);
  for (let z = 0; z < d; z++) {
    load(z);
    const r = segmentBscan(img, w, h, umPerPx, latUm, prior.subarray(z * w, (z + 1) * w));
    for (const n of NAMES) surf[n].set(r[n], z * w);
    if (z % 2 === 0 || z === d - 1) self.postMessage({ type: 'progress', value: 0.5 + 0.5 * (z + 1) / d });
  }
  // 3D regularisation across B-scans (robust median, then anisotropic gaussian in physical units)
  if (smooth > 0) {
    const sx = (smooth * 25) / latUm, sz = d > 1 ? (smooth * 25) / Math.max(latUm, latUmZ) : 0;
    for (const n of NAMES) surf[n] = gaussBlur(median3x3(surf[n], w, d), w, d, sx, sz);
  }
  // enforce anatomical ordering ILM ≤ RNFL ≤ EZ ≤ RPE ≤ BM (depth increases downwards)
  for (let i = 0; i < w * d; i++) {
    for (let k = 1; k < NAMES.length; k++) {
      const a = surf[NAMES[k - 1]], b = surf[NAMES[k]];
      if (b[i] < a[i]) b[i] = a[i];
    }
  }
  self.postMessage({ type: 'done', surfaces: surf }, NAMES.map((n) => surf[n].buffer));
};
