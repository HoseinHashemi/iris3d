// Automatic fundus landmarks: field-of-view circle, optic disc (brightest disc-sized blob),
// fovea (darkest macular region at the expected distance from the disc).
import { gaussBlur } from '../util.js';

export function detectLandmarks(canvas) {
  const S = 256, sc = S / canvas.width, SH = Math.max(8, Math.round(canvas.height * sc));
  const c = document.createElement('canvas');
  c.width = S; c.height = SH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, S, SH);
  const px = ctx.getImageData(0, 0, S, SH).data;
  const n = S * SH, L = new Float32Array(n), G = new Float32Array(n), M = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    L[i] = 0.3 * r + 0.59 * g + 0.11 * b; G[i] = g;
  }
  // field-of-view mask: adaptive threshold (camera borders are often dark grey, not black), then each
  // row filled between its outermost FOV pixels (the aperture is convex; dark fovea/vessels stay inside)
  const sorted = Array.from(L).sort((a, b) => a - b);
  const thr = Math.max(14, 0.3 * sorted[Math.floor(n * 0.9)]);
  let minX = S, maxX = 0;
  for (let y = 0; y < SH; y++) {
    let a = -1, b = -1;
    for (let x = 0; x < S; x++) if (L[y * S + x] > thr) { if (a < 0) a = x; b = x; }
    if (a < 0 || b - a < 4) continue;
    for (let x = a; x <= b; x++) M[y * S + x] = 1;
    if (a < minX) minX = a; if (b > maxX) maxX = b;
  }
  const fovDiamPx = Math.max(10, maxX - minX + 1) / sc;
  const Mi = gaussBlur(M, S, SH, 5, 5); // >0.98 ⇒ well inside the FOV
  const fs0 = fovDiamPx * sc, rd = Math.max(2, 0.07 * fs0); // optic disc radius ≈ 7 % of a 35–45° field
  const Lb = gaussBlur(L, S, SH, rd * 0.6, rd * 0.6);
  const Gb = gaussBlur(G, S, SH, 7, 7);

  // optic disc: bright disc-sized blob crossed by the main vessel trunks, which leave the disc
  // vertically (superior/inferior arcades). Vertical vesselness = dark, narrow, vertically elongated
  // structures; hard exudates and haemorrhage clusters are bright/dark but not long vertical lines.
  const G2 = gaussBlur(G, S, SH, 0.8, 0.8), ves = new Float32Array(n), k = Math.max(2, Math.round(0.012 * fs0));
  for (let y = 0; y < SH; y++) for (let x = k; x < S - k; x++) {
    const i = y * S + x;
    if (M[i]) ves[i] = Math.max(0, 0.5 * (G2[i - k] + G2[i + k]) - G2[i]);
  }
  const Vv = gaussBlur(ves, S, SH, 0.6, rd * 1.3); // integrate along the vertical
  const Vd = gaussBlur(Vv.map((v) => v * v), S, SH, rd * 0.7, rd * 0.4);
  let lMax = 0, vMax = 0, lMin = Infinity;
  for (let i = 0; i < n; i++) if (Mi[i] > 0.6) { lMax = Math.max(lMax, Lb[i]); lMin = Math.min(lMin, Lb[i]); vMax = Math.max(vMax, Vd[i]); }
  let disc = null, best = -Infinity;
  for (let i = 0; i < n; i++) {
    if (Mi[i] <= 0.6) continue;
    const score = (Lb[i] - lMin) / Math.max(1, lMax - lMin) + 1.3 * Math.sqrt(Vd[i] / Math.max(1e-9, vMax));
    if (score > best) { best = score; disc = { x: i % S, y: Math.floor(i / S) }; }
  }

  // fovea: locally darkest region (centre–surround) ~2.5 disc diameters temporal to the disc
  const Fl = gaussBlur(G, S, SH, 0.04 * fs0, 0.04 * fs0), Fs = gaussBlur(G, S, SH, 0.13 * fs0, 0.13 * fs0);
  let fovea = null, low = Infinity;
  for (let i = 0; i < n; i++) {
    if (Mi[i] < 0.985) continue;
    const x = i % S, y = Math.floor(i / S);
    let pen = 0;
    if (disc) {
      const dx = x - disc.x, dy = y - disc.y, dd = Math.hypot(dx, dy);
      if (dd < 0.25 * fs0 || dd > 0.62 * fs0 || Math.abs(dy) > 0.17 * fs0) continue;
      pen = 6 * Math.abs(dd / fs0 - 0.43); // prefer the typical disc–fovea distance
    }
    const v = (Fl[i] - Fs[i]) / Math.max(8, Fs[i]) * 40 + pen;
    if (v < low) { low = v; fovea = { x, y }; }
  }
  if (!fovea) fovea = { x: S / 2, y: SH / 2 };
  const up = (p) => p && { x: (p.x + 0.5) / sc, y: (p.y + 0.5) / sc };
  const f = up(fovea), d = up(disc);
  return { fovea: f, disc: d, fovDiamPx, laterality: d && d.x < f.x ? 'OS' : 'OD' };
}

/** Mean fundus colour in a ring around the fovea (used to blend the photo into the periphery). */
export function meanFundusColor(canvas, fovea, radiusPx) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let r = 0, g = 0, b = 0, n = 0;
  const step = Math.max(1, Math.floor(canvas.width / 200));
  for (let y = 0; y < canvas.height; y += step) for (let x = 0; x < canvas.width; x += step) {
    const dd = Math.hypot(x - fovea.x, y - fovea.y);
    if (dd < radiusPx * 0.55 || dd > radiusPx * 0.95) continue;
    const i = (y * canvas.width + x) * 4;
    if (data[i] + data[i + 1] + data[i + 2] < 40) continue;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : [0.75, 0.35, 0.18];
}
