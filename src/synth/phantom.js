// Synthetic but anatomically-parameterised demo case: a 45° colour fundus photograph and a
// co-registered 6×6 mm macular OCT cube generated from the SAME vessel tree, layer model and
// optic disc position — so registration, segmentation and the 3D model can all be checked.

import { fbm3, vnoise3, mulberry32 } from './noise.js';
import { mmPerDeg } from '../state.js';
import { nextFrame } from '../util.js';

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

function buildVessels(rng, disc) {
  const vessels = [];
  const arcSteer = (sign, rt0, rt1) => (p, h, t) => {
    const r = Math.hypot(p.x, p.y) || 1e-3, a = Math.atan2(p.y, p.x);
    const tx = sign < 0 ? Math.sin(a) : -Math.sin(a), ty = sign < 0 ? -Math.cos(a) : Math.cos(a);
    const k = 0.7 * (r - (rt0 + (rt1 - rt0) * t));
    return angDiff(Math.atan2(ty - (k * p.y) / r, tx - (k * p.x) / r), h) * 0.12;
  };
  const keep = (h0) => (p, h) => angDiff(h0, h) * 0.03;

  function walk(start, heading, length, w0, type, steer, depth) {
    const step = 0.06, n = Math.round(length / step);
    const pts = [start], hs = [heading];
    let p = start, h = heading;
    for (let i = 0; i < n; i++) {
      h += steer(p, h, i / n) + (rng() - 0.5) * 0.1;
      p = { x: p.x + Math.cos(h) * step, y: p.y + Math.sin(h) * step };
      pts.push(p); hs.push(h);
      const r = Math.hypot(p.x, p.y);
      if (r < 0.32 || r > 9.5) break;
    }
    const v = { pts, w0, w1: w0 * (depth === 0 ? 0.55 : 0.35), type };
    vessels.push(v);
    if (depth < 2) {
      const nb = Math.round(length * (depth === 0 ? 1.1 : 0.9));
      for (let b = 0; b < nb; b++) {
        const idx = Math.floor((0.12 + 0.85 * rng()) * (pts.length - 1));
        if (idx < 2) continue;
        const wAt = v.w0 + ((v.w1 - v.w0) * idx) / (pts.length - 1);
        const side = rng() < 0.5 ? -1 : 1;
        const c = (rng() - 0.5) * 0.05;
        walk(pts[idx], hs[idx] + side * (0.45 + 0.7 * rng()), length * (depth === 0 ? 0.3 : 0.35) * (0.4 + 0.8 * rng()),
          wAt * (0.5 + 0.2 * rng()), type, () => c, depth + 1);
      }
    }
  }
  const at = (dx, dy) => ({ x: disc.x + dx, y: disc.y + dy });
  walk(at(-0.05, -0.12), -1.75, 12, 0.105, 'a', arcSteer(-1, 2.9, 4.6), 0);
  walk(at(0.05, -0.08), -1.6, 12, 0.14, 'v', arcSteer(-1, 3.15, 4.9), 0);
  walk(at(-0.05, 0.12), 1.75, 12, 0.1, 'a', arcSteer(1, 2.9, 4.6), 0);
  walk(at(0.05, 0.08), 1.6, 12, 0.135, 'v', arcSteer(1, 3.15, 4.9), 0);
  walk(at(0.1, -0.1), -0.75, 5, 0.075, 'a', keep(-0.75), 0);
  walk(at(0.12, -0.05), -0.95, 5, 0.095, 'v', keep(-0.95), 0);
  walk(at(0.1, 0.1), 0.75, 5, 0.075, 'a', keep(0.75), 0);
  walk(at(0.12, 0.05), 0.95, 5, 0.095, 'v', keep(0.95), 0);
  walk(at(-0.3, -0.05), Math.PI + 0.12, 2.8, 0.04, 'a', keep(Math.PI + 0.12), 1);
  walk(at(-0.3, 0.06), Math.PI - 0.15, 2.8, 0.045, 'v', keep(Math.PI - 0.15), 1);
  return vessels;
}

function strokeVessels(ctx, vessels, colorFn, widthScale = 1) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pass of ['v', 'a']) {
    for (const v of vessels) {
      if (v.type !== pass) continue;
      const n = v.pts.length;
      for (let i = 1; i < n; i++) {
        const w = (v.w0 + ((v.w1 - v.w0) * i) / (n - 1)) * widthScale;
        ctx.strokeStyle = colorFn(v, w);
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(v.pts[i - 1].x, v.pts[i - 1].y);
        ctx.lineTo(v.pts[i].x, v.pts[i].y);
        ctx.stroke();
      }
    }
  }
}

export async function generatePhantom(onProgress = () => {}) {
  const rng = mulberry32(20261117);
  const AL = 23.6;
  const N = 1024, fovDeg = 45;
  const mpp = (fovDeg * mmPerDeg(AL)) / (N * 0.94);
  const fx = N * 0.455, fy = N * 0.515;
  const disc = { x: 4.35, y: -0.3 };
  const vessels = buildVessels(rng, disc);

  // ---------- Fundus photograph ----------
  const fundus = document.createElement('canvas');
  fundus.width = fundus.height = N;
  const ctx = fundus.getContext('2d');
  let img = ctx.createImageData(N, N);
  let p = img.data;
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const i = (py * N + px) * 4;
      const mx = (px - fx) * mpp, my = (py - fy) * mpp, r = Math.hypot(mx, my);
      const n1 = fbm3(mx * 0.9, my * 0.9, 1.7, 4), n2 = vnoise3(mx * 4.5, my * 4.5, 9.1);
      const tig = 0.86 + 0.26 * n1 + 0.06 * (n2 - 0.5);
      let R = 0.84 * tig, G = 0.4 * tig, B = 0.2 * tig;
      const mac = Math.exp(-((r / 1.7) ** 2)), fov = Math.exp(-((r / 0.45) ** 2));
      R *= 1 - 0.25 * mac - 0.1 * fov; G *= 1 - 0.42 * mac - 0.2 * fov; B *= 1 - 0.35 * mac;
      const refl = Math.exp(-((r / 0.06) ** 2)) * 0.6 + 0.07 * Math.exp(-(((r - 1.15) / 0.12) ** 2));
      R += refl; G += refl; B += refl * 0.9;
      const de = Math.hypot((mx - disc.x) / 0.82, (my - disc.y) / 0.93);
      const discT = smooth(1.06, 0.94, de), cupT = smooth(0.52, 0.38, de);
      const ring = Math.exp(-(((de - 1.08) / 0.06) ** 2)) * 0.25;
      R = R + (0.98 - R) * discT; G = G + (0.66 - G) * discT; B = B + (0.48 - B) * discT;
      R = R + (1.0 - R) * cupT; G = G + (0.9 - G) * cupT; B = B + (0.76 - B) * cupT;
      R *= 1 - ring; G *= 1 - ring * 1.2; B *= 1 - ring * 1.2;
      p[i] = Math.min(255, R * 255); p[i + 1] = Math.min(255, G * 255); p[i + 2] = Math.min(255, B * 255); p[i + 3] = 255;
    }
    if (py % 128 === 0) { onProgress(0.25 * (py / N), 'Synthesising fundus photograph…'); await nextFrame(); }
  }
  ctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.setTransform(1 / mpp, 0, 0, 1 / mpp, fx, fy);
  ctx.globalAlpha = 0.92;
  strokeVessels(ctx, vessels, (v) => (v.type === 'a' ? 'rgb(168,40,26)' : 'rgb(108,20,14)'));
  ctx.globalAlpha = 0.3;
  strokeVessels(ctx, vessels.filter((v) => v.w0 > 0.06), () => 'rgb(255,205,175)', 0.28);
  ctx.restore();

  // illumination, FOV mask, grain, gamma
  const soft = document.createElement('canvas');
  soft.width = soft.height = N;
  const sctx = soft.getContext('2d');
  sctx.filter = 'blur(0.7px)';
  sctx.drawImage(fundus, 0, 0);
  img = sctx.getImageData(0, 0, N, N);
  p = img.data;
  const cx = N / 2, cy = N / 2, Rf = N * 0.47;
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const i = (py * N + px) * 4, rr = Math.hypot(px - cx, py - cy) / Rf;
      if (rr > 1) { p[i] = p[i + 1] = p[i + 2] = 0; continue; }
      const k = (1 - 0.42 * rr ** 2.6) * (1 + 0.05 * (px - cx) / Rf) * smooth(1.0, 0.975, rr);
      const g = (rng() - 0.5) * 0.02;
      for (let c = 0; c < 3; c++) p[i + c] = 255 * Math.pow(Math.min(1, Math.max(0, (p[i + c] / 255) * k + g)), 1 / 1.15);
    }
  }
  ctx.putImageData(img, 0, 0);

  // ---------- OCT volume (Spectralis-like log-compressed, 9-frame averaged speckle) ----------
  const w = 512, h = 400, d = 97, W = 6, L = 6, D = 2.0, um = (D * 1000) / h;
  const off = { x: 0.12, y: -0.08 }; // OCT scan centre relative to fovea (mm) — imperfect fixation
  const mask = document.createElement('canvas');
  mask.width = w; mask.height = d;
  const mctx = mask.getContext('2d');
  mctx.fillStyle = '#000'; mctx.fillRect(0, 0, w, d);
  mctx.setTransform((w - 1) / W, 0, 0, (d - 1) / L, (w - 1) / 2 + 0.5 - (off.x * (w - 1)) / W, (d - 1) / 2 + 0.5 - (off.y * (d - 1)) / L);
  strokeVessels(mctx, vessels, () => '#fff');
  const mdata = mctx.getImageData(0, 0, w, d).data;

  const SPK = 1 << 16, spk = new Float32Array(SPK);
  for (let i = 0; i < SPK; i++) { let s = 0; for (let j = 0; j < 9; j++) s -= Math.log(rng() + 1e-12); spk[i] = s / 9; }
  let seed = 12345;
  const nextSpk = () => { seed = (Math.imul(seed, 1103515245) + 12345) | 0; return spk[(seed >>> 8) & (SPK - 1)]; };

  const data = new Uint8Array(w * h * d);
  const col = new Float32Array(h), col2 = new Float32Array(h);
  for (let z = 0; z < d; z++) {
    const ymm = (z / (d - 1) - 0.5) * L, ry = ymm + off.y;
    for (let x = 0; x < w; x++) {
      const xmm = (x / (w - 1) - 0.5) * W, rx = xmm + off.x, r = Math.hypot(rx, ry);
      const fov = Math.exp(-((r / 0.4) ** 2)), q = (s) => 1 - Math.exp(-((r / s) ** 2));
      const bm = h * 0.7 - 1.4 * (xmm * xmm + ymm * ymm) + 2.0 * xmm;
      const ez = 40 + 10 * fov, elm = 64 + 12 * fov;
      const onlTop = elm + 45 + 105 * Math.exp(-((r / 0.75) ** 2));
      const oplTop = onlTop + 24 * q(0.35);
      const inlTop = oplTop + 40 * q(0.45);
      const iplTop = inlTop + 40 * q(0.45);
      const gclTop = iplTop + q(0.4) * (18 + 42 * Math.exp(-(((r - 1.0) / 0.65) ** 2)));
      const rnfl = q(0.6) * Math.min(70, 8 + 5 * r + 14 * Math.max(0, rx) + 6 * Math.abs(ry));
      const ilm = gclTop + rnfl;
      const chT = 270 + 80 * (fbm3(rx * 0.4, ry * 0.4, 7, 2) - 0.5);
      const cov = mdata[(z * w + x) * 4] / 255;
      const lumen = 110 * cov, uv = ilm - Math.min(rnfl, 25) * 0.5 - lumen * 0.5 - 5;
      for (let y = 0; y < h; y++) {
        const u = (bm - y) * um;
        let v;
        if (u > ilm) v = 0.0006;
        else if (u > gclTop) v = 0.55;
        else if (u > iplTop) v = 0.14;
        else if (u > inlTop) v = 0.33;
        else if (u > oplTop) v = 0.06;
        else if (u > onlTop) v = 0.3;
        else if (u > elm + 2) v = 0.035 + 0.025 * ((u - elm) / (onlTop - elm));
        else if (u > elm - 2) v = 0.26;
        else if (u > ez + 4) v = 0.07;
        else if (u > ez - 4) v = 0.78;
        else if (u > 29) v = 0.12;
        else if (u > 23) v = 0.42;
        else if (u > 16) v = 0.14;
        else if (u > 3) v = 0.92;
        else if (u >= 0) v = 0.6;
        else if (u > -chT) {
          if (u > -12) v = 0.36;
          else {
            const pn = fbm3(rx * 3.2, ry * 3.2, u * 0.012, 3);
            v = 0.06 + 0.32 * smooth(0.38, 0.62, pn) * (1 + 0.3 * (u / chT));
          }
        } else v = 0.1 * Math.exp((u + chT) / 250) + 0.015;
        if (u < ilm) v *= Math.exp(-(ilm - u) * 0.0017);
        if (cov > 0.02) {
          if (Math.abs(u - uv) < lumen / 2) v = Math.abs(u - uv) > lumen / 2 - 6 ? 0.5 : 0.28;
          else if (u < uv - lumen / 2) v *= 1 - 0.82 * cov;
        }
        col[y] = v;
      }
      for (let y = 0; y < h; y++) col2[y] = 0.25 * col[Math.max(0, y - 1)] + 0.5 * col[y] + 0.25 * col[Math.min(h - 1, y + 1)];
      const base = z * w * h + x;
      for (let y = 0; y < h; y++) {
        const I = col2[y] * nextSpk() + 0.0015 * nextSpk();
        const n = Math.min(1, Math.max(0, (10 * Math.log10(I) + 26) / 26));
        data[base + y * w] = Math.pow(n, 1.5) * 255;
      }
    }
    if (z % 4 === 0) { onProgress(0.25 + 0.75 * (z / d), `Synthesising OCT volume… B-scan ${z + 1}/${d}`); await nextFrame(); }
  }

  return {
    fundusCanvas: fundus, fovDeg, laterality: 'OD', axialLength: AL,
    volume: { w, h, d, data, widthMM: W, lengthMM: L, depthMM: D },
  };
}
