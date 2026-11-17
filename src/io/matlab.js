// Minimal MATLAB Level-5 MAT-file reader (numeric arrays, zlib-compressed elements), used for the
// Duke DME dataset (Chiu et al., Biomed. Opt. Express 2015): 'images' (rows × cols × B-scans, uint8)
// and two experts' manual boundary tracings 'manualLayers1/2' (8 × cols × B-scans, 1-based rows).
const TYPED = { 1: Int8Array, 2: Uint8Array, 3: Int16Array, 4: Uint16Array, 5: Int32Array, 6: Uint32Array, 7: Float32Array, 9: Float64Array, 12: BigInt64Array, 13: BigUint64Array };

async function inflate(bytes, wanted) {
  const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = ds.getReader();
  const chunks = [];
  let n = 0, checked = !wanted;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value); n += value.length;
    if (!checked && n >= 256) {
      checked = true;
      const head = concat(chunks, n);
      const name = matrixName(head);
      if (!wanted.includes(name)) { reader.cancel(); return null; }
    }
  }
  return concat(chunks, n);
}
function concat(chunks, n) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
function tagAt(dv, o) {
  const t = dv.getUint32(o, true);
  if (t >>> 16) return { type: t & 0xffff, nbytes: t >>> 16, data: o + 4, next: o + 8 }; // small data element
  const nbytes = dv.getUint32(o + 4, true);
  return { type: t, nbytes, data: o + 8, next: o + 8 + nbytes + ((8 - (nbytes % 8)) % 8) };
}
function matrixName(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const m = tagAt(dv, 0);
  if (m.type !== 14) return null;
  let o = m.data;
  o = tagAt(dv, o).next; // array flags
  o = tagAt(dv, o).next; // dimensions
  const nm = tagAt(dv, o);
  return new TextDecoder().decode(b.subarray(nm.data, nm.data + nm.nbytes));
}
function parseMatrix(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const m = tagAt(dv, 0);
  let o = m.data;
  const fl = tagAt(dv, o); const cls = dv.getUint32(fl.data, true) & 0xff; o = fl.next;
  const dm = tagAt(dv, o); const dims = [];
  for (let i = 0; i < dm.nbytes / 4; i++) dims.push(dv.getInt32(dm.data + i * 4, true));
  o = dm.next;
  const nm = tagAt(dv, o); const name = new TextDecoder().decode(b.subarray(nm.data, nm.data + nm.nbytes)); o = nm.next;
  const re = tagAt(dv, o);
  const T = TYPED[re.type];
  if (!T) throw new Error(`MAT: unsupported data type ${re.type} in ${name}`);
  const bytes = b.slice(re.data, re.data + re.nbytes); // copy → aligned
  return { name, cls, dims, data: new T(bytes.buffer) };
}

/** Parse the requested variables (by name) from a MAT v5 file. Arrays are column-major. */
export async function parseMat(file, wanted = null) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder().decode(buf.subarray(0, 116));
  if (!head.startsWith('MATLAB 5.0 MAT-file')) throw new Error('Not a MATLAB v5 MAT-file (v7.3/HDF5 is not supported)');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = {};
  for (let o = 128; o + 8 <= buf.length;) {
    const type = dv.getUint32(o, true), nbytes = dv.getUint32(o + 4, true);
    const body = buf.subarray(o + 8, o + 8 + nbytes);
    o += 8 + nbytes + (type === 15 ? 0 : (8 - (nbytes % 8)) % 8);
    let mat = null;
    if (type === 15) { const raw = await inflate(body, wanted); if (raw) mat = parseMatrix(raw); }
    else if (type === 14) {
      const full = buf.slice(o - 8 - nbytes - ((8 - (nbytes % 8)) % 8), o);
      if (!wanted || wanted.includes(matrixName(full))) mat = parseMatrix(full);
    }
    if (mat) out[mat.name] = mat;
  }
  return out;
}

// Chiu 2015 boundaries: ILM, NFL/GCL, IPL/INL, INL/OPL, OPL/ONL, IS/OS, OS/RPE, RPE/choroid (Bruch's).
const DUKE_MAP = { ILM: 0, RNFL: 1, EZ: 5, RPE: 6, BM: 7 };

/**
 * Duke DME .mat → OCT volume + an expert's manual tracing as the reference segmentation.
 * Physical size is not stored in the file: pass dims (mm).
 */
export async function parseDukeMat(file, { grader = 1, dims }) {
  const key = `manualLayers${grader}`;
  const v = await parseMat(file, ['images', 'manualLayers1', 'manualLayers2']);
  if (!v.images || v.images.dims.length < 2) throw new Error('MAT file has no "images" array');
  const [h, w, d = 1] = v.images.dims, src = v.images.data;
  const data = new Uint8Array(w * h * d);
  for (let k = 0; k < d; k++) for (let x = 0; x < w; x++) {
    const s = h * (x + w * k), t = k * w * h + x;
    for (let y = 0; y < h; y++) data[t + y * w] = src[s + y];
  }
  let ref = null;
  const L = v[key];
  if (L) {
    const nb = L.dims[0];
    ref = {};
    for (const [name, b] of Object.entries(DUKE_MAP)) {
      if (b >= nb) continue;
      const S = new Float32Array(w * d).fill(NaN);
      for (let k = 0; k < d; k++) for (let x = 0; x < w; x++) {
        const val = Number(L.data[b + nb * (x + w * k)]);
        if (Number.isFinite(val) && val > 0) S[k * w + x] = val - 1; // MATLAB 1-based rows
      }
      ref[name] = S;
    }
  }
  return {
    volume: { w, h, d, data, widthMM: dims.widthMM, lengthMM: dims.lengthMM, depthMM: dims.depthMM },
    deviceSeg: ref, refLabel: ref ? `expert grader ${grader}` : null, raw: v,
  };
}
