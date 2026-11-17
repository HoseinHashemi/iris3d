// Central application state + coordinate transforms.
//
// Coordinate conventions (all lengths in mm):
//  • OCT volume: x = along B-scan (left→right), z = across B-scans (superior→inferior),
//    both centred on the scan centre. Depth is in pixels (row index) inside the volume.
//  • Fundus mm: relative to the fundus fovea, x right, y down (image orientation).
//  • Eye model: origin at the globe centre, +z anterior (towards cornea), +y up, +x to viewer's right
//    when looking at the patient's face.

export const LAYERS = [
  { key: 'ILM', name: 'ILM', color: '#ff5a5f' },
  { key: 'RNFL', name: 'RNFL/GCL', color: '#ffd23f' },
  { key: 'EZ', name: 'Ellipsoid zone', color: '#3fd0ff' },
  { key: 'RPE', name: 'RPE', color: '#5cff8a' },
  { key: 'BM', name: "Bruch's memb.", color: '#c77dff' },
];

export const state = {
  fundus: null,     // { canvas, width, height, fovea:{x,y}, disc:{x,y}|null, fovDiamPx, fovDeg }
  volume: null,     // { w, h, d, data:Uint8Array, widthMM, lengthMM, depthMM }
  seg: null,        // { surfaces:{ILM:Float32Array(w*d) ...} } depth in pixel rows
  analysis: null,   // see processing/analysis.js
  reg: { dx: 0, dy: 0, rot: 0, scale: 1 },
  geom: null,       // device B-scan positions on the SLO: { start:[{x,y}], end:[{x,y}], sloScale } (mm)
  deviceSeg: null,  // device (e.g. Heidelberg) layer segmentation, same layout as seg.surfaces
  deviceStats: null,// device-reported ETDRS values (µm) + volume (mm³), when the export contains them
  laterality: 'OD',
  axialLength: 23.6,
  slice: 0,
  layersVisible: { ILM: true, RNFL: true, EZ: true, RPE: true, BM: true },
};

const listeners = {};
export function on(evt, fn) { (listeners[evt] ||= []).push(fn); }
export function emit(evt, payload) { (listeners[evt] || []).forEach((fn) => fn(payload)); }

/** Retinal mm per visual degree (Bennett's formula, scales with axial length). */
export function mmPerDeg(AL = state.axialLength) { return 0.01306 * (AL - 1.82); }

export function fundusMMPerPx() {
  const f = state.fundus;
  if (f.mmPerPx) return f.mmPerPx;
  return (f.fovDeg * mmPerDeg()) / f.fovDiamPx;
}

export function octFovea() { return state.analysis?.fovea ?? { x: 0, z: 0 }; }

/** Exact device geometry available for the current fundus (it is the SLO acquired with the OCT). */
export const hasGeom = () => !!(state.geom && state.fundus?.isSlo && state.volume);

/** OCT (x, z) mm → SLO pixel using the recorded start/end of every B-scan. */
export function geomPx(xo, zo) {
  const { start, end, sloScale } = state.geom, v = state.volume, d = start.length;
  const kf = Math.min(d - 1, Math.max(0, d > 1 ? (zo / v.lengthMM + 0.5) * (d - 1) : 0));
  const k0 = Math.floor(kf), k1 = Math.min(d - 1, k0 + 1), f = kf - k0;
  const sx = start[k0].x + (start[k1].x - start[k0].x) * f, sy = start[k0].y + (start[k1].y - start[k0].y) * f;
  const ex = end[k0].x + (end[k1].x - end[k0].x) * f, ey = end[k0].y + (end[k1].y - end[k0].y) * f;
  const t = xo / v.widthMM + 0.5;
  return { x: (sx + (ex - sx) * t) / sloScale, y: (sy + (ey - sy) * t) / sloScale };
}

/** OCT (x, z) mm → fundus mm relative to the fundus fovea (manual adjustment applied on top). */
export function octToFundusMM(xo, zo) {
  const f = octFovea();
  const { dx, dy, rot, scale } = state.reg;
  const c = Math.cos((rot * Math.PI) / 180), s = Math.sin((rot * Math.PI) / 180);
  if (hasGeom()) {
    const fp = state.fundus.fovea, k = fundusMMPerPx();
    const p = geomPx(xo, zo), p0 = geomPx(f.x, f.z);
    const ax = (p0.x - fp.x) * k, ay = (p0.y - fp.y) * k;
    const qx = (p.x - p0.x) * k * scale, qy = (p.y - p0.y) * k * scale;
    return { x: ax + c * qx - s * qy + dx, y: ay + s * qx + c * qy + dy };
  }
  const px = (xo - f.x) * scale, pz = (zo - f.z) * scale;
  return { x: c * px - s * pz + dx, y: s * px + c * pz + dy };
}

export function fundusMMToPx(m) {
  const f = state.fundus, k = fundusMMPerPx();
  return { x: f.fovea.x + m.x / k, y: f.fovea.y + m.y / k };
}

export function fundusPxToMM(p) {
  const f = state.fundus, k = fundusMMPerPx();
  return { x: (p.x - f.fovea.x) * k, y: (p.y - f.fovea.y) * k };
}

/** Optic disc centre in fundus mm (from the photo when available, else population average). */
export function discMM() {
  if (state.fundus?.disc) return fundusPxToMM(state.fundus.disc);
  return { x: state.laterality === 'OD' ? 4.3 : -4.3, y: -0.3 };
}

export function octXmm(i, w = state.volume.w) { return (i / Math.max(1, w - 1) - 0.5) * state.volume.widthMM; }
export function octZmm(k, d = state.volume.d) { return d > 1 ? (k / (d - 1) - 0.5) * state.volume.lengthMM : 0; }
