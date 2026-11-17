// Retina detail view: OCT layer surfaces (true geometry, depth exaggerated), ray-marched OCT volume,
// and the current B-scan as a textured plane. Units: mm. X = along B-scan, Z = across B-scans
// (superior → inferior), Y = up (depth × exaggeration).
import * as THREE from 'three';
import { LAYERS } from '../state.js';
import { thicknessColor, bilinear } from '../util.js';

const volVert = /* glsl */ `
varying vec3 vOrigin; varying vec3 vDirection;
void main() {
  vOrigin = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  vDirection = position - vOrigin;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const volFrag = /* glsl */ `
precision highp float;
precision highp sampler3D;
layout(location = 0) out highp vec4 volColor;
#define gl_FragColor volColor
uniform sampler3D uData; uniform vec3 uClipMin; uniform vec3 uClipMax;
uniform float uLo; uniform float uHi; uniform float uOpacity; uniform int uMode; uniform float uSteps;
varying vec3 vOrigin; varying vec3 vDirection;
vec2 hitBox(vec3 o, vec3 d) {
  vec3 bmin = uClipMin - 0.5, bmax = uClipMax - 0.5, inv = 1.0 / d;
  vec3 t0 = (bmin - o) * inv, t1 = (bmax - o) * inv, tmin = min(t0, t1), tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}
vec3 cmap(float v) { return vec3(1.0, 0.93, 0.84) * (0.3 + 0.75 * v); }
void main() {
  vec3 rd = normalize(vDirection);
  vec2 b = hitBox(vOrigin, rd);
  if (b.x > b.y) discard;
  b.x = max(b.x, 0.0);
  float dt = 1.0 / uSteps;
  float t = b.x + dt * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec4 acc = vec4(0.0); float mx = 0.0;
  for (int i = 0; i < 2048; i++) {
    if (t > b.y) break;
    vec3 p = vOrigin + rd * t;
    float v = texture(uData, vec3(p.x + 0.5, 0.5 - p.y, p.z + 0.5)).r;
    float n = clamp((v - uLo) / max(uHi - uLo, 1e-3), 0.0, 1.0);
    if (uMode == 1) mx = max(mx, n);
    else {
      float a = 1.0 - pow(1.0 - clamp(n * n * n * 0.25 * uOpacity, 0.0, 0.999), dt * 300.0);
      acc.rgb += (1.0 - acc.a) * a * cmap(n);
      acc.a += (1.0 - acc.a) * a;
      if (acc.a > 0.98) break;
    }
    t += dt;
  }
  if (uMode == 1) { if (mx < 0.02) discard; gl_FragColor = vec4(cmap(mx), clamp(mx * uOpacity, 0.0, 1.0)); }
  else { if (acc.a < 0.005) discard; gl_FragColor = vec4(acc.rgb / acc.a, acc.a); }
  #include <colorspace_fragment>
}`;

export class RetinaView {
  constructor() {
    this.scene = new THREE.Scene();
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.opts = { exag: 3, ilmMode: 'fundus', volMode: 'off', volOpacity: 1, volLo: 0.3, clip: 0, showBscan: true };
    this.visible = { ILM: true, RNFL: false, EZ: false, RPE: true, BM: false };
    this.surfaces = {};
  }

  clear() {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.geometry?.dispose();
      if (o.material && o.material !== this.fundusMat) o.material.dispose?.();
    }
    this.surfaces = {};
    this.volMesh = this.bscanPlane = null;
  }

  setData({ vol, seg, analysis, fundusTex, fundusUV }) {
    this.clear();
    this.vol = vol; this.seg = seg; this.analysis = analysis; this.fundusTex = fundusTex; this.fundusUV = fundusUV;
    if (!vol) return;
    const { w, h, d, widthMM: W, lengthMM: L, depthMM: D } = vol;
    const ex = this.opts.exag;

    // Volume
    if (this.volTex?.image?.data !== vol.data) {
      this.volTex?.dispose();
      this.volTex = new THREE.Data3DTexture(vol.data, w, h, d);
      this.volTex.format = THREE.RedFormat;
      this.volTex.type = THREE.UnsignedByteType;
      this.volTex.minFilter = this.volTex.magFilter = THREE.LinearFilter;
      this.volTex.unpackAlignment = 1;
      this.volTex.needsUpdate = true;
    }
    this.volMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uData: { value: this.volTex }, uClipMin: { value: new THREE.Vector3(0, 0, 0) }, uClipMax: { value: new THREE.Vector3(1, 1, 1) },
        uLo: { value: this.opts.volLo }, uHi: { value: 1 }, uOpacity: { value: this.opts.volOpacity }, uMode: { value: 0 }, uSteps: { value: 420 },
      },
      vertexShader: volVert, fragmentShader: volFrag, side: THREE.BackSide, transparent: true, depthWrite: false,
    });
    this.volMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.volMat);
    this.volMesh.scale.set(W, D * ex, d > 1 ? L : 0.05);
    this.volMesh.renderOrder = 10;
    this.group.add(this.volMesh);

    // B-scan plane
    this.bscanTex = new THREE.CanvasTexture(document.createElement('canvas'));
    this.bscanTex.colorSpace = THREE.SRGBColorSpace;
    this.bscanPlane = new THREE.Mesh(new THREE.PlaneGeometry(W, D * ex),
      new THREE.MeshBasicMaterial({ map: this.bscanTex, side: THREE.DoubleSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.bscanPlane.renderOrder = 5;
    this.group.add(this.bscanPlane);

    // Footprint grid (1 mm)
    const grid = new THREE.GridHelper(Math.max(W, L), Math.round(Math.max(W, L)), 0x3a4b5f, 0x1d2836);
    grid.position.y = -(D * ex) / 2 - 0.02;
    this.group.add(grid);
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, D * ex, d > 1 ? L : 0.05)),
      new THREE.LineBasicMaterial({ color: 0x2c3c50 }));
    this.group.add(frame);

    if (seg && d > 1) for (const layer of LAYERS) this.buildSurface(layer);
    this.applyVisibility();
  }

  buildSurface(layer) {
    const { w, h, d, widthMM: W, lengthMM: L, depthMM: D } = this.vol;
    const S = this.seg.surfaces[layer.key], ex = this.opts.exag;
    const nx = Math.min(w, 256), nz = Math.min(d, 128);
    const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2), col = new Float32Array(nx * nz * 3);
    const c = new THREE.Color();
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const fi = (i * (w - 1)) / (nx - 1), fk = (k * (d - 1)) / (nz - 1);
      const y = bilinear(S, w, d, fi, fk);
      const X = (fi / (w - 1) - 0.5) * W, Z = (fk / (d - 1) - 0.5) * L;
      const j = k * nx + i;
      pos[j * 3] = X; pos[j * 3 + 1] = (0.5 - y / h) * D * ex; pos[j * 3 + 2] = Z;
      if (this.fundusUV) { const t = this.fundusUV(X, Z); uv[j * 2] = t.u; uv[j * 2 + 1] = t.v; }
      if (this.analysis) c.setRGB(...thicknessColor(bilinear(this.analysis.thickness, w, d, fi, fk)), THREE.SRGBColorSpace);
      col[j * 3] = c.r; col[j * 3 + 1] = c.g; col[j * 3 + 2] = c.b;
    }
    const idx = [];
    for (let k = 0; k < nz - 1; k++) for (let i = 0; i < nx - 1; i++) {
      const a = k * nx + i, b = a + 1, cc = a + nx, dd = cc + 1;
      idx.push(a, b, cc, b, dd, cc);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    let mat;
    if (layer.key === 'ILM') {
      const m = this.opts.ilmMode;
      if (m === 'fundus' && this.fundusTex) mat = new THREE.MeshStandardMaterial({ map: this.fundusTex, roughness: 0.55, side: THREE.DoubleSide });
      else if (m === 'solid' || (m === 'fundus' && !this.fundusTex)) mat = new THREE.MeshPhysicalMaterial({ color: '#e7b9a4', roughness: 0.35, clearcoat: 0.6, side: THREE.DoubleSide });
      else mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, side: THREE.DoubleSide });
    } else if (layer.key === 'RPE') {
      mat = new THREE.MeshStandardMaterial({ color: '#5b2a14', roughness: 0.6, side: THREE.DoubleSide });
    } else {
      mat = new THREE.MeshStandardMaterial({ color: layer.color, roughness: 0.5, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
    }
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = layer.key === 'ILM' || layer.key === 'RPE' ? 0 : 4;
    this.surfaces[layer.key] = mesh;
    this.group.add(mesh);
  }

  applyVisibility() {
    for (const [k, m] of Object.entries(this.surfaces)) m.visible = !!this.visible[k];
    if (this.volMesh) {
      this.volMesh.visible = this.opts.volMode !== 'off';
      const u = this.volMat.uniforms;
      u.uMode.value = this.opts.volMode === 'mip' ? 1 : 0;
      u.uOpacity.value = this.opts.volOpacity;
      u.uLo.value = this.opts.volLo;
      u.uClipMin.value.z = this.opts.clip;
    }
    if (this.bscanPlane) this.bscanPlane.visible = this.opts.showBscan;
  }

  setSlice(k, canvas) {
    if (!this.vol || !this.bscanPlane) return;
    const { d, lengthMM: L } = this.vol;
    this.bscanPlane.position.z = d > 1 ? (k / (d - 1) - 0.5) * L : 0;
    if (canvas) {
      if (this.bscanTex.image !== canvas) { this.bscanTex.dispose(); this.bscanTex = new THREE.CanvasTexture(canvas); this.bscanTex.colorSpace = THREE.SRGBColorSpace; this.bscanPlane.material.map = this.bscanTex; this.bscanPlane.material.needsUpdate = true; }
      else this.bscanTex.needsUpdate = true;
    }
  }
}
