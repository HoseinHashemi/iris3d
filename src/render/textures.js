// Procedural textures for the anatomical eye (sclera, iris). UV layout matches LatheGeometry:
// u = azimuth around the optical axis, v = position along the lathe profile (canvas top = v 1).
import * as THREE from 'three';
import { mulberry32 } from '../synth/noise.js';

export function makeScleraTexture() {
  const W = 2048, H = 1024, rng = mulberry32(7);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#f3ece6');
  grad.addColorStop(0.06, '#efe6dc');
  grad.addColorStop(0.5, '#ece2d3');
  grad.addColorStop(1, '#e6d9c6');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // mottling
  for (let i = 0; i < 1400; i++) {
    const x = rng() * W, y = rng() * H, r = 8 + rng() * 60;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    const tone = rng() < 0.5 ? '255,250,240' : '214,196,170';
    rg.addColorStop(0, `rgba(${tone},${0.05 + rng() * 0.06})`);
    rg.addColorStop(1, `rgba(${tone},0)`);
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  // limbal pinkish band + episcleral / conjunctival vessels running posteriorly from the limbus
  const lg = g.createLinearGradient(0, 0, 0, H * 0.18);
  lg.addColorStop(0, 'rgba(225,160,150,0.35)');
  lg.addColorStop(1, 'rgba(225,160,150,0)');
  g.fillStyle = lg;
  g.fillRect(0, 0, W, H * 0.18);
  const vessel = (x, y, len, wid, alpha, depth) => {
    let h = Math.PI / 2 + (rng() - 0.5) * 0.6;
    g.strokeStyle = `rgba(${150 + rng() * 40},${25 + rng() * 25},${30 + rng() * 20},${alpha})`;
    g.lineCap = 'round';
    for (let i = 0; i < len; i++) {
      const nx = x + Math.cos(h) * 4, ny = y + Math.sin(h) * 4;
      g.lineWidth = wid * (1 - (i / len) * 0.7);
      g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
      x = nx; y = ny;
      h += (rng() - 0.5) * 0.5;
      h = Math.PI / 2 + Math.max(-1.1, Math.min(1.1, h - Math.PI / 2));
      if (depth < 2 && rng() < 0.04) vessel(x, y, len * 0.4, wid * 0.6, alpha * 0.9, depth + 1);
    }
  };
  for (let i = 0; i < 90; i++) vessel(rng() * W, H * (0.01 + rng() * 0.05), 40 + rng() * 90, 1.2 + rng() * 2.4, 0.25 + rng() * 0.35, 0);
  for (let i = 0; i < 40; i++) vessel(rng() * W, H * (0.1 + rng() * 0.4), 20 + rng() * 60, 0.8 + rng() * 1.2, 0.12 + rng() * 0.15, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

const IRIS = {
  brown: { base: '#3e2412', fiber: '#8a5a2e', inner: '#5a3416', coll: '#a87440', dark: '#1d0f06' },
  hazel: { base: '#4d4a26', fiber: '#8f8a4c', inner: '#7a4a1c', coll: '#b07a3a', dark: '#1e1a0b' },
  green: { base: '#3d5530', fiber: '#8fa868', inner: '#7a5a2a', coll: '#b4a06a', dark: '#16210f' },
  blue: { base: '#36557c', fiber: '#a8c2de', inner: '#4f6a8c', coll: '#d2c79c', dark: '#16243a' },
  grey: { base: '#596370', fiber: '#bcc5cf', inner: '#6f7883', coll: '#d0cdbb', dark: '#20262e' },
};

/** Iris texture: canvas y = 0 at the iris root (v=1), y = H at the pupil margin (v=0). */
export function makeIrisTexture(name = 'brown') {
  const p = IRIS[name] || IRIS.brown;
  const W = 1024, H = 256, rng = mulberry32(name.length * 991 + 3);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const yOf = (t) => (1 - t) * H; // t: 0 pupil → 1 root
  const grad = g.createLinearGradient(0, yOf(0), 0, yOf(1));
  grad.addColorStop(0, p.inner);
  grad.addColorStop(0.33, p.inner);
  grad.addColorStop(0.4, p.base);
  grad.addColorStop(0.9, p.base);
  grad.addColorStop(1, p.dark);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // radial stromal fibres (trabeculae)
  for (let i = 0; i < 1800; i++) {
    const x0 = rng() * W, t0 = rng() * 0.25, t1 = 0.45 + rng() * 0.55;
    const light = rng() < 0.62;
    g.strokeStyle = light ? p.fiber : p.dark;
    g.globalAlpha = (light ? 0.12 : 0.1) + rng() * 0.18;
    g.lineWidth = 0.6 + rng() * 1.8;
    g.beginPath();
    const amp = 3 + rng() * 6, ph = rng() * 6;
    for (let s = 0; s <= 12; s++) {
      const t = t0 + ((t1 - t0) * s) / 12;
      const x = x0 + Math.sin(ph + t * 9) * amp;
      s ? g.lineTo(x, yOf(t)) : g.moveTo(x, yOf(t));
    }
    g.stroke();
  }
  // crypts of Fuchs
  for (let i = 0; i < 70; i++) {
    const x = rng() * W, t = 0.3 + rng() * 0.4, rw = 4 + rng() * 12, rh = 3 + rng() * 10;
    g.globalAlpha = 0.25 + rng() * 0.3;
    g.fillStyle = p.dark;
    g.beginPath(); g.ellipse(x, yOf(t), rw, rh, 0, 0, Math.PI * 2); g.fill();
  }
  // collarette (jagged ring ~1/3 from the pupil)
  g.globalAlpha = 0.55;
  g.strokeStyle = p.coll;
  g.lineWidth = 5;
  g.beginPath();
  for (let x = 0; x <= W; x += 4) {
    const t = 0.36 + 0.03 * Math.sin(x * 0.07) + 0.015 * Math.sin(x * 0.31) + (rng() - 0.5) * 0.01;
    x ? g.lineTo(x, yOf(t)) : g.moveTo(x, yOf(t));
  }
  g.stroke();
  // circular contraction furrows
  g.strokeStyle = p.dark;
  g.lineWidth = 1.5;
  for (const tf of [0.72, 0.8, 0.88]) {
    g.globalAlpha = 0.25;
    g.beginPath();
    for (let x = 0; x <= W; x += 6) {
      const t = tf + 0.01 * Math.sin(x * 0.05 + tf * 20);
      x ? g.lineTo(x, yOf(t)) : g.moveTo(x, yOf(t));
    }
    g.stroke();
  }
  // pupillary ruff
  g.globalAlpha = 1;
  g.fillStyle = '#120804';
  g.beginPath();
  g.moveTo(0, H);
  for (let x = 0; x <= W; x += 3) g.lineTo(x, yOf(0.035 + 0.012 * Math.abs(Math.sin(x * 0.4)) + rng() * 0.008));
  g.lineTo(W, H);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}
