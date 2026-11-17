// Signed-distance-field modelling helpers for the organic anatomy of the visual pathway:
// a voxel grid, primitives "splatted" into it (swept elliptical tubes, ellipsoids) joined with
// smooth unions, gradient noise, and Surface Nets isosurface extraction to a BufferGeometry.
import * as THREE from 'three';

export const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
export const smax = (a, b, k) => -smin(-a, -b, k);
export const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** Ellipsoid distance (Quilez' bound), c centre, r radii. */
export function sdEllipsoid(x, y, z, c, r) {
  const px = x - c[0], py = y - c[1], pz = z - c[2];
  const k0 = Math.hypot(px / r[0], py / r[1], pz / r[2]);
  const k1 = Math.hypot(px / (r[0] * r[0]), py / (r[1] * r[1]), pz / (r[2] * r[2]));
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(...r);
}

// ---------------------------------------------------------------- gradient noise (improved Perlin)
const P = new Uint8Array(512);
{
  let s = 1337;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
function grad(h, x, y, z) {
  const u = (h & 15) < 8 ? x : y, v = (h & 15) < 4 ? y : (h & 15) === 12 || (h & 15) === 14 ? x : z;
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}
export function noise3(x, y, z) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z, B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
  const l = (a, b, t) => a + t * (b - a);
  return l(l(l(grad(P[AA], x, y, z), grad(P[BA], x - 1, y, z), u), l(grad(P[AB], x, y - 1, z), grad(P[BB], x - 1, y - 1, z), u), v),
    l(l(grad(P[AA + 1], x, y, z - 1), grad(P[BA + 1], x - 1, y, z - 1), u), l(grad(P[AB + 1], x, y - 1, z - 1), grad(P[BB + 1], x - 1, y - 1, z - 1), u), v), w);
}

// ---------------------------------------------------------------- voxel grid
export class Grid {
  constructor(min, max, h) {
    this.h = h; this.min = min;
    this.nx = Math.ceil((max[0] - min[0]) / h) + 1;
    this.ny = Math.ceil((max[1] - min[1]) / h) + 1;
    this.nz = Math.ceil((max[2] - min[2]) / h) + 1;
    this.F = new Float32Array(this.nx * this.ny * this.nz).fill(1e9);
    this.tmp = null; this.touched = [];
  }
  /** Evaluate fn(x,y,z) at every voxel. */
  fill(fn) {
    const { nx, ny, nz, h, min, F } = this;
    for (let k = 0, i = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let x = 0; x < nx; x++, i++) F[i] = fn(min[0] + x * h, min[1] + j * h, min[2] + k * h);
  }
  _begin() { if (!this.tmp) this.tmp = new Float32Array(this.F.length).fill(1e9); this.touched.length = 0; }
  _put(i, d) { const t = this.tmp; if (t[i] === 1e9) this.touched.push(i); if (d < t[i]) t[i] = d; }
  /** Smooth-union the current primitive buffer into the field. */
  _commit(k) {
    const { F, tmp, touched } = this;
    for (const i of touched) { F[i] = k > 0 ? smin(F[i], tmp[i], k) : Math.min(F[i], tmp[i]); tmp[i] = 1e9; }
    touched.length = 0;
  }
  _box(lo, hi, cb) {
    const { nx, ny, nz, h, min } = this;
    const i0 = Math.max(0, Math.floor((lo[0] - min[0]) / h)), i1 = Math.min(nx - 1, Math.ceil((hi[0] - min[0]) / h));
    const j0 = Math.max(0, Math.floor((lo[1] - min[1]) / h)), j1 = Math.min(ny - 1, Math.ceil((hi[1] - min[1]) / h));
    const k0 = Math.max(0, Math.floor((lo[2] - min[2]) / h)), k1 = Math.min(nz - 1, Math.ceil((hi[2] - min[2]) / h));
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++)
      cb(i + nx * (j + ny * k), min[0] + i * h, min[1] + j * h, min[2] + k * h);
  }

  /**
   * Swept tube with elliptical cross-section. samples: [{p:Vector3, s:Vector3 (side unit), u:Vector3 (up unit), rs, ru}].
   * Segments of one tube are hard-unioned; the tube is smooth-unioned into the field with blend k.
   */
  tube(samples, k = 0) {
    this._begin();
    const band = this.h * 2.5;
    for (let n = 0; n < samples.length - 1; n++) {
      const A = samples[n], B = samples[n + 1];
      const ax = A.p.x, ay = A.p.y, az = A.p.z, bx = B.p.x - ax, by = B.p.y - ay, bz = B.p.z - az;
      const L2 = bx * bx + by * by + bz * bz || 1e-9;
      const R = Math.max(A.rs, A.ru, B.rs, B.ru) + band;
      const lo = [Math.min(ax, B.p.x) - R, Math.min(ay, B.p.y) - R, Math.min(az, B.p.z) - R];
      const hi = [Math.max(ax, B.p.x) + R, Math.max(ay, B.p.y) + R, Math.max(az, B.p.z) + R];
      const L = Math.sqrt(L2), tx = bx / L, ty = by / L, tz = bz / L;
      this._box(lo, hi, (i, x, y, z) => {
        const px = x - ax, py = y - ay, pz = z - az;
        const t = Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / L2));
        const qx = px - t * bx, qy = py - t * by, qz = pz - t * bz;
        const rs = A.rs + t * (B.rs - A.rs), ru = A.ru + t * (B.ru - A.ru);
        const sx = A.s.x + t * (B.s.x - A.s.x), sy = A.s.y + t * (B.s.y - A.s.y), sz = A.s.z + t * (B.s.z - A.s.z);
        const ux = A.u.x + t * (B.u.x - A.u.x), uy = A.u.y + t * (B.u.y - A.u.y), uz = A.u.z + t * (B.u.z - A.u.z);
        const rm = Math.min(rs, ru);
        const a = (qx * sx + qy * sy + qz * sz) / rs, b = (qx * ux + qy * uy + qz * uz) / ru, c = (qx * tx + qy * ty + qz * tz) / rm;
        this._put(i, (Math.sqrt(a * a + b * b + c * c) - 1) * rm);
      });
    }
    this._commit(k);
  }

  /** Ellipsoid, optionally rotated (Matrix3 world→local). */
  ellipsoid(c, r, k = 0, rot = null) {
    this._begin();
    const R = Math.max(...r) + this.h * 3, e = rot ? rot.elements : null;
    this._box([c[0] - R, c[1] - R, c[2] - R], [c[0] + R, c[1] + R, c[2] + R], (i, x, y, z) => {
      let px = x - c[0], py = y - c[1], pz = z - c[2];
      if (e) { const a = e[0] * px + e[3] * py + e[6] * pz, b = e[1] * px + e[4] * py + e[7] * pz, d = e[2] * px + e[5] * py + e[8] * pz; px = a; py = b; pz = d; }
      this._put(i, sdEllipsoid(px, py, pz, [0, 0, 0], r));
    });
    this._commit(k);
  }

  sample(x, y, z) {
    const { nx, ny, nz, h, min, F } = this;
    const fx = Math.min(nx - 1.001, Math.max(0, (x - min[0]) / h)), fy = Math.min(ny - 1.001, Math.max(0, (y - min[1]) / h)), fz = Math.min(nz - 1.001, Math.max(0, (z - min[2]) / h));
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), u = fx - i, v = fy - j, w = fz - k;
    const at = (a, b, c) => F[a + nx * (b + ny * c)];
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(at(i, j, k), at(i + 1, j, k), u), l(at(i, j + 1, k), at(i + 1, j + 1, k), u), v),
      l(l(at(i, j, k + 1), at(i + 1, j, k + 1), u), l(at(i, j + 1, k + 1), at(i + 1, j + 1, k + 1), u), v), w);
  }

  /** Surface Nets isosurface (outward-facing triangles, gradient normals). */
  mesh(iso = 0) {
    const { nx, ny, nz, h, min, F } = this;
    const sx = 1, sy = nx, sz = nx * ny;
    const vid = new Int32Array(nx * ny * nz).fill(-1);
    const pos = [], idx = [];
    const corner = [0, sx, sy, sx + sy, sz, sx + sz, sy + sz, sx + sy + sz];
    const cx = [0, 1, 0, 1, 0, 1, 0, 1], cy = [0, 0, 1, 1, 0, 0, 1, 1], cz = [0, 0, 0, 0, 1, 1, 1, 1];
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const v = new Float32Array(8);
    for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const base = i + nx * (j + ny * k);
      let mask = 0;
      for (let c = 0; c < 8; c++) { v[c] = F[base + corner[c]] - iso; if (v[c] < 0) mask |= 1 << c; }
      if (mask === 0 || mask === 255) continue;
      let ax = 0, ay = 0, az = 0, n = 0;
      for (const [a, b] of edges) {
        if ((v[a] < 0) === (v[b] < 0)) continue;
        const t = v[a] / (v[a] - v[b]);
        ax += cx[a] + t * (cx[b] - cx[a]); ay += cy[a] + t * (cy[b] - cy[a]); az += cz[a] + t * (cz[b] - cz[a]); n++;
      }
      vid[base] = pos.length / 3;
      pos.push(min[0] + (i + ax / n) * h, min[1] + (j + ay / n) * h, min[2] + (k + az / n) * h);
    }
    // quads across every sign-changing grid edge
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const p = i + nx * (j + ny * k), inside = F[p] < iso;
      const quad = (q0, q1, q2, q3, flip) => {
        const a = vid[q0], b = vid[q1], c = vid[q2], d = vid[q3];
        if (a < 0 || b < 0 || c < 0 || d < 0) return;
        if (flip) idx.push(a, b, c, a, c, d); else idx.push(a, d, c, a, c, b);
      };
      if ((F[p + sx] < iso) !== inside) quad(p, p - sy, p - sy - sz, p - sz, inside);
      if ((F[p + sy] < iso) !== inside) quad(p, p - sz, p - sx - sz, p - sx, inside);
      if ((F[p + sz] < iso) !== inside) quad(p, p - sx, p - sx - sy, p - sy, inside);
    }
    const g = new THREE.BufferGeometry();
    const P3 = new Float32Array(pos), N3 = new Float32Array(pos.length);
    const e = h * 0.75;
    for (let q = 0; q < P3.length; q += 3) {
      const x = P3[q], y = P3[q + 1], z = P3[q + 2];
      const gx = this.sample(x + e, y, z) - this.sample(x - e, y, z), gy = this.sample(x, y + e, z) - this.sample(x, y - e, z), gz = this.sample(x, y, z + e) - this.sample(x, y, z - e);
      const l = Math.hypot(gx, gy, gz) || 1;
      N3[q] = gx / l; N3[q + 1] = gy / l; N3[q + 2] = gz / l;
    }
    g.setAttribute('position', new THREE.BufferAttribute(P3, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N3, 3));
    g.setIndex(idx.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    return g;
  }
}

/** Sample a centreline into tube samples with interpolated per-control-point radii [rs, ru]. */
export function tubeSamples(ctrl, radii, step = 0.5, upHint = new THREE.Vector3(0, 1, 0)) {
  const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
  const n = Math.max(8, Math.ceil(curve.getLength() / step));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, p = curve.getPoint(t), T = curve.getTangent(t);
    const f = t * (radii.length - 1), a = Math.floor(Math.min(f, radii.length - 2)), w = f - a;
    const rs = radii[a][0] + w * (radii[a + 1][0] - radii[a][0]), ru = radii[a][1] + w * (radii[a + 1][1] - radii[a][1]);
    const up0 = typeof upHint === 'function' ? upHint(p, t) : upHint;
    const s = new THREE.Vector3().crossVectors(T, up0).normalize();
    const u = new THREE.Vector3().crossVectors(s, T).normalize();
    out.push({ p, s, u, rs, ru, T });
  }
  return out;
}

/** Taubin λ|μ smoothing (shrink-free) of an indexed geometry; recomputes normals. */
export function taubinSmooth(g, iters = 3, lambda = 0.5, mu = -0.53) {
  const P = g.attributes.position.array, I = g.index.array, n = P.length / 3;
  const deg = new Uint32Array(n + 1);
  for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) { deg[I[t + e]] += 2; }
  const off = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
  const nb = new Uint32Array(off[n]), fill = off.slice(0, n);
  for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = I[t + e], b = I[t + (e + 1) % 3], c = I[t + (e + 2) % 3];
    nb[fill[a]++] = b; nb[fill[a]++] = c;
  }
  const tmp = new Float32Array(P.length);
  const pass = (f) => {
    for (let i = 0; i < n; i++) {
      let x = 0, y = 0, z = 0;
      const a = off[i], b = off[i + 1];
      for (let k = a; k < b; k++) { const j = nb[k] * 3; x += P[j]; y += P[j + 1]; z += P[j + 2]; }
      const m = b - a || 1;
      tmp[i * 3] = P[i * 3] + f * (x / m - P[i * 3]);
      tmp[i * 3 + 1] = P[i * 3 + 1] + f * (y / m - P[i * 3 + 1]);
      tmp[i * 3 + 2] = P[i * 3 + 2] + f * (z / m - P[i * 3 + 2]);
    }
    P.set(tmp);
  };
  for (let i = 0; i < iters; i++) { pass(lambda); pass(mu); }
  g.computeVertexNormals();
  return g;
}
