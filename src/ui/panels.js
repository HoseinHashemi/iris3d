import { state, LAYERS, octToFundusMM, fundusMMToPx, fundusMMPerPx, octXmm, octZmm } from '../state.js';
import { thicknessColor } from '../util.js';

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  return { W, H, dpr };
}
function message(ctx, W, H, dpr, text) {
  ctx.fillStyle = '#5d6c7e';
  ctx.font = `${12 * dpr}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, H / 2);
  ctx.textAlign = 'left';
}

/** En-face projection used for registration before segmentation exists. */
export function enfaceCanvas() {
  const vol = state.volume;
  if (!vol) return null;
  const { w, h, d, data } = vol;
  const c = document.createElement('canvas');
  c.width = w; c.height = d;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, d);
  let vals = state.analysis?.enface;
  if (!vals) {
    vals = new Float32Array(w * d);
    let mx = 1;
    for (let k = 0; k < d; k++) for (let i = 0; i < w; i++) {
      let s = 0;
      for (let y = 0; y < h; y += 2) s += data[k * w * h + y * w + i];
      vals[k * w + i] = s; if (s > mx) mx = s;
    }
    for (let i = 0; i < vals.length; i++) vals[i] /= mx;
  }
  let lo = 1, hi = 0;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let i = 0; i < w * d; i++) {
    const v = Math.pow((vals[i] - lo) / Math.max(1e-6, hi - lo), 0.9) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function thicknessCanvas() {
  const a = state.analysis, vol = state.volume;
  if (!a) return null;
  const { w, d } = vol;
  const c = document.createElement('canvas');
  c.width = w; c.height = d;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, d);
  for (let i = 0; i < w * d; i++) {
    const col = thicknessColor(a.thickness[i]);
    img.data[i * 4] = col[0] * 255; img.data[i * 4 + 1] = col[1] * 255; img.data[i * 4 + 2] = col[2] * 255; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ------------------------------------------------------------------ B-scan viewer
export class BscanPanel {
  constructor(canvas, onDraw, onEdit) {
    this.canvas = canvas;
    this.native = document.createElement('canvas');
    this.overlay = true;
    this.onDraw = onDraw;
    this.onEdit = onEdit;
    this.editLayer = null;
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
    // manual correction: drag along the boundary to redraw it on this B-scan
    let last = null;
    const toNative = (e) => {
      const r = canvas.getBoundingClientRect(), dpr = canvas.width / r.width, v = this.view;
      return { x: ((e.clientX - r.left) * dpr - v.ox) / v.sx, y: ((e.clientY - r.top) * dpr - v.oy) / v.sy + v.top };
    };
    const paint = (p) => {
      const vol = state.volume, S = state.seg.surfaces[this.editLayer], z = state.slice, w = vol.w;
      const a = last || p;
      const x0 = Math.round(Math.min(a.x, p.x)), x1 = Math.round(Math.max(a.x, p.x));
      for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
        const t = x1 === x0 ? 1 : (x - a.x) / (p.x - a.x);
        S[z * w + x] = Math.max(0, Math.min(vol.h - 1, a.y + (p.y - a.y) * Math.min(1, Math.max(0, t))));
      }
      last = p;
      this.draw();
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.editLayer || !state.seg || !this.view) return;
      canvas.setPointerCapture(e.pointerId);
      last = null; paint(toNative(e));
    });
    canvas.addEventListener('pointermove', (e) => { if (last && this.editLayer) paint(toNative(e)); });
    canvas.addEventListener('pointerup', () => {
      if (!last) return;
      last = null;
      const { w } = state.volume, z = state.slice, keys = LAYERS.map((l) => l.key), S = state.seg.surfaces;
      const ei = keys.indexOf(this.editLayer);
      for (let x = 0; x < w; x++) {
        const i = z * w + x;
        for (let j = ei - 1; j >= 0; j--) if (S[keys[j]][i] > S[keys[j + 1]][i]) S[keys[j]][i] = S[keys[j + 1]][i];
        for (let j = ei + 1; j < keys.length; j++) if (S[keys[j]][i] < S[keys[j - 1]][i]) S[keys[j]][i] = S[keys[j - 1]][i];
      }
      state.seg.edited = true;
      this.onEdit?.();
    });
  }
  draw() {
    const { W, H, dpr } = fitCanvas(this.canvas);
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const vol = state.volume;
    if (!vol) return message(ctx, W, H, dpr, 'Load OCT B-scans or the demo case');
    const { w, h, d, data } = vol;
    const z = Math.max(0, Math.min(d - 1, state.slice));
    const n = this.native;
    if (n.width !== w || n.height !== h) { n.width = w; n.height = h; }
    const nctx = n.getContext('2d');
    const img = nctx.createImageData(w, h);
    const off = z * w * h;
    for (let i = 0; i < w * h; i++) { const v = data[off + i]; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    nctx.putImageData(img, 0, 0);
    if (state.seg && this.overlay) {
      nctx.lineWidth = Math.max(1.2, w / 380);
      for (const L of LAYERS) {
        if (!state.layersVisible[L.key]) continue;
        const S = state.seg.surfaces[L.key];
        nctx.strokeStyle = L.color;
        nctx.globalAlpha = 0.9;
        nctx.beginPath();
        for (let x = 0; x < w; x++) { const y = S[z * w + x] + 0.5; x ? nctx.lineTo(x + 0.5, y) : nctx.moveTo(0.5, y); }
        nctx.stroke();
      }
      nctx.globalAlpha = 1;
    }
    // crop empty vitreous above the retina, allow up to 2.5× horizontal stretch (as clinical viewers do)
    let top = 0;
    if (state.seg) {
      let mn = h;
      for (let x = 0; x < w * d; x += 7) mn = Math.min(mn, state.seg.surfaces.ILM[x]);
      top = Math.max(0, Math.floor(mn - h * 0.06));
    }
    const ch = h - top;
    const sy = Math.min(H / ch, W / w), sx = Math.min(W / w, sy * 2.5);
    const s = sy, dw = w * sx, dh = ch * sy, ox = (W - dw) / 2, oy = (H - dh) / 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(n, 0, top, w, ch, ox, oy, dw, dh);
    this.view = { ox, oy, sx, sy, top };
    // scale bars: 200 µm depth, 1 mm lateral
    const pxPerUm = h / (vol.depthMM * 1000), pxPerMM = (w - 1) / vol.widthMM;
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 2 * dpr;
    ctx.font = `${10.5 * dpr}px Inter, system-ui, sans-serif`;
    const bx = ox + dw - 12 * dpr, by = oy + dh - 12 * dpr;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx, by - 200 * pxPerUm * s); ctx.moveTo(bx, by); ctx.lineTo(bx - pxPerMM * sx, by); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText('1 mm', bx - 4 * dpr, by - 5 * dpr);
    ctx.save(); ctx.translate(bx - 5 * dpr, by - 200 * pxPerUm * s); ctx.fillText('200 µm', 0, 12 * dpr); ctx.restore();
    ctx.textAlign = 'left';
    this.onDraw?.(n);
  }
}

// ------------------------------------------------------------------ thickness / en-face map with ETDRS grid
export class MapPanel {
  constructor(canvas, onPick) {
    this.canvas = canvas;
    this.mode = 'thickness';
    this.onPick = onPick;
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
    canvas.addEventListener('click', (e) => {
      if (!this.rect || !state.volume) return;
      const r = canvas.getBoundingClientRect(), dpr = canvas.width / r.width;
      const y = (e.clientY - r.top) * dpr;
      const t = (y - this.rect.y) / this.rect.h;
      if (t >= 0 && t <= 1) this.onPick(Math.round(t * (state.volume.d - 1)));
    });
  }
  draw() {
    const { W, H, dpr } = fitCanvas(this.canvas);
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const vol = state.volume;
    if (!vol) return message(ctx, W, H, dpr, 'No OCT');
    const src = this.mode === 'thickness' ? thicknessCanvas() : enfaceCanvas();
    if (!src) return message(ctx, W, H, dpr, 'Run segmentation');
    const pad = 10 * dpr, aspect = vol.widthMM / vol.lengthMM;
    let dw = W - 2 * pad, dh = dw / aspect;
    if (dh > H - 2 * pad) { dh = H - 2 * pad; dw = dh * aspect; }
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    this.rect = { x: ox, y: oy, w: dw, h: dh };
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, ox, oy, dw, dh);
    const mx = (x) => ox + (x / vol.widthMM + 0.5) * dw, mz = (z) => oy + (z / vol.lengthMM + 0.5) * dh;
    const sx = dw / vol.widthMM, sz = dh / vol.lengthMM;
    // slice indicator
    const zs = octZmm(state.slice);
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.2 * dpr; ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(ox, mz(zs)); ctx.lineTo(ox + dw, mz(zs)); ctx.stroke(); ctx.setLineDash([]);
    const a = state.analysis;
    if (!a) return;
    const fx = mx(a.fovea.x), fz = mz(a.fovea.z);
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, dw, dh); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.2 * dpr;
    for (const r of [0.5, 1.5, 3]) { ctx.beginPath(); ctx.ellipse(fx, fz, r * sx, r * sz, 0, 0, Math.PI * 2); ctx.stroke(); }
    for (const ang of [45, 135, 225, 315]) {
      const c = Math.cos((ang * Math.PI) / 180), s = Math.sin((ang * Math.PI) / 180);
      ctx.beginPath(); ctx.moveTo(fx + c * 0.5 * sx, fz + s * 0.5 * sz); ctx.lineTo(fx + c * 3 * sx, fz + s * 3 * sz); ctx.stroke();
    }
    if (this.mode === 'thickness') {
      ctx.font = `600 ${10.5 * dpr}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const nasal = state.laterality === 'OD' ? 1 : -1;
      const put = (key, dx, dz) => {
        const v = a.sectors[key];
        if (!Number.isFinite(v)) return;
        ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillText(Math.round(v), fx + dx * sx + dpr, fz + dz * sz + dpr);
        ctx.fillStyle = '#fff'; ctx.fillText(Math.round(v), fx + dx * sx, fz + dz * sz);
      };
      put('C', 0, 0);
      put('S1', 0, -1); put('I1', 0, 1); put('N1', nasal, 0); put('T1', -nasal, 0);
      put('S3', 0, -2.25); put('I3', 0, 2.25); put('N3', 2.25 * nasal, 0); put('T3', -2.25 * nasal, 0);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
    // orientation labels
    ctx.fillStyle = '#8494a7'; ctx.font = `${10 * dpr}px Inter, system-ui, sans-serif`;
    const nasalRight = state.laterality === 'OD';
    ctx.fillText(nasalRight ? 'T' : 'N', ox - 8 * dpr, oy + dh / 2);
    ctx.fillText(nasalRight ? 'N' : 'T', ox + dw + 2 * dpr, oy + dh / 2);
    ctx.fillText('S', ox + dw / 2 - 3 * dpr, oy - 1 * dpr);
  }
}

// ------------------------------------------------------------------ fundus registration
export class RegPanel {
  constructor(canvas, onPick) {
    this.canvas = canvas;
    this.mode = null;
    this.alpha = 0.55;
    this.onPick = onPick;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('click', (e) => {
      if (!this.mode || !state.fundus || !this.scale) return;
      const r = canvas.getBoundingClientRect(), dpr = canvas.width / r.width;
      const p = { x: ((e.clientX - r.left) * dpr) / this.scale, y: ((e.clientY - r.top) * dpr) / this.scale };
      this.onPick(this.mode, p);
    });
  }
  draw() {
    const f = state.fundus, c = this.canvas;
    const cssW = c.getBoundingClientRect().width || 320;
    c.style.height = `${f ? (cssW * f.height) / f.width : cssW * 0.75}px`;
    const { W, H, dpr } = fitCanvas(c);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!f) return message(ctx, W, H, dpr, 'Load a fundus photo or the demo case');
    const s = (this.scale = W / f.width);
    ctx.drawImage(f.canvas, 0, 0, W, H);
    const vol = state.volume;
    if (vol) {
      const ef = enfaceCanvas();
      const mapPx = (u, v) => {
        const xo = octXmm(u - 0.5), zo = octZmm(v - 0.5);
        const p = fundusMMToPx(octToFundusMM(xo, zo));
        return { x: p.x * s, y: p.y * s };
      };
      const o = mapPx(0, 0), ex = mapPx(1, 0), ez = mapPx(0, 1);
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.setTransform(ex.x - o.x, ex.y - o.y, ez.x - o.x, ez.y - o.y, o.x, o.y);
      ctx.drawImage(ef, 0, 0);
      ctx.restore();
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 1.5 * dpr;
      const corners = [mapPx(0, 0), mapPx(vol.w, 0), mapPx(vol.w, vol.d), mapPx(0, vol.d)];
      ctx.beginPath(); corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
      const k = fundusMMPerPx(), c0 = fundusMMToPx(octToFundusMM(state.analysis?.fovea.x ?? 0, state.analysis?.fovea.z ?? 0));
      ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1 * dpr;
      for (const r of [0.5, 1.5, 3]) { ctx.beginPath(); ctx.arc(c0.x * s, c0.y * s, (r / k) * s, 0, Math.PI * 2); ctx.stroke(); }
    }
    // landmarks
    const fx = f.fovea.x * s, fy = f.fovea.y * s;
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(fx - 9 * dpr, fy); ctx.lineTo(fx + 9 * dpr, fy); ctx.moveTo(fx, fy - 9 * dpr); ctx.lineTo(fx, fy + 9 * dpr); ctx.stroke();
    if (f.disc) {
      const r = (0.9 / fundusMMPerPx()) * s;
      ctx.strokeStyle = '#7ee2a8';
      ctx.beginPath(); ctx.arc(f.disc.x * s, f.disc.y * s, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = '#d9e2ec'; ctx.font = `${10.5 * dpr}px Inter, system-ui, sans-serif`;
    ctx.fillText(`${f.fovDeg}° FOV · ${(fundusMMPerPx() * 1000).toFixed(1)} µm/px`, 8 * dpr, H - 8 * dpr);
  }
}

export function renderStats(el) {
  const a = state.analysis;
  if (!a) { el.innerHTML = '<div class="status">Run segmentation to compute statistics.</div>'; return; }
  const s = a.sectors, f = (v) => (Number.isFinite(v) ? Math.round(v) : '–');
  const rows = [
    ['Central subfield (CST)', `${f(s.C)} µm`, true],
    ['Central point', `${f(a.centralPoint)} µm`],
    ['Inner ring S / N / I / T', `${f(s.S1)} / ${f(s.N1)} / ${f(s.I1)} / ${f(s.T1)}`],
    ['Outer ring S / N / I / T', `${f(s.S3)} / ${f(s.N3)} / ${f(s.I3)} / ${f(s.T3)}`],
    ['Macular volume (6 mm)', `${a.macularVolume.toFixed(2)} mm³${a.coverage < 0.98 ? '*' : ''}`, true],
    ['Min / mean / max', `${f(a.tMin)} / ${f(a.tMean)} / ${f(a.tMax)} µm`],
    ['Fovea offset from scan centre', `${a.fovea.x.toFixed(2)}, ${a.fovea.z.toFixed(2)} mm`],
    ['Axial pixel size', `${a.umPerPx.toFixed(2)} µm`],
  ];
  const c = state.comparison;
  if (c) {
    const da = c.devAnalysis.sectors, r = c.reported;
    const ref = state.refLabel || 'device';
    rows.push([`— vs ${ref} segmentation —`, '']);
    for (const [k, st] of Object.entries(c.layers)) {
      if (!st) continue;
      const note = k === 'RPE' || k === 'EZ' ? ' †' : '';
      rows.push([`${k}${note} bias / MAE / P95`, `${st.bias.toFixed(1)} / ${st.mae.toFixed(1)} / ${st.p95.toFixed(0)} µm`]);
    }
    if (c.thickness) rows.push(['Thickness bias / MAE / P95', `${c.thickness.bias.toFixed(1)} / ${c.thickness.mae.toFixed(1)} / ${c.thickness.p95.toFixed(0)} µm`, true]);
    rows.push([`CST: OcuForm / ${ref}`, `${f(s.C)} / ${f(da.C)} µm`, true]);
    if (r && Number.isFinite(r.C)) rows.push(['CST reported by device', `${f(r.C)} µm`]);
    if (r && Number.isFinite(r.volume)) rows.push(['Volume reported by device', `${r.volume.toFixed(2)} mm³`]);
  }
  el.innerHTML = `<table class="etdrs-table">${rows.map(([k, v, hl]) => `<tr class="${hl ? 'hl' : ''}"><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
  ${c ? `<div class="status" style="margin-top:6px">† Different boundary definition (OcuForm: band centre; ${state.refLabel || 'device'}: band edge), so a constant offset is expected.</div>` : ''}
  ${a.coverage < 0.98 ? `<div class="status" style="margin-top:6px">* ETDRS 6 mm circle only ${(a.coverage * 100).toFixed(0)}% covered by the scan.</div>` : ''}`;
}
