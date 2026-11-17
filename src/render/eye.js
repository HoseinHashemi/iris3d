// Anatomical eye model (mm). Biometry follows a Gullstrand/Navarro-style schematic eye:
// anterior cornea R 7.8 mm (Q −0.26), posterior R 6.5 mm, CCT 0.54 mm, ACD 3.1 mm, lens 4.0 mm
// (R +10 / −6 mm), retina radius 11 mm. Posterior segment stretches with axial length.
// The retina is textured with the registered fundus photo (arc-length mapping from the fovea)
// and the OCT macular cube is draped onto it as a relief surface.
import * as THREE from 'three';
import { makeScleraTexture, makeIrisTexture } from './textures.js';
import { thicknessColor, bilinear } from '../util.js';

export const BIO = { apex: 12.6, cct: 0.54, acd: 3.1, lensT: 4.0, Rret: 11.0, limbusZ: 10.0 };
const sag = (r, R, Q = 0) => (r * r) / (R * (1 + Math.sqrt(Math.max(0, 1 - ((1 + Q) * r * r) / (R * R)))));
const corneaAnt = (r) => BIO.apex - sag(r, 7.8, -0.26);
const corneaPost = (r) => BIO.apex - BIO.cct - sag(r, 6.5, -0.6);
const lensAntApex = BIO.apex - BIO.cct - BIO.acd;
const lensAnt = (r) => lensAntApex - sag(r, 10);
const lensPost = (r) => lensAntApex - BIO.lensT + sag(r, 6);

function bezier(p0, p1, p2, p3, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push(new THREE.Vector2(
      u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y));
  }
  return out;
}
function sphereArc(R, zEnd, n) {
  const aEnd = Math.acos(-zEnd / R), pts = [];
  for (let i = 0; i <= n; i++) { const a = (aEnd * i) / n; pts.push(new THREE.Vector2(Math.max(1e-4, R * Math.sin(a)), -R * Math.cos(a))); }
  pts[0].x = 0;
  return pts;
}
function lathe(points, segs = 160) {
  const g = new THREE.LatheGeometry(points, segs);
  g.rotateX(Math.PI / 2); // lathe axis (y) → optical axis (z)
  return g;
}

const retinaVert = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
varying vec3 vLocal; varying vec3 vNrm;
void main() {
  vLocal = position; vNrm = normal;
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
}`;
const retinaFrag = /* glsl */ `
uniform sampler2D tFundus; uniform float uHasFundus; uniform vec2 uFoveaUV; uniform vec2 uUVperMM;
uniform float uR; uniform vec3 uBase; uniform vec2 uDiscMM; uniform float uBright;
varying vec3 vLocal; varying vec3 vNrm;
#include <clipping_planes_pars_fragment>
float hash(vec3 p){ p = fract(p*0.3183099 + .1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.-2.*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x), mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x), mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y), f.z); }
void main() {
  #include <clipping_planes_fragment>
  vec3 d = normalize(vLocal);
  float theta = acos(clamp(-d.z, -1., 1.));
  float phi = atan(d.y, d.x);
  float arc = uR * theta;
  vec2 mm = vec2(cos(phi), -sin(phi)) * arc;            // fundus mm: x right, y down
  float n = noise(vLocal*1.3)*0.5 + noise(vLocal*3.1)*0.3 + noise(vLocal*8.0)*0.2;
  vec3 proc = uBase * (0.78 + 0.42*n);
  float mac = exp(-pow(length(mm)/1.7, 2.));
  proc *= mix(vec3(1.), vec3(0.72, 0.58, 0.66), mac);
  float de = length((mm - uDiscMM) / vec2(0.85, 0.95));
  proc = mix(proc, vec3(0.92, 0.55, 0.35), smoothstep(1.05, 0.9, de) * (1. - uHasFundus));
  proc = mix(proc, vec3(0.95, 0.8, 0.6), smoothstep(0.5, 0.35, de) * (1. - uHasFundus));
  proc *= mix(1.0, 0.7, smoothstep(9., 19., arc));
  vec3 col = proc;
  if (uHasFundus > 0.5) {
    vec2 uv = uFoveaUV + vec2(mm.x, -mm.y) * uUVperMM;
    if (uv.x > 0. && uv.x < 1. && uv.y > 0. && uv.y < 1.) {
      vec4 f = texture2D(tFundus, uv);
      col = mix(proc, f.rgb * uBright, f.a);
    }
  }
  vec3 L = normalize(vec3(0., 0., 9.) - vLocal);
  float diff = abs(dot(normalize(vNrm), L));
  col *= 0.5 + 0.75 * diff;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class EyeModel {
  constructor() {
    this.group = new THREE.Group();
    this.posterior = new THREE.Group(); // stretched with axial length
    this.group.add(this.posterior);
    this.clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    this.clip = [this.clipPlane];
    this.pupil = 3.5;
    this.retinaUniforms = {
      tFundus: { value: null }, uHasFundus: { value: 0 }, uFoveaUV: { value: new THREE.Vector2(0.5, 0.5) },
      uUVperMM: { value: new THREE.Vector2(0.07, 0.07) }, uR: { value: BIO.Rret },
      uBase: { value: new THREE.Color(0.55, 0.16, 0.06) }, uDiscMM: { value: new THREE.Vector2(4.3, -0.3) }, uBright: { value: 1.0 },
    };
    this.build();
  }

  mat(params, Kind = THREE.MeshStandardMaterial) {
    return new Kind({ side: THREE.DoubleSide, clippingPlanes: this.clip, clipShadows: true, ...params });
  }

  build() {
    const P = this.posterior;
    // --- Cornea (closed lathe: aspheric anterior + posterior surface) ---
    const cornea = [];
    for (let i = 0; i <= 60; i++) { const r = (5.95 * i) / 60; cornea.push(new THREE.Vector2(r, corneaAnt(r))); }
    for (let i = 60; i >= 0; i--) { const r = (5.5 * i) / 60; cornea.push(new THREE.Vector2(r, corneaPost(r))); }
    this.cornea = new THREE.Mesh(lathe(cornea, 192), this.mat({
      color: 0xffffff, transmission: 1, thickness: 0.6, ior: 1.376, roughness: 0.0, metalness: 0,
      clearcoat: 1, clearcoatRoughness: 0.02, specularIntensity: 1, envMapIntensity: 1.4, transparent: true,
    }, THREE.MeshPhysicalMaterial));
    this.cornea.renderOrder = 3;
    this.group.add(this.cornea);

    // --- Sclera (outer textured surface, inner surface with limbal rim) ---
    const zl = corneaAnt(5.95) - 0.06;
    const slope = (corneaAnt(5.96) - corneaAnt(5.94)) / 0.02;
    const outer = sphereArc(12, 8.0, 120);
    const p0 = outer[outer.length - 1], a1 = Math.acos(-8 / 12);
    const t0 = new THREE.Vector2(Math.cos(a1), Math.sin(a1));
    outer.push(...bezier(p0, p0.clone().add(t0.multiplyScalar(1.3)), new THREE.Vector2(5.95 + 0.9, zl + slope * 0.9), new THREE.Vector2(5.95, zl), 30));
    this.scleraTex = makeScleraTexture();
    this.sclera = new THREE.Mesh(lathe(outer, 192), this.mat({ map: this.scleraTex, roughness: 0.42, metalness: 0 }, THREE.MeshPhysicalMaterial));
    this.sclera.material.clearcoat = 0.35;
    this.sclera.material.clearcoatRoughness = 0.25;
    this.sclera.material.sheen = 0.3;
    this.sclera.material.sheenColor = new THREE.Color('#ffd9cf');
    P.add(this.sclera);

    const inner = sphereArc(11.2, 7.0, 110);
    const q0 = inner[inner.length - 1], a2 = Math.acos(-7 / 11.2);
    const tq = new THREE.Vector2(Math.cos(a2), Math.sin(a2));
    const zi = corneaPost(5.5) - 0.05;
    inner.push(...bezier(q0, q0.clone().add(tq.multiplyScalar(1.4)), new THREE.Vector2(5.55 + 0.6, zi - 0.6), new THREE.Vector2(5.55, zi), 30));
    inner.push(new THREE.Vector2(5.95, zl));
    this.innerWall = inner;
    this.scleraInner = new THREE.Mesh(lathe(inner.slice().reverse(), 160), this.mat({ color: '#6e4a3a', roughness: 0.85 }));
    P.add(this.scleraInner);

    // --- Choroid & retina shells ---
    this.choroid = new THREE.Mesh(lathe(sphereArc(11.12, 4.6, 110), 160), this.mat({ color: '#4a130c', roughness: 0.7 }));
    P.add(this.choroid);
    this.retinaMat = new THREE.ShaderMaterial({
      uniforms: this.retinaUniforms, vertexShader: retinaVert, fragmentShader: retinaFrag,
      side: THREE.DoubleSide, clipping: true, clippingPlanes: this.clip,
    });
    this.retina = new THREE.Mesh(lathe(sphereArc(BIO.Rret, 4.5, 160), 256), this.retinaMat);
    P.add(this.retina);

    // --- Ciliary body hugging the inner scleral wall (spur → ora serrata) ---
    const wallR = (z) => {
      for (let i = 1; i < inner.length; i++) {
        const a = inner[i - 1], b = inner[i];
        if ((a.y - z) * (b.y - z) <= 0 && a.y !== b.y) return a.x + ((b.x - a.x) * (z - a.y)) / (b.y - a.y);
      }
      return 8;
    };
    const cil = [], cilIn = [];
    for (let i = 0; i <= 40; i++) {
      const z = 9.2 - (4.6 * i) / 40, t = (z - 4.6) / 4.6, rw = wallR(z) - 0.02;
      const th = 0.1 + 1.55 * Math.pow(t, 1.8) * (1 - Math.pow(t, 10));
      cil.push(new THREE.Vector2(rw, z));
      cilIn.push(new THREE.Vector2(rw - th, z));
    }
    this.ciliary = new THREE.Mesh(lathe([...cil, ...cilIn.reverse(), cil[0]], 160), this.mat({ color: '#3a1d12', roughness: 0.8 }));
    this.group.add(this.ciliary);

    // --- Crystalline lens ---
    const lens = [];
    for (let i = 0; i <= 50; i++) { const r = (4.6 * i) / 50; lens.push(new THREE.Vector2(r, lensAnt(r))); }
    const za = lensAnt(4.6), zp = lensPost(4.6), zc = (za + zp) / 2, rr = (za - zp) / 2;
    for (let i = 1; i < 16; i++) { const a = Math.PI / 2 - (Math.PI * i) / 16; lens.push(new THREE.Vector2(4.6 + rr * 0.9 * Math.cos(a), zc + rr * Math.sin(a))); }
    for (let i = 50; i >= 0; i--) { const r = (4.6 * i) / 50; lens.push(new THREE.Vector2(r, lensPost(r))); }
    this.lens = new THREE.Mesh(lathe(lens, 160), this.mat({
      color: '#fffaf0', transmission: 1, thickness: 3.5, ior: 1.41, roughness: 0.18, envMapIntensity: 0.5,
      attenuationColor: new THREE.Color('#f3e2ae'), attenuationDistance: 14, transparent: true,
    }, THREE.MeshPhysicalMaterial));
    this.lens.renderOrder = 2;
    this.group.add(this.lens);
    this.lensEquator = { r: 4.6 + rr * 0.9, z: zc };

    // --- Zonules ---
    const zpos = [];
    const rIn = wallR(8.0) - 1.55;
    for (let i = 0; i < 240; i++) {
      const a = (i / 240) * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
      const zEq = this.lensEquator.z + (i % 3 - 1) * 0.55;
      const zC = 8.0 - (i % 2) * 0.9;
      zpos.push(c * (this.lensEquator.r - 0.15), s * (this.lensEquator.r - 0.15), zEq, c * rIn, s * rIn, zC);
    }
    const zg = new THREE.BufferGeometry();
    zg.setAttribute('position', new THREE.Float32BufferAttribute(zpos, 3));
    this.zonules = new THREE.LineSegments(zg, new THREE.LineBasicMaterial({ color: '#fff6e6', transparent: true, opacity: 0.22, clippingPlanes: this.clip }));
    this.group.add(this.zonules);

    // --- Iris ---
    this.irisTex = makeIrisTexture('brown');
    this.irisFrontMat = this.mat({ map: this.irisTex, roughness: 0.62 }, THREE.MeshPhysicalMaterial);
    this.irisFrontMat.sheen = 0.4;
    this.irisFrontMat.sheenColor = new THREE.Color('#ffffff');
    this.irisBackMat = this.mat({ color: '#140805', roughness: 0.9 });
    this.buildIris();

    // --- Optic nerve ---
    this.nerveMat = this.mat({ color: '#e9dcc6', roughness: 0.7 });
    this.setDisc({ x: 4.3, y: -0.3 });

    // --- OCT relief patch placeholder ---
    this.patch = null;
  }

  buildIris() {
    if (this.irisFront) { this.group.remove(this.irisFront, this.irisBack); this.irisFront.geometry.dispose(); this.irisBack.geometry.dispose(); }
    const rp = this.pupil / 2, root = 5.85;
    const zb = lensAnt(Math.min(rp, 4.5)) + 0.03, zf = zb + 0.16;
    const front = [], back = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40, r = rp + (root - rp) * t;
      const z = zf + (8.85 - zf) * t + 0.08 * Math.sin(Math.PI * t) + 0.035 * Math.exp(-(((t - 0.35) / 0.05) ** 2));
      front.push(new THREE.Vector2(r, z));
      back.push(new THREE.Vector2(r, zb + (8.5 - zb) * t + 0.03 * Math.sin(Math.PI * t)));
    }
    this.irisFront = new THREE.Mesh(lathe(front, 192), this.irisFrontMat);
    this.irisBack = new THREE.Mesh(lathe([front[0], ...back], 192), this.irisBackMat);
    this.group.add(this.irisFront, this.irisBack);
  }

  setPupil(mm) { this.pupil = mm; this.buildIris(); }
  setIris(name) { this.irisTex.dispose(); this.irisTex = makeIrisTexture(name); this.irisFrontMat.map = this.irisTex; this.irisFrontMat.needsUpdate = true; }

  /** 0 = intact globe; 0.5 = hemisection through the optical axis; 1 = everything removed. */
  setCut(amount) { this.clipPlane.constant = amount <= 0.001 ? 1e3 : 13 - amount * 26; }

  setAxialLength(AL) {
    const f = (AL - (BIO.apex - BIO.limbusZ)) / (BIO.limbusZ + BIO.Rret);
    this.posterior.scale.set(1, 1, f);
    this.posterior.position.z = BIO.limbusZ * (1 - f);
  }

  static mmToDir(m, R = BIO.Rret) {
    const r = Math.hypot(m.x, m.y), th = r / R, ph = Math.atan2(-m.y, m.x);
    return new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), -Math.cos(th));
  }

  setDisc(mm) {
    this.retinaUniforms.uDiscMM.value.set(mm.x, mm.y);
    if (this.nerve) { this.posterior.remove(this.nerve); this.nerve.geometry.dispose(); }
    const dir = EyeModel.mmToDir(mm);
    const back = new THREE.Vector3(0, 0, -1);
    const curve = new THREE.CatmullRomCurve3([
      dir.clone().multiplyScalar(11.6),
      dir.clone().multiplyScalar(13.5),
      dir.clone().multiplyScalar(15.5).addScaledVector(back, 2.5),
      dir.clone().multiplyScalar(16).addScaledVector(back, 9),
    ]);
    const g = new THREE.TubeGeometry(curve, 48, 1.75, 48, false);
    this.nerve = new THREE.Mesh(g, this.nerveMat);
    this.posterior.add(this.nerve);
  }

  setFundus(fundus, opts) {
    const u = this.retinaUniforms;
    if (!fundus) { u.uHasFundus.value = 0; return; }
    if (this.fundusTex?.image !== opts.texCanvas) {
      this.fundusTex?.dispose();
      this.fundusTex = new THREE.CanvasTexture(opts.texCanvas);
      this.fundusTex.colorSpace = THREE.SRGBColorSpace;
      this.fundusTex.anisotropy = 8;
    } else this.fundusTex.needsUpdate = true;
    u.tFundus.value = this.fundusTex;
    u.uHasFundus.value = 1;
    u.uFoveaUV.value.set(fundus.fovea.x / fundus.width, 1 - fundus.fovea.y / fundus.height);
    u.uUVperMM.value.set(1 / (opts.mmPerPx * fundus.width), 1 / (opts.mmPerPx * fundus.height));
    u.uBase.value.setRGB(...opts.baseColor, THREE.SRGBColorSpace);
  }

  /** Drape the OCT retinal surface (ILM, relief ×exag over BM) onto the posterior pole. */
  setOctPatch({ vol, analysis, map, visible, mode, exag }) {
    if (this.patch) { this.posterior.remove(this.patch); this.patch.geometry.dispose(); this.patch = null; }
    if (!vol || !analysis || !visible || vol.d < 2) return;
    const { w, d, widthMM: W, lengthMM: L } = vol;
    const nx = Math.min(w, 200), nz = Math.min(d, 120);
    const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3), idx = [];
    const c = new THREE.Color();
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const fi = (i * (w - 1)) / (nx - 1), fk = (k * (d - 1)) / (nz - 1);
      const t = bilinear(analysis.thickness, w, d, fi, fk);
      const m = map((fi / (w - 1) - 0.5) * W, (fk / (d - 1) - 0.5) * L);
      const p = EyeModel.mmToDir(m).multiplyScalar(BIO.Rret - 0.01 - (t / 1000) * exag);
      const j = (k * nx + i) * 3;
      pos[j] = p.x; pos[j + 1] = p.y; pos[j + 2] = p.z;
      c.setRGB(...thicknessColor(t), THREE.SRGBColorSpace);
      col[j] = c.r; col[j + 1] = c.g; col[j + 2] = c.b;
    }
    for (let k = 0; k < nz - 1; k++) for (let i = 0; i < nx - 1; i++) {
      const a = k * nx + i, b = a + 1, cc = a + nx, dd = cc + 1;
      idx.push(a, cc, b, b, cc, dd);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const material = mode === 'fundus' && this.retinaUniforms.uHasFundus.value
      ? this.retinaMat
      : this.mat({ vertexColors: true, roughness: 0.55, emissive: '#ffffff', emissiveIntensity: 0.0 });
    this.patch = new THREE.Mesh(g, material);
    this.posterior.add(this.patch);
  }
}
