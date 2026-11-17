// Visual pathway scene (visualisation only): both globes with extraocular muscles, optic nerves,
// chiasm, optic tracts, lateral geniculate nuclei, optic radiations (incl. Meyer's loop) and the
// striate cortex, inside a translucent brain with ventricles and the circle of Willis.
//
// Head frame, millimetres: origin at the centre of the optic chiasm, +x = patient's LEFT,
// +y = superior, +z = anterior (the eye model's optical axis). Dimensions follow standard adult
// anatomy: IPD 63 mm; optic nerve ≈ 1 + 25 (orbital, slack S-curve) + 9 (canalicular) + 12 mm
// (intracranial); chiasm 13 × 8 × 4 mm tilted ~20°; optic tract ≈ 30 mm to the LGN; rectus
// insertions on the spiral of Tillaux (MR 5.5, IR 6.5, LR 6.9, SR 7.7 mm from the limbus);
// brain ≈ 165 × 132 × 115 mm. Landmark positions are taken from MNI-space atlases, re-centred
// on the chiasm. Retinal ganglion axons and geniculo-calcarine fibres are drawn as tractography
// streamlines coloured by visual hemifield, following known retinotopy (nasal fibres decussate,
// superior-field fibres run in Meyer's loop to the lower calcarine bank, the macula maps to the
// occipital pole).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EyeModel } from './eye.js';
import { Grid, tubeSamples, sdEllipsoid, smin, smax, smoothstep, noise3, taubinSmooth } from './sdf.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const mir = (p, s) => V(p[0] * s, p[1], p[2]);
const UP = V(0, 1, 0);

// ---------------------------------------------------------------- anatomical landmarks (left side, x>0)
const EYE_C = [31.5, -6, 55];
const APEX = [11.5, -4.8, 22]; // orbital opening of the optic canal (annulus of Zinn)
const NERVE_CTRL = [[24, -5.2, 37], [18, -5.8, 29.5], APEX, [8, -3.5, 13.5], [4.6, -0.9, 4.2], [2.2, -0.2, 1.2]];
const NERVE_R = [[2.9, 2.9], [2.75, 2.75], [2.45, 2.45], [2.3, 2.3], [2.1, 2.1], [2.2, 1.8], [2.7, 1.5], [2.6, 1.4]];
const TRACT_CTRL = [[4.5, 0.9, -3.5], [9, 2, -10], [13.8, 3.2, -16], [18.2, 4.8, -21], [21.3, 6.4, -25], [22.6, 7.4, -27.5]];
const TRACT_R = [[2.6, 1.5], [2.6, 1.35], [2.4, 1.25], [2.2, 1.2], [2.0, 1.15], [1.6, 1.1]];
const LGN = [23, 8.2, -28.5];
const calcY = (z) => 14 - (z + 62) * 0.095; // calcarine fissure height on the medial occipital surface

// ---------------------------------------------------------------- brain SDF
const ell = sdEllipsoid;
function orbitCarve(ax, y, z) {
  // cone from the globe to the orbital apex (keeps the frontal lobes on the orbital roofs)
  const a = [31.5, -6, 64], b = [11.5, -4.8, 22];
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2], L2 = bx * bx + by * by + bz * bz;
  const t = Math.min(1, Math.max(0, ((ax - a[0]) * bx + (y - a[1]) * by + (z - a[2]) * bz) / L2));
  return Math.hypot(ax - a[0] - t * bx, y - a[1] - t * by, z - a[2] - t * bz) - (18 - 13 * t);
}
function cerebrum(x, y, z, out) {
  const ax = Math.abs(x);
  const F = ell(ax, y, z, [29, 34, 12], [31, 46, 46]);
  const Pa = ell(ax, y, z, [33, 46, -35], [33, 44, 46]);
  const O = ell(ax, y, z, [24, 28, -70], [24, 30, 36]);
  const T = ell(ax, y, z, [43, -4, -20], [20, 19, 36]);
  const FP = smin(smin(F, Pa, 14), O, 12);
  let d = smin(FP, T, 7);
  d = smax(d, -orbitCarve(ax, y, z), 5);
  d = smax(d, 1.1 - ax, 1.2); // interhemispheric fissure
  if (out) {
    // Sylvian fissure: the seam between temporal and fronto-parietal opercula
    out.syl = d > -12 ? Math.max(0, 1 - Math.abs(FP - T) / 2.4) * smoothstep(-12, -4, d) * (y > -14 && ax > 22 ? 1 : 0) : 0;
  }
  return d;
}
function sulcusField(x, y, z, syl) {
  const ax = Math.abs(x);
  // gyral pattern: zero-crossings of domain-warped gradient noise (~10 mm gyri)
  const q = 1 / 14, X = x * q, Y = y * q, Z = z * q;
  const wx = noise3(X * 0.55 + 5.2, Y * 0.55 + 1.3, Z * 0.55 + 7.1), wy = noise3(X * 0.55 + 2.8, Y * 0.55 + 9.4, Z * 0.55 + 3.3);
  const n = noise3(X + 0.9 * wx, Y + 0.9 * wy, Z + 0.9 * wx);
  let g = Math.exp(-((n / 0.11) ** 2)) * 0.9; // bell-shaped sulcus → rounded gyral crowns
  // central sulcus (vertex → Sylvian), parieto-occipital and calcarine sulci, Sylvian fissure
  if (y > 16) {
    const zc = -5 - (y - 20) * 0.27 + 2.2 * Math.sin(y / 5.5) + ax * 0.05;
    g = Math.max(g, Math.exp(-(((z - zc) / 2.0) ** 2)));
  }
  if (ax < 13 && y > 10) {
    const zpo = -60 + (y - 20) * 0.55;
    g = Math.max(g, Math.exp(-(((z - zpo) / 2.0) ** 2)) * smoothstep(13, 6, ax));
  }
  if (ax < 15 && z < -58) g = Math.max(g, Math.exp(-(((y - calcY(z)) / 2.2) ** 2)) * smoothstep(15, 7, ax));
  return Math.max(g, syl);
}
const cerebellum = (x, y, z) => smin(smin(ell(x, y, z, [21, -21, -72], [26, 16, 24]), ell(x, y, z, [-21, -21, -72], [26, 16, 24]), 8), ell(x, y, z, [0, -18, -76], [10, 15, 20]), 6);
function brainstem(x, y, z) {
  const cap = (a, b, r) => {
    const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
    const t = Math.min(1, Math.max(0, ((x - a[0]) * bx + (y - a[1]) * by + (z - a[2]) * bz) / (bx * bx + by * by + bz * bz)));
    return Math.hypot(x - a[0] - t * bx, y - a[1] - t * by, z - a[2] - t * bz) - (r[0] + t * (r[1] - r[0]));
  };
  const mid = cap([0, 9, -25], [0, -6, -26], [12, 11]);
  const pons = ell(x, y, z, [0, -17, -26], [15, 12, 12]);
  const med = cap([0, -27, -31], [0, -60, -38], [9, 6]);
  return smin(smin(mid, pons, 5), med, 5);
}

// ---------------------------------------------------------------- shaders
const brainVert = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
attribute vec3 aInfo;
varying vec3 vN; varying vec3 vW; varying vec3 vInfo;
void main() {
  vInfo = aInfo;
  vN = normalize(mat3(modelMatrix) * normal);
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
}`;
const brainFrag = /* glsl */ `
uniform float uOpacity; uniform float uSolid;
uniform vec3 uCortex; uniform vec3 uDeep; uniform vec3 uCbl; uniform vec3 uStem; uniform vec3 uV1;
varying vec3 vN; varying vec3 vW; varying vec3 vInfo;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  float sulc = vInfo.x, region = vInfo.y, v1 = vInfo.z;
  vec3 base = mix(uCortex, uDeep, sulc);
  if (region > 0.5 && region < 1.5) {
    vec3 q = vW - vec3(0., -2., -38.);
    float f = sin(length(q.yz) * 4.6 + 0.9 * sin(q.x * 0.22) + 0.4 * sin(q.x * 0.61 + q.y * 0.3));   // cerebellar folia (fine transverse fissures)
    base = uCbl * (1.0 - 0.32 * smoothstep(0.55, 0.95, f));
  } else if (region > 1.5) base = uStem;
  base = mix(base, uV1, v1 * 0.8);
  vec3 L1 = normalize(vec3(0.45, 0.8, 0.55)), L2 = normalize(vec3(-0.6, 0.15, -0.6));
  float d1 = max(dot(N, L1), 0.), d2 = max(dot(N, L2), 0.);
  float sp = pow(max(dot(N, normalize(L1 + V)), 0.), 36.) * 0.22;
  vec3 col = base * (0.28 + 0.8 * d1 + 0.3 * d2) + sp;
  if (!gl_FrontFacing) col *= 0.5;
  float fres = pow(1. - abs(dot(N, V)), 2.2);
  float a = uSolid > 0.5 ? 1. : clamp(uOpacity * (0.4 + 1.7 * fres) + v1 * uOpacity * 0.9, 0., 1.);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function striationTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#e8e8e8'; g.fillRect(0, 0, 512, 128);
  for (let i = 0; i < 700; i++) {
    const y = Math.random() * 128, l = 40 + Math.random() * 300, x = Math.random() * 512, v = 150 + Math.random() * 105;
    g.strokeStyle = `rgba(${v},${v},${v},0.55)`; g.lineWidth = 0.6 + Math.random() * 1.6;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + l, y + (Math.random() - 0.5) * 3); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Sweep an elliptical cross-section along a centreline (arc-length parametrised). */
function sweep(ctrl, prof, { up = () => UP, seg = 96, rad = 20, color = null, uvLen = 20 } = {}) {
  const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
  const len = curve.getLength();
  const pos = [], nrm = [], uv = [], col = [], idx = [];
  const c = new THREE.Color();
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, p = curve.getPointAt(t), T = curve.getTangentAt(t);
    const [hw, hh] = prof(t);
    const S = new THREE.Vector3().crossVectors(T, up(p, t)).normalize(), U = new THREE.Vector3().crossVectors(S, T).normalize();
    if (color) c.set(color(t));
    for (let j = 0; j <= rad; j++) {
      const a = (j / rad) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      pos.push(p.x + S.x * ca * hw + U.x * sa * hh, p.y + S.y * ca * hw + U.y * sa * hh, p.z + S.z * ca * hw + U.z * sa * hh);
      const n = S.clone().multiplyScalar(ca / Math.max(hw, 1e-3)).addScaledVector(U, sa / Math.max(hh, 1e-3)).normalize();
      nrm.push(n.x, n.y, n.z);
      uv.push((t * len) / uvLen, j / rad);
      if (color) col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < rad; j++) {
    const a = i * (rad + 1) + j, b = a + rad + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
const lerpTable = (tab) => (t) => {
  for (let i = 1; i < tab.length; i++) if (t <= tab[i][0]) {
    const [t0, ...a] = tab[i - 1], [t1, ...b] = tab[i], w = (t - t0) / (t1 - t0);
    return a.map((v, k) => v + w * (b[k] - v));
  }
  return tab[tab.length - 1].slice(1);
};

/** Many thin tubes merged into one geometry (tractography streamlines). */
function streamlines(fibres, radius, rad = 5) {
  let nv = 0;
  for (const f of fibres) nv += f.pts.length * rad;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = [];
  let v = 0;
  const S = new THREE.Vector3(), U = new THREE.Vector3(), T = new THREE.Vector3(), prevS = new THREE.Vector3();
  for (const f of fibres) {
    const P = f.pts, n = P.length, start = v;
    for (let i = 0; i < n; i++) {
      T.subVectors(P[Math.min(n - 1, i + 1)], P[Math.max(0, i - 1)]).normalize();
      if (i === 0) { S.crossVectors(T, Math.abs(T.y) < 0.9 ? UP : V(1, 0, 0)).normalize(); }
      else { S.copy(prevS).addScaledVector(T, -prevS.dot(T)).normalize(); } // parallel transport
      prevS.copy(S);
      U.crossVectors(S, T);
      const r = radius * (i === 0 || i === n - 1 ? 0.3 : 1);
      for (let j = 0; j < rad; j++) {
        const a = (j / rad) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const nx = S.x * ca + U.x * sa, ny = S.y * ca + U.y * sa, nz = S.z * ca + U.z * sa;
        pos[v * 3] = P[i].x + nx * r; pos[v * 3 + 1] = P[i].y + ny * r; pos[v * 3 + 2] = P[i].z + nz * r;
        nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz;
        const cc = f.colors ? f.colors[i] : f.color;
        col[v * 3] = cc.r; col[v * 3 + 1] = cc.g; col[v * 3 + 2] = cc.b;
        v++;
      }
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < rad; j++) {
      const a = start + i * rad + j, b = start + i * rad + ((j + 1) % rad), c = a + rad, d = b + rad;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  return g;
}

// deterministic PRNG so the model is identical on every load
function rng(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// visual-field colour code
const FIELD_COL = {
  L: { up: new THREE.Color('#ffb547'), lo: new THREE.Color('#ff4f38') },
  R: { up: new THREE.Color('#5fe0ff'), lo: new THREE.Color('#3d6bff') },
};

export class VisualPathway {
  constructor() {
    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.brainClip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e4);
    this.parts = {};
    this.labels = [];
    const t0 = performance.now();
    this.buildEyes();
    this.buildMuscles();
    this.buildOpticApparatus();
    this.buildFibres();
    this.buildArteries();
    this.buildVentricles();
    this.buildBrain();
    this.buildLabels();
    this.buildLesion();
    this.buildTime = performance.now() - t0;
  }

  group(name) { const g = new THREE.Group(); g.name = name; this.root.add(g); this.parts[name] = g; return g; }

  // ------------------------------------------------------------ globes
  buildEyes() {
    const G = this.group('eyes');
    this.eyes = {};
    for (const s of [1, -1]) {
      const e = new EyeModel();
      e.setCut(0);
      e.setDisc({ x: -4.3 * s, y: -0.3 }); // disc is nasal: OS (s=+1) nasal = −x
      e.nerve.visible = false;
      e.setAxialLength(23.6);
      e.group.position.copy(mir(EYE_C, s));
      G.add(e.group);
      this.eyes[s > 0 ? 'OS' : 'OD'] = e;
    }
    this.root.updateMatrixWorld(true);
  }
  setIris(name) { for (const e of Object.values(this.eyes)) e.setIris(name); }

  /** Point on the outer sclera: θ from the corneal apex (deg), φ from temporal towards superior (deg). */
  globePt(s, th, ph, R = 12.05) {
    const e = this.eyes[s > 0 ? 'OS' : 'OD'];
    const t = THREE.MathUtils.degToRad(th), p = THREE.MathUtils.degToRad(ph);
    return e.posterior.localToWorld(V(s * Math.sin(t) * Math.cos(p) * R, Math.sin(t) * Math.sin(p) * R, Math.cos(t) * R));
  }

  // ------------------------------------------------------------ extraocular muscles
  buildMuscles() {
    const G = this.group('muscles');
    const tex = striationTexture();
    const mat = new THREE.MeshPhysicalMaterial({ map: tex, vertexColors: true, roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.4, sheen: 0.4, sheenColor: new THREE.Color('#ffc0b0') });
    const tendon = new THREE.Color('#ece3d3'), muscle = new THREE.Color('#9a2f25');
    const colorFn = (tTendon) => (t) => tendon.clone().lerp(muscle, smoothstep(tTendon - 0.03, tTendon + 0.05, t));
    for (const s of [1, -1]) {
      const E = mir(EYE_C, s), A = mir(APEX, s);
      const axis = A.clone().sub(E).normalize();
      const upFn = (p) => {
        const r = p.clone().sub(E);
        if (r.length() < 15) return r.normalize();
        return r.addScaledVector(axis, -r.dot(axis)).normalize();
      };
      // four recti: insertion (spiral of Tillaux) → wrap the globe → annulus of Zinn
      const recti = [
        { ph: 0, d: 6.9, o: [4.2, 0.2] }, { ph: 90, d: 7.7, o: [0.6, 3.8] },
        { ph: 180, d: 5.5, o: [-3.4, 0] }, { ph: 270, d: 6.5, o: [0.6, -3.6] },
      ];
      for (const m of recti) {
        const thI = 31 + THREE.MathUtils.radToDeg(m.d / 12);
        const O = A.clone().add(V(s * m.o[0], m.o[1], 0));
        const g0 = [this.globePt(s, thI, m.ph, 12.1), this.globePt(s, thI + 14, m.ph, 12.35), this.globePt(s, thI + 28, m.ph, 12.7), this.globePt(s, 100, m.ph, 13.3)];
        const tp = g0[3];
        const mid1 = tp.clone().lerp(O, 0.35).addScaledVector(upFn(tp), 0.8), mid2 = tp.clone().lerp(O, 0.7).addScaledVector(upFn(tp), 0.4);
        const prof = lerpTable([[0, 5, 0.3], [0.1, 4.8, 0.6], [0.18, 4.6, 1.5], [0.32, 4.4, 1.9], [0.7, 3.4, 1.8], [0.9, 2.1, 1.2], [1, 1.6, 0.7]]);
        G.add(new THREE.Mesh(sweep([...g0, mid1, mid2, O], prof, { up: upFn, color: colorFn(0.14), uvLen: 30 }), mat));
      }
      // superior oblique: annulus → along the superomedial wall → trochlea → reflected tendon under SR
      const so = [V(9.8 * s, -1.2, 24.5), V(13.5 * s, 4, 38), V(16.5 * s, 8, 51), V(18 * s, 9, 60), this.globePt(s, 80, 118, 13.3), this.globePt(s, 89, 100, 12.45), this.globePt(s, 97, 80, 12.2), this.globePt(s, 105, 62, 12.08)];
      const soProf = lerpTable([[0, 0.8, 0.8], [0.12, 1.7, 1.7], [0.42, 1.6, 1.6], [0.58, 0.8, 0.8], [0.66, 0.9, 0.7], [0.85, 2.4, 0.35], [1, 4.4, 0.25]]);
      G.add(new THREE.Mesh(sweep(so, soProf, { up: upFn, color: (t) => muscle.clone().lerp(tendon, smoothstep(0.5, 0.6, t)), uvLen: 30 }), mat));
      // trochlea (fibrocartilaginous pulley)
      const tro = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.6, 12, 24), new THREE.MeshStandardMaterial({ color: '#efe8dc', roughness: 0.5 }));
      tro.position.set(17.8 * s, 9, 59.5); tro.lookAt(V(16.5 * s, 8, 51));
      G.add(tro);
      // inferior oblique: anteromedial orbital floor → under IR → posterolateral globe near the macula
      const io = [V(21 * s, -17.5, 62.5), this.globePt(s, 72, 233, 15.0), this.globePt(s, 84, 262, 14.6), this.globePt(s, 95, 300, 13.0), this.globePt(s, 104, 330, 12.35), this.globePt(s, 110, 348, 12.08)];
      const ioProf = lerpTable([[0, 1.6, 0.8], [0.15, 3.0, 1.3], [0.6, 3.6, 1.2], [0.88, 4.2, 0.5], [1, 4.6, 0.3]]);
      G.add(new THREE.Mesh(sweep(io, ioProf, { up: upFn, color: (t) => muscle.clone().lerp(tendon, smoothstep(0.86, 0.95, t)), uvLen: 30 }), mat));
    }
  }

  // ------------------------------------------------------------ optic nerves, chiasm, tracts, LGN, pituitary
  nerveCtrl(s) {
    const e = this.eyes[s > 0 ? 'OS' : 'OD'];
    const dir = EyeModel.mmToDir({ x: -4.3 * s, y: -0.3 });
    const p0 = e.posterior.localToWorld(dir.clone().multiplyScalar(11.6));
    const p1 = e.posterior.localToWorld(dir.clone().multiplyScalar(15));
    return [p0, p1, ...NERVE_CTRL.map((p) => mir(p, s))];
  }
  buildOpticApparatus() {
    const G = this.group('nerves');
    const grid = new Grid([-36, -13, -33], [36, 15, 50], 0.4);
    this.nerveCurves = {}; this.tractCurves = {};
    for (const s of [1, -1]) {
      const nc = this.nerveCtrl(s);
      grid.tube(tubeSamples(nc, NERVE_R, 0.4), 1.6);
      this.nerveCurves[s] = new THREE.CatmullRomCurve3(nc, false, 'centripetal');
      const tc = TRACT_CTRL.map((p) => mir(p, s));
      grid.tube(tubeSamples(tc, TRACT_R, 0.4), 1.6);
      this.tractCurves[s] = new THREE.CatmullRomCurve3(tc, false, 'centripetal');
    }
    const rot = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationX(0.35)); // world→local (posterior edge higher)
    grid.ellipsoid([0, 0.3, -0.5], [7.2, 2.1, 4.3], 1.8, rot);
    this.nerveMat = new THREE.MeshPhysicalMaterial({ color: '#f1e6d4', roughness: 0.42, sheen: 0.6, sheenColor: new THREE.Color('#ffe2d8'), clearcoat: 0.45, clearcoatRoughness: 0.3, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
    this.nerveMesh = new THREE.Mesh(grid.mesh(), this.nerveMat);
    this.nerveMesh.renderOrder = 2;
    G.add(this.nerveMesh);

    // lateral geniculate nuclei (bent ovoid, "Napoleon's hat")
    const gm = new THREE.MeshPhysicalMaterial({ color: '#b98a80', roughness: 0.55, sheen: 0.3, sheenColor: new THREE.Color('#ffd0c0') });
    for (const s of [1, -1]) {
      const g = new THREE.SphereGeometry(1, 48, 32), p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i) * 3.6, y = p.getY(i) * 2.6, z = p.getZ(i) * 5.2;
        p.setXYZ(i, x, y - 0.09 * x * x - 0.05 * z * z + 1.2, z);
      }
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, gm);
      m.position.copy(mir(LGN, s));
      m.rotation.y = -0.35 * s;
      G.add(m);
    }
    // pituitary gland in the sella, infundibulum behind the chiasm
    const pit = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), new THREE.MeshPhysicalMaterial({ color: '#d29a86', roughness: 0.5, clearcoat: 0.3 }));
    pit.scale.set(6.2, 3.6, 4.8); pit.position.set(0, -10, 1.5);
    G.add(pit);
    G.add(new THREE.Mesh(sweep([V(0, -7, 1), V(0, -4, -0.5), V(0, -1.3, -2.3)], () => [1.2, 1.2], { seg: 16, rad: 16 }), pit.material));
  }
  setNerveOpacity(v) {
    this.nerveMat.opacity = v;
    this.nerveMat.transparent = v < 0.99;
    this.nerveMat.depthWrite = v >= 0.99;
    this.nerveMat.needsUpdate = true;
  }

  // ------------------------------------------------------------ tractography
  buildFibres() {
    const G = this.group('fibres');
    const R = rng(7);
    const retinal = [], radiations = [];
    const frameAt = (curve, u) => {
      const p = curve.getPoint(u), T = curve.getTangent(u);
      const S = new THREE.Vector3().crossVectors(T, UP).normalize();
      return { p, S, U: new THREE.Vector3().crossVectors(S, T).normalize() };
    };
    // retinal ganglion cell axons: optic disc → nerve → chiasm (nasal fibres cross) → tract → LGN
    for (const se of [1, -1]) {
      const nerve = this.nerveCurves[se];
      for (let f = 0; f < 170; f++) {
        let rx, ry;
        do { rx = R() * 2 - 1; ry = R() * 2 - 1; } while (rx * rx + ry * ry > 1 || Math.abs(rx) < 0.04);
        const nasal = rx < 0; // rx: temporal-positive retinal position
        const h = nasal ? -se : se; // hemisphere reached
        const field = nasal ? se : -se; // visual hemifield seen (+1 = left)
        const upper = ry < 0; // inferior retina sees the superior field
        const color = FIELD_COL[field > 0 ? 'L' : 'R'][upper ? 'up' : 'lo'];
        const pts = [];
        for (const u of [0.0, 0.08, 0.2, 0.34, 0.48, 0.62, 0.74, 0.84, 0.9]) {
          const { p, S, U } = frameAt(nerve, u);
          const latSign = Math.sign(S.x * se) || 1;
          const shrink = u > 0.8 ? 0.7 : 0.82, r = (u < 0.12 ? 2.3 : u < 0.6 ? 1.9 : 1.7) * shrink;
          pts.push(p.addScaledVector(S, latSign * rx * r).addScaledVector(U, ry * r));
        }
        if (nasal) {
          // inferonasal fibres cross anteriorly, superonasal posteriorly
          const zc = ry < 0 ? 1.6 : -1.4;
          pts.push(V(se * 1.6, 0.25 + ry * 0.9, zc + 0.4), V(-se * 1.6, 0.35 + ry * 0.9, zc - 0.4));
        } else pts.push(V(se * 5.4, 0.4 + ry * 0.9, -0.4 + rx * 0.5));
        const tract = this.tractCurves[h];
        const jt = (R() - 0.5) * 1.4, ju = (R() - 0.5) * 0.9;
        for (const u of [0.05, 0.25, 0.5, 0.75, 0.92]) {
          const { p, S, U } = frameAt(tract, u);
          pts.push(p.addScaledVector(S, ry * 1.3 + jt * 0.6).addScaledVector(U, ju));
        }
        pts.push(mir(LGN, h).add(V((R() - 0.5) * 4, (R() - 0.5) * 2.5, (R() - 0.5) * 6)));
        // visual-field position carried by this axon (normalised to the field radius; +fx = patient's left)
        retinal.push({ pts: new THREE.CatmullRomCurve3(pts, false, 'centripetal').getPoints(150), color, eye: se > 0 ? 'OS' : 'OD', fx: field * Math.abs(rx), fy: -ry });
      }
    }
    // geniculo-calcarine fibres: LGN → (Meyer's loop | central | dorsal bundle) → calcarine banks
    const templ = {
      meyer: [[23, 8.2, -28.5], [27, 5, -25], [31, 1, -18], [34, -2.5, -10], [36.5, -4, -17], [36.5, -3, -30], [35, 0, -45], [31, 4, -60], [24, 8, -75], [15, 11, -88]],
      central: [[23, 8.2, -28.5], [27, 8, -31], [31, 9, -40], [33, 10, -52], [30, 12, -66], [24, 14, -80], [16, 16, -92]],
      dorsal: [[23, 8.2, -28.5], [26, 12, -31], [30, 15, -40], [32, 18, -52], [29, 20, -66], [23, 21, -78], [15, 21, -89]],
    };
    const NS = 40;
    const rs = Object.fromEntries(Object.entries(templ).map(([k, a]) => [k, new THREE.CatmullRomCurve3(a.map((p) => V(...p)), false, 'centripetal').getSpacedPoints(NS)]));
    for (const h of [1, -1]) {
      const field = -h;
      for (let f = 0; f < 260; f++) {
        const e = R() * 2 - 1, ecc = Math.pow(R(), 0.8);
        const other = e > 0 ? rs.meyer : rs.dorsal, w = Math.pow(Math.abs(e), 0.7);
        const jit = V((R() - 0.5) * 3.2, (R() - 0.5) * 2.6, (R() - 0.5) * 2.4);
        const zEnd = -103 + 40 * Math.pow(ecc, 0.9);
        const end = V(4.5 + R() * 3.5, calcY(zEnd) - e * 6.5, zEnd);
        const pts = [];
        for (let i = 0; i <= NS; i++) {
          const p = rs.central[i].clone().lerp(other[i], w);
          if (i > 0 && p.z < zEnd + 10) break;
          const taper = Math.sin(Math.PI * Math.min(1, i / NS) * 0.999);
          pts.push(p.addScaledVector(jit, taper));
        }
        const last = pts[pts.length - 1];
        pts.push(last.clone().lerp(end, 0.55).add(V(3, 0, -3)), end);
        const color = FIELD_COL[field > 0 ? 'L' : 'R'][e > 0 ? 'up' : 'lo'];
        const ang = (e * Math.PI) / 2; // angle from the horizontal meridian; e > 0 = upper field
        radiations.push({ pts: new THREE.CatmullRomCurve3(pts.map((p) => V(p.x * h, p.y, p.z)), false, 'centripetal').getPoints(120), color, h, fx: field * ecc * Math.cos(ang), fy: ecc * Math.sin(ang) });
      }
    }
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.0, emissive: '#111111' });
    const mR = new THREE.Mesh(streamlines(retinal, 0.11), mat), mO = new THREE.Mesh(streamlines(radiations, 0.2), mat);
    G.add(mR, mO);
    this.fibreSets = [{ list: retinal, mesh: mR }, { list: radiations, mesh: mO }];
    for (const fs of this.fibreSets) fs.base = fs.mesh.geometry.attributes.color.array.slice();
  }

  // ------------------------------------------------------------ lesion simulation
  buildLesion() {
    const G = this.group('lesion');
    const g = new THREE.IcosahedronGeometry(1, 5), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 1 + 0.07 * noise3(x * 2.3 + 5, y * 2.3, z * 2.3);
      p.setXYZ(i, x * k, y * k, z * k);
    }
    g.computeVertexNormals();
    this.lesionMat = new THREE.MeshPhysicalMaterial({ color: '#ff2448', emissive: '#5a0012', roughness: 0.35, clearcoat: 0.6, transparent: true, opacity: 0.55, depthWrite: false });
    this.lesionMesh = new THREE.Mesh(g, this.lesionMat);
    this.lesionMesh.renderOrder = 10; // after the translucent brain, ventricles and sheath
    // halo drawn through other structures so a deep lesion stays visible
    this.lesionHalo = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#ff3b5c', transparent: true, opacity: 0.22, depthTest: false, depthWrite: false }));
    this.lesionHalo.renderOrder = 11;
    this.lesionMesh.add(this.lesionHalo);
    G.add(this.lesionMesh);
    G.visible = false;
  }
  /**
   * les = null | { c: [x,y,z], r: [rx,ry,rz] (mm, ellipsoid), tumour?: bool }.
   * Every fibre with a sample inside the ellipsoid is interrupted (drawn grey).
   * Returns the resulting visual fields (see fieldMaps) or null.
   */
  setLesion(les) {
    this.lesion = les;
    this.parts.lesion.visible = !!les;
    if (les) {
      this.lesionMesh.position.set(...les.c);
      this.lesionMesh.scale.set(...les.r);
      this.lesionMat.color.set(les.tumour ? '#e7a08c' : '#ff2448');
      this.lesionMat.emissive.set(les.tumour ? '#3a1408' : '#5a0012');
      this.lesionMat.opacity = les.tumour ? 0.8 : 0.6;
      this.lesionHalo.material.color.set(les.tumour ? '#f0b09a' : '#ff3b5c');
    }
    for (const fs of this.fibreSets) {
      const attr = fs.mesh.geometry.attributes.color, a = attr.array;
      let v = 0;
      for (const f of fs.list) {
        const n = f.pts.length * 5; // streamlines(): 5 vertices per ring
        f.cut = !!les && f.pts.some((p) => {
          const dx = (p.x - les.c[0]) / les.r[0], dy = (p.y - les.c[1]) / les.r[1], dz = (p.z - les.c[2]) / les.r[2];
          return dx * dx + dy * dy + dz * dz < 1;
        });
        if (f.cut) for (let i = v * 3; i < (v + n) * 3; i += 3) { a[i] = 0.2; a[i + 1] = 0.21; a[i + 2] = 0.24; }
        else a.set(fs.base.subarray(v * 3, (v + n) * 3), v * 3);
        v += n;
      }
      attr.needsUpdate = true;
    }
    return les ? this.fieldMaps() : null;
  }
  /** Ray-pick a point on the fibre tracts / nerves / chiasm (for placing a lesion by clicking). */
  pick(raycaster) {
    const targets = [this.nerveMesh, ...this.fibreSets.map((f) => f.mesh)].filter((m) => m.visible && m.parent.visible);
    const hit = raycaster.intersectObjects(targets, false)[0];
    return hit ? hit.point : null;
  }
  /**
   * Visual fields of both eyes as N×N grids in chart orientation (as the patient sees them: column 0 =
   * patient's left, row 0 = superior), value 1 = seen, 0 = blind, NaN outside the field. A field point
   * is seen when both the retinal axon (of that eye) and the geniculo-calcarine fibre carrying it are
   * intact; it takes the inverse-distance vote of the 4 nearest fibres in the same quadrant, so defects
   * respect the vertical and horizontal meridians as real ones do.
   */
  fieldMaps(N = 72) {
    const q = (fx, fy) => (fx > 0 ? 0 : 1) + (fy > 0 ? 0 : 2);
    const ret = { OS: [[], [], [], []], OD: [[], [], [], []] }, rad = [[], [], [], []];
    for (const f of this.fibreSets[0].list) ret[f.eye][q(f.fx, f.fy)].push(f);
    for (const f of this.fibreSets[1].list) rad[q(f.fx, f.fy)].push(f);
    const loss = (list, x, y) => {
      const bd = [1e9, 1e9, 1e9, 1e9], bc = [0, 0, 0, 0];
      for (const f of list) {
        const d = Math.hypot(f.fx - x, f.fy - y);
        if (d >= bd[3]) continue;
        let k = 3;
        while (k > 0 && bd[k - 1] > d) { bd[k] = bd[k - 1]; bc[k] = bc[k - 1]; k--; }
        bd[k] = d; bc[k] = f.cut ? 1 : 0;
      }
      let sw = 0, sc = 0;
      for (let k = 0; k < 4; k++) if (bd[k] < 1e9) { const w = 1 / (bd[k] + 0.02); sw += w; sc += w * bc[k]; }
      return sw ? sc / sw : 0;
    };
    const out = { N };
    for (const eye of ['OS', 'OD']) {
      const m = new Float32Array(N * N);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const fx = 1 - ((i + 0.5) * 2) / N, fy = 1 - ((j + 0.5) * 2) / N;
        if (fx * fx + fy * fy > 1) { m[j * N + i] = NaN; continue; }
        const k = q(fx, fy);
        const seen = (1 - loss(ret[eye][k], fx, fy)) * (1 - loss(rad[k], fx, fy));
        m[j * N + i] = smoothstep(0.3, 0.7, seen);
      }
      out[eye] = m;
    }
    return out;
  }

  // ------------------------------------------------------------ circle of Willis + ophthalmic arteries
  buildArteries() {
    const G = this.group('arteries');
    const mat = new THREE.MeshPhysicalMaterial({ color: '#b3231c', roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.2, sheen: 0.3, sheenColor: new THREE.Color('#ff8a7a') });
    const add = (pts, r0, r1 = r0, taperEnd = false) => {
      const prof = (t) => { const r = r0 + (r1 - r0) * t; const k = taperEnd ? Math.min(1, (1 - t) * 12 + 0.15) : 1; return [r * k, r * k]; };
      G.add(new THREE.Mesh(sweep(pts.map((p) => V(...p)), prof, { seg: Math.max(24, pts.length * 14), rad: 14 }), mat));
    };
    for (const s of [1, -1]) {
      const m = (a) => a.map((p) => [p[0] * s, p[1], p[2]]);
      add(m([[13, -16, 13], [12.6, -9, 9.5], [11.6, -5, 6], [11.5, -1, 2.5], [12.5, 1.8, -1]]), 2.0, 1.8); // ICA (supraclinoid)
      add(m([[11.6, -6, 7.5], [10.4, -6.6, 11], [9.2, -6.1, 14.5], [12, -7.2, 21], [16, -7.8, 28], [20, -3.4, 34.5], [23, -1.6, 40], [25.5, 0.5, 47]]), 0.75, 0.42, true); // ophthalmic
      add(m([[12.5, 1.8, -1], [20, 2, 0.5], [28, 3, 2], [36, 5, 1], [42, 9, -4], [46, 15, -10]]), 1.5, 1.1, true); // MCA
      add(m([[12.5, 1.8, -1], [8, 4, 3], [4, 5.5, 6], [1.4, 6, 7.5]]), 1.15, 1.05); // ACA A1
      add(m([[1.4, 6, 7.5], [1.7, 10, 12], [2, 18, 22], [2.1, 30, 26], [2.1, 42, 14], [2.1, 52, -6], [2.1, 55, -30]]), 1.05, 0.75, true); // ACA A2+
      add(m([[12.5, 1.8, -1], [11, 0.4, -7], [9, -0.6, -12], [6.8, -1.6, -14.5]]), 0.6); // PComm
      add(m([[0, -3, -13], [3.5, -2.2, -13.6], [6.8, -1.6, -14.5], [12.5, 0, -21], [16.5, 3, -30], [18, 6, -44], [15.5, 10, -58], [11, 13, -73], [7, 14.5, -88]]), 1.25, 0.7, true); // PCA → calcarine a.
      add(m([[0, -50, -25.5], [5, -58, -29], [9, -68, -33]]), 1.55); // vertebral
    }
    add([[-1.4, 6, 7.5], [0, 6.2, 7.7], [1.4, 6, 7.5]], 0.7); // AComm
    add([[0, -50, -25.5], [0, -38, -17], [0, -26, -12.8], [0, -14, -12.2], [0, -3, -13]], 1.6); // basilar
  }

  // ------------------------------------------------------------ ventricles
  buildVentricles() {
    const G = this.group('ventricles');
    const grid = new Grid([-42, -14, -80], [42, 38, 38], 0.8);
    for (const s of [1, -1]) {
      const m = (a) => a.map((p) => V(p[0] * s, p[1], p[2]));
      grid.tube(tubeSamples(m([[5.5, 20, 30], [7, 26, 16], [8, 28, 0], [10, 27, -18], [16, 22, -38], [19, 19, -48], [17, 17, -60], [13, 16, -70]]),
        [[2.6, 5], [3.4, 5.5], [3.6, 4.2], [3.8, 3.4], [6, 6], [6.2, 6.2], [3.6, 3.2], [1.4, 1.4]], 0.6), 3);
      grid.tube(tubeSamples(m([[17, 21, -42], [23, 13, -42], [29, 3, -34], [32, -4, -22], [31.5, -7, -10]]),
        [[5, 5], [4.4, 4], [3.4, 2.4], [3, 2.1], [1.4, 1.2]], 0.6), 3);
    }
    grid.tube(tubeSamples([V(0, 13, 2), V(0, 15, -8), V(0, 14, -18), V(0, 10, -26)], [[1.3, 7], [1.5, 8], [1.5, 7], [1, 3]], 0.6), 2.5);
    const mat = new THREE.MeshPhysicalMaterial({ color: '#7db7ee', roughness: 0.15, clearcoat: 1, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(grid.mesh(), mat);
    mesh.renderOrder = 3;
    G.add(mesh);
  }

  // ------------------------------------------------------------ brain
  buildBrain() {
    const G = this.group('brain');
    const grid = new Grid([-70, -64, -114], [70, 97, 66], 1.25);
    const out = {};
    const DEPTH = 4.2;
    grid.fill((x, y, z) => {
      let d = cerebrum(x, y, z, out);
      if (d > -9 && d < 9) d += DEPTH * sulcusField(x, y, z, out.syl);
      const c = cerebellum(x, y, z), b = brainstem(x, y, z);
      return Math.min(d, c, b);
    });
    const g = taubinSmooth(grid.mesh(), 4);
    const P = g.attributes.position.array, info = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      const dc = cerebrum(x, y, z, out), dl = cerebellum(x, y, z), db = brainstem(x, y, z);
      const region = dc <= Math.min(dl, db) + 2.5 ? 0 : dl < db ? 1 : 2;
      const sulc = region === 0 ? Math.min(1, sulcusField(x, y, z, out.syl) * 1.15) : 0;
      const ax = Math.abs(x);
      const v1 = region === 0 && z < -58 ? smoothstep(10, 6, Math.abs(y - calcY(z))) * smoothstep(17, 10, ax) * smoothstep(-58, -66, z)
        + (z < -99 ? smoothstep(-99, -104, z) * smoothstep(30, 18, ax) : 0) : 0;
      info[i] = sulc; info[i + 1] = region; info[i + 2] = Math.min(1, v1);
    }
    g.setAttribute('aInfo', new THREE.BufferAttribute(info, 3));
    const col = (h) => new THREE.Color(h);
    this.brainMat = new THREE.ShaderMaterial({
      vertexShader: brainVert, fragmentShader: brainFrag,
      uniforms: {
        uOpacity: { value: 0.16 }, uSolid: { value: 0 },
        uCortex: { value: col('#d8b3a4') }, uDeep: { value: col('#6e443b') }, uCbl: { value: col('#c99a8c') }, uStem: { value: col('#e7d7c6') }, uV1: { value: col('#f0c870') },
      },
      transparent: true, depthWrite: false, side: THREE.FrontSide, clipping: true, clippingPlanes: [this.brainClip],
    });
    this.brain = new THREE.Mesh(g, this.brainMat);
    this.brain.renderOrder = 5;
    G.add(this.brain);
  }
  setBrainOpacity(v) {
    const m = this.brainMat, solid = v >= 0.99;
    this.parts.brain.visible = v > 0.005;
    m.uniforms.uOpacity.value = v;
    m.uniforms.uSolid.value = solid ? 1 : 0;
    m.transparent = !solid; m.depthWrite = solid;
    m.side = solid || this.brainClip.constant < 1e3 ? THREE.DoubleSide : THREE.FrontSide;
    m.needsUpdate = true;
  }
  /** 'none' | 'left' | 'right' | 'top' — removes part of the brain to expose the pathway. */
  setBrainCut(mode) {
    const p = this.brainClip;
    if (mode === 'left') p.set(V(-1, 0, 0), 0);
    else if (mode === 'right') p.set(V(1, 0, 0), 0);
    else if (mode === 'top') p.set(V(0, -1, 0), 12);
    else p.set(V(-1, 0, 0), 1e4);
    this.setBrainOpacity(this.brainMat.uniforms.uOpacity.value);
  }

  // ------------------------------------------------------------ labels
  buildLabels() {
    const G = this.group('labels');
    const L = [
      ['Optic nerve', [-19, -3, 33]], ['Optic chiasm', [0, 2.6, 0.5]], ['Optic tract', [-13.8, 3.5, -16]],
      ['Lateral geniculate nucleus', [-23, 11, -28.5]], ["Meyer's loop", [-36, -4, -11]], ['Optic radiation', [-32, 16, -55]],
      ['Primary visual cortex (V1)', [-6, 22, -96]], ['Pituitary', [0, -13.5, 1.5]], ['Internal carotid a.', [13, -15, 12]],
      ['Ophthalmic a.', [16, -8.5, 28]], ['Lateral rectus', [-44, -6, 46]], ['Superior oblique', [16, 9, 50]],
      ['Inferior oblique', [33, -18, 56]], ['Lateral ventricle', [18, 25, -42]], ['Cerebellum', [0, -32, -84]], ['Brainstem', [0, -34, -24]],
      ['Middle cerebral a.', [-40, 8, -2]], ['Posterior cerebral a.', [-16, 10, -58]],
    ];
    for (const [text, p] of L) {
      const el = document.createElement('div');
      el.className = 'p-label';
      el.innerHTML = `<span class="dot"></span>${text}`;
      const o = new CSS2DObject(el);
      o.position.set(...p);
      o.center.set(0, 0.5);
      G.add(o);
    }
  }

  setVisible(name, on) {
    if (this.parts[name]) this.parts[name].visible = on;
    if (name === 'labels') for (const o of this.parts.labels.children) o.visible = on; // CSS2DRenderer checks each object's own flag
  }
}
