// Pathology test harness — run in the browser console of the dev server:
//   const d = await import('/tests/disease.js'); await d.octidMontage(['FVLZIL/CSR1.jpeg', ...]);
// Runs the full segmentation pipeline on single pathological B-scans (OCTID, Zeiss Cirrus, 6 × 2 mm)
// and draws the boundaries on a montage for visual review (no ground truth exists for these images).
import { runSegmentation } from '/src/processing/segment.js';
import { LAYERS } from '/src/state.js';

async function grayFromUrl(url) {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const rgba = g.getImageData(0, 0, bmp.width, bmp.height).data, out = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 1];
  return { w: bmp.width, h: bmp.height, gray: out, bmp };
}

export async function segmentImage(url, { widthMM = 6, depthMM = 2, tune = null } = {}) {
  const im = await grayFromUrl(url);
  const vol = { w: im.w, h: im.h, d: 1, data: im.gray, widthMM, lengthMM: 0.01, depthMM };
  let seg;
  if (tune) { // in-page single pass with modified parameters (for tuning experiments)
    const W = await import('/src/processing/segWorker.js');
    Object.assign(W.TUNE, tune);
    seg = { surfaces: W.segmentBscan(Float32Array.from(im.gray), im.w, im.h, (depthMM * 1000) / im.h, (widthMM * 1000) / im.w) };
  } else seg = await runSegmentation(vol, 0, () => {});
  return { im, seg, vol };
}

export async function octidMontage(files, { cols = 3, scale = 0.62, tune = null } = {}) {
  const res = [];
  for (const f of files) res.push({ f, ...(await segmentImage(`/test-data/octid/${f}`, { tune })) });
  const W = Math.round(res[0].im.w * scale), H = Math.round(res[0].im.h * scale);
  const rows = Math.ceil(res.length / cols);
  let cv = document.getElementById('montage');
  if (!cv) {
    cv = document.createElement('canvas'); cv.id = 'montage';
    Object.assign(cv.style, { position: 'fixed', inset: '0', zIndex: 99, background: '#000', maxWidth: '100vw', maxHeight: '100vh' });
    cv.onclick = () => cv.remove();
    document.body.appendChild(cv);
  }
  cv.width = W * cols; cv.height = H * rows;
  const g = cv.getContext('2d');
  res.forEach((r, n) => {
    const ox = (n % cols) * W, oy = Math.floor(n / cols) * H;
    g.drawImage(r.im.bmp, ox, oy, W, H);
    for (const L of LAYERS) {
      const S = r.seg.surfaces[L.key];
      if (!S) continue;
      g.strokeStyle = L.color; g.lineWidth = 1.3; g.beginPath();
      for (let x = 0; x < r.im.w; x++) { const X = ox + x * scale, Y = oy + S[x] * scale; x ? g.lineTo(X, Y) : g.moveTo(X, Y); }
      g.stroke();
    }
    g.fillStyle = '#fff'; g.font = '13px sans-serif'; g.fillText(r.f.split('/').pop(), ox + 6, oy + 16);
  });
  return res.map((r) => r.f);
}

/** Draw a magnified crop of one case (for close inspection of a boundary). */
export async function crop(file, [x0, y0, x1, y1], { scale = 2.5, tune = null } = {}) {
  const r = await segmentImage(`/test-data/octid/${file}`, { tune });
  let cv = document.getElementById('montage');
  if (!cv) {
    cv = document.createElement('canvas'); cv.id = 'montage';
    Object.assign(cv.style, { position: 'fixed', inset: '0', zIndex: 99, background: '#000', maxWidth: '100vw', maxHeight: '100vh' });
    cv.onclick = () => cv.remove();
    document.body.appendChild(cv);
  }
  cv.width = (x1 - x0) * scale; cv.height = (y1 - y0) * scale;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(r.im.bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, cv.width, cv.height);
  for (const L of LAYERS) {
    const S = r.seg.surfaces[L.key];
    g.strokeStyle = L.color; g.lineWidth = 1.5; g.beginPath();
    for (let x = x0; x < x1; x++) { const X = (x - x0 + 0.5) * scale, Y = (S[x] - y0 + 0.5) * scale; x > x0 ? g.lineTo(X, Y) : g.moveTo(X, Y); }
    g.stroke();
  }
  return r;
}

// ---------------------------------------------------------------- Duke DME volumes vs expert graders
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => (Number.isFinite(v) ? +v.toFixed(1) : null);
const DUKE_DIMS = { widthMM: 8.7, lengthMM: 7.5, depthMM: 1.92 }; // 768 × ~11.3 µm, 61 × ~123 µm, 496 × 3.87 µm
function stats(a) {
  const abs = a.map(Math.abs).sort((p, q) => p - q);
  return { bias: r1(a.reduce((p, q) => p + q, 0) / a.length), mae: r1(abs.reduce((p, q) => p + q, 0) / a.length), p95: r1(abs[Math.floor(a.length * 0.95)]), n: a.length };
}

export async function duke(n) {
  const name = `Subject_${String(n).padStart(2, '0')}.mat`;
  const S = () => window.iris3d.state;
  S().analysis = null; S().comparison = null;
  for (const [id, v] of [['inW', DUKE_DIMS.widthMM], ['inL', DUKE_DIMS.lengthMM], ['inD', DUKE_DIMS.depthMM]]) document.getElementById(id).value = v;
  const blob = await (await fetch(`/test-data/duke_dme/2015_BOE_Chiu/${name}`)).blob();
  const file = new File([blob], name);
  const dt = new DataTransfer(); dt.items.add(file);
  const inp = document.getElementById('fileOct');
  inp.files = dt.files; inp.dispatchEvent(new Event('change'));
  const t0 = performance.now();
  while (!(S().comparison && S().analysis && S().refLabel && !document.getElementById('btnSeg').disabled)) {
    await sleep(500);
    if (performance.now() - t0 > 240000) throw new Error('timeout');
  }
  // inter-observer variability on the same B-scans (grader 1 vs grader 2)
  const { parseMat } = await import('/src/io/matlab.js');
  const m = await parseMat(file, ['manualLayers1', 'manualLayers2']);
  const A = m.manualLayers1.data, B = m.manualLayers2.data, um = (DUKE_DIMS.depthMM * 1000) / 496;
  const gI = [], gB = [], gT = [];
  for (let i = 0; i < A.length; i += 8) {
    const a0 = A[i], a7 = A[i + 7], b0 = B[i], b7 = B[i + 7];
    if ([a0, a7, b0, b7].every((v) => Number.isFinite(v) && v > 0)) { gI.push((a0 - b0) * um); gB.push((a7 - b7) * um); gT.push(((a7 - a0) - (b7 - b0)) * um); }
  }
  const c = S().comparison;
  const out = {
    case: name, seconds: Math.round((performance.now() - t0) / 1000),
    iris3d_vs_grader1: { ILM: c.layers.ILM && { bias: r1(c.layers.ILM.bias), mae: r1(c.layers.ILM.mae) }, BM: c.layers.BM && { bias: r1(c.layers.BM.bias), mae: r1(c.layers.BM.mae) }, thickness: { bias: r1(c.thickness.bias), mae: r1(c.thickness.mae), p95: r1(c.thickness.p95), n: c.thickness.n } },
    grader2_vs_grader1: { ILM: stats(gI), BM: stats(gB), thickness: stats(gT) },
  };
  console.log(out);
  return out;
}

export async function dukeAll(list = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const res = [];
  for (const n of list) res.push(await duke(n));
  console.table(res.map((r) => ({ case: r.case, ocuMAE: r.iris3d_vs_grader1.thickness.mae, ocuBias: r.iris3d_vs_grader1.thickness.bias, ocuP95: r.iris3d_vs_grader1.thickness.p95, graderMAE: r.grader2_vs_grader1.thickness.mae, graderP95: r.grader2_vs_grader1.thickness.p95 })));
  return res;
}

/** STARE fundus photos: landmark detection montage (green = disc, cyan = fovea, white = FOV circle). */
export async function stareMontage(ids, { cols = 4, W = 330 } = {}) {
  const { loadFundusFile } = await import('/src/io/loaders.js');
  const { detectLandmarks } = await import('/src/processing/landmarks.js');
  const res = [];
  for (const id of ids) {
    const name = `im${String(id).padStart(4, '0')}.ppm`;
    const blob = await (await fetch(`/test-data/stare/images/${name}`)).blob();
    const canvas = await loadFundusFile(new File([blob], name));
    res.push({ name, canvas, lm: detectLandmarks(canvas) });
  }
  const H = Math.round((W * res[0].canvas.height) / res[0].canvas.width), rows = Math.ceil(res.length / cols);
  let cv = document.getElementById('montage');
  if (!cv) {
    cv = document.createElement('canvas'); cv.id = 'montage';
    Object.assign(cv.style, { position: 'fixed', inset: '0', zIndex: 99, background: '#000', maxWidth: '100vw', maxHeight: '100vh' });
    cv.onclick = () => cv.remove();
    document.body.appendChild(cv);
  }
  cv.width = W * cols; cv.height = H * rows;
  const g = cv.getContext('2d');
  res.forEach((r, k) => {
    const ox = (k % cols) * W, oy = Math.floor(k / cols) * H, s = W / r.canvas.width;
    g.drawImage(r.canvas, ox, oy, W, H);
    const mark = (p, col, rad) => { if (!p) return; g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.arc(ox + p.x * s, oy + p.y * s, rad, 0, 7); g.stroke(); };
    mark(r.lm.disc, '#3f6', 14); mark(r.lm.fovea, '#3df', 9);
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1; g.beginPath(); g.arc(ox + W / 2, oy + H / 2, (r.lm.fovDiamPx * s) / 2, 0, 7); g.stroke();
    g.fillStyle = '#fff'; g.font = '12px sans-serif'; g.fillText(r.name, ox + 5, oy + 14);
  });
  return res.map((r) => [r.name, r.lm.laterality]);
}
