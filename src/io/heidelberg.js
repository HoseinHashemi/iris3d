// Heidelberg Spectralis readers: raw .vol (HSF-OCT-1xx) and Heyex XML export (XML + TIF images).
// Both yield the OCT volume, the IR-SLO localizer (same eye, same session), the exact position of
// every B-scan on the SLO (mm), and the device's own layer segmentation for validation.
import UTIF from 'utif';

const INVALID = 1e30;
// .vol segmentation index → our layer keys (0 ILM, 1 BM, 2 RNFL, 14 PR1/EZ, 16 RPE)
const VOL_SEG = { ILM: 0, BM: 1, RNFL: 2, EZ: 14, RPE: 16 };
const XML_SEG = { ILM: 'ILM', BM: 'BM', RNFL: 'RNFL', EZ: 'PR1', RPE: 'RPE' };

function grayCanvas(gray, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = gray[i]; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Put B-scans in superior→inferior order (our convention) and derive physical dimensions. */
function finalize({ w, h, d, data, geom, seg, scaleZ, slo, sloScale, fovDeg, laterality, deviceStats }) {
  if (d > 1 && geom.start[0].y > geom.start[d - 1].y) {
    const n = w * h, tmp = new Uint8Array(n);
    for (let k = 0; k < Math.floor(d / 2); k++) {
      const a = k * n, b = (d - 1 - k) * n;
      tmp.set(data.subarray(a, a + n)); data.copyWithin(a, b, b + n); data.set(tmp, b);
    }
    geom.start.reverse(); geom.end.reverse();
    for (const key of Object.keys(seg)) {
      const S = seg[key], c = S.slice();
      for (let k = 0; k < d; k++) S.set(c.subarray((d - 1 - k) * w, (d - k) * w), k * w);
    }
  }
  const s0 = geom.start[0], e0 = geom.end[0];
  const widthMM = Math.hypot(e0.x - s0.x, e0.y - s0.y);
  const lengthMM = d > 1 ? Math.hypot(geom.start[d - 1].x - s0.x, geom.start[d - 1].y - s0.y) : 0.01;
  return {
    volume: { w, h, d, data, widthMM: +widthMM.toFixed(4), lengthMM: +lengthMM.toFixed(4), depthMM: +(scaleZ * h).toFixed(4) },
    slo, sloScale, fovDeg, laterality, geom, deviceSeg: seg, deviceStats,
  };
}

export async function parseVol(file, onProgress = () => {}) {
  const buf = await file.arrayBuffer();
  const dv = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
  if (!magic.startsWith('HSF-OCT')) throw new Error('Not a Heidelberg .vol file');
  const w = dv.getInt32(12, true), d = dv.getInt32(16, true), h = dv.getInt32(20, true);
  const scaleZ = dv.getFloat64(40, true);
  const xs = dv.getInt32(48, true), ys = dv.getInt32(52, true), sloScale = dv.getFloat64(56, true);
  const fovDeg = dv.getInt32(72, true);
  const laterality = new TextDecoder().decode(new Uint8Array(buf, 84, 2)) === 'OS' ? 'OS' : 'OD';
  const hdr = dv.getInt32(100, true);
  const slo = grayCanvas(new Uint8Array(buf, 2048, xs * ys), xs, ys);
  const data = new Uint8Array(w * h * d);
  const seg = Object.fromEntries(Object.keys(VOL_SEG).map((k) => [k, new Float32Array(w * d).fill(NaN)]));
  const geom = { start: [], end: [] };
  for (let k = 0; k < d; k++) {
    const off = 2048 + xs * ys + k * (hdr + w * h * 4);
    geom.start.push({ x: dv.getFloat64(off + 16, true), y: dv.getFloat64(off + 24, true) });
    geom.end.push({ x: dv.getFloat64(off + 32, true), y: dv.getFloat64(off + 40, true) });
    const ns = dv.getInt32(off + 48, true), os = dv.getInt32(off + 52, true);
    for (const [key, idx] of Object.entries(VOL_SEG)) {
      if (idx >= ns) continue;
      for (let x = 0; x < w; x++) {
        const v = dv.getFloat32(off + os + (idx * w + x) * 4, true);
        seg[key][k * w + x] = v > INVALID || v < 0 ? NaN : v;
      }
    }
    const img = new Float32Array(buf.slice(off + hdr, off + hdr + w * h * 4));
    const base = k * w * h;
    for (let i = 0; i < w * h; i++) { const v = img[i]; data[base + i] = v > INVALID || !(v > 0) ? 0 : Math.min(255, Math.sqrt(Math.sqrt(v)) * 255); } // Heidelberg display: v^¼
    if (k % 16 === 0) { onProgress(k / d); await new Promise((r) => setTimeout(r)); }
  }
  return finalize({ w, h, d, data, geom, seg, scaleZ, slo, sloScale, fovDeg, laterality });
}

async function tiffToGray(file) {
  const buf = await file.arrayBuffer();
  const ifd = UTIF.decode(buf)[0];
  UTIF.decodeImage(buf, ifd);
  const rgba = UTIF.toRGBA8(ifd), n = ifd.width * ifd.height, g = new Uint8Array(n);
  for (let i = 0; i < n; i++) g[i] = rgba[i * 4 + 1];
  return { w: ifd.width, h: ifd.height, gray: g };
}

/** Heyex XML export: pass all selected files (the .xml plus its .tif images). */
export async function parseHeyexXml(files, onProgress = () => {}) {
  const xmlFile = files.find((f) => /\.xml$/i.test(f.name));
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const doc = new DOMParser().parseFromString(await xmlFile.text(), 'application/xml');
  const num = (el, sel) => parseFloat(el.querySelector(sel)?.textContent);
  const fileOf = (el) => {
    const url = el.querySelector('ImageData > ExamURL')?.textContent || '';
    const f = byName.get(url.split(/[\\/]/).pop().toLowerCase());
    if (!f) throw new Error(`Image ${url} referenced by the XML was not selected`);
    return f;
  };
  const images = [...doc.querySelectorAll('Image')];
  const loc = images.find((im) => im.querySelector('ImageType > Type')?.textContent === 'LOCALIZER');
  const octs = images.filter((im) => im.querySelector('ImageType > Type')?.textContent === 'OCT');
  if (!octs.length) throw new Error('No OCT images in XML');
  let slo = null, sloScale = 0.0112, fovDeg = 30;
  if (loc) {
    const g = await tiffToGray(fileOf(loc));
    slo = grayCanvas(g.gray, g.w, g.h);
    sloScale = num(loc, 'ScaleX');
    fovDeg = num(loc, 'Angle') || 30;
  }
  const first = octs[0];
  const w = num(first, 'OphthalmicAcquisitionContext > Width'), h = num(first, 'OphthalmicAcquisitionContext > Height');
  const scaleZ = num(first, 'OphthalmicAcquisitionContext > ScaleY');
  const d = octs.length;
  const data = new Uint8Array(w * h * d);
  const seg = Object.fromEntries(Object.keys(XML_SEG).map((k) => [k, new Float32Array(w * d).fill(NaN)]));
  const geom = { start: [], end: [] };
  for (let k = 0; k < d; k++) {
    const im = octs[k];
    geom.start.push({ x: num(im, 'Start X'), y: num(im, 'Start Y') });
    geom.end.push({ x: num(im, 'End X'), y: num(im, 'End Y') });
    const g = await tiffToGray(fileOf(im));
    data.set(g.gray.subarray(0, w * h), k * w * h);
    for (const line of im.querySelectorAll('Segmentation > SegLine')) {
      const name = line.querySelector('Name')?.textContent;
      const key = Object.keys(XML_SEG).find((kk) => XML_SEG[kk] === name);
      if (!key) continue;
      const vals = line.querySelector('Array').textContent.trim().split(/\s+/).map(Number);
      for (let x = 0; x < w; x++) { const v = vals[x]; seg[key][k * w + x] = v > INVALID || !(v >= 0) ? NaN : v; }
    }
    if (k % 8 === 0) { onProgress(k / d); await new Promise((r) => setTimeout(r)); }
  }
  // device ETDRS results stored in the export
  const deviceStats = {};
  for (const z of doc.querySelectorAll('ThicknessGrid Zone')) {
    const name = z.querySelector('Name')?.textContent, t = parseFloat(z.querySelector('AvgThickness')?.textContent);
    if (name && Number.isFinite(t)) deviceStats[name] = t * 1000;
  }
  const tv = parseFloat(doc.querySelector('ThicknessGrid TotalVolume')?.textContent);
  if (Number.isFinite(tv)) deviceStats.volume = tv;
  const lat = first.querySelector('Laterality')?.textContent === 'L' ? 'OS' : 'OD';
  return finalize({ w, h, d, data, geom, seg, scaleZ, slo, sloScale, fovDeg, laterality: lat, deviceStats });
}
