import UTIF from 'utif';

export const PRESETS = {
  spectralis: { label: 'Heidelberg Spectralis · 20°×20° cube', widthMM: 6.0, lengthMM: 6.0, depthMM: 1.92 },
  cirrus: { label: 'Zeiss Cirrus · 512×128 macular cube', widthMM: 6.0, lengthMM: 6.0, depthMM: 2.0 },
  topcon: { label: 'Topcon 3D OCT · 6×6 mm', widthMM: 6.0, lengthMM: 6.0, depthMM: 2.3 },
  optovue: { label: 'Optovue · 6×6 mm retina map', widthMM: 6.0, lengthMM: 6.0, depthMM: 2.0 },
  custom: { label: 'Custom (enter below)' },
};

const isTiff = (f) => /\.tiff?$/i.test(f.name) || f.type === 'image/tiff';
const isPnm = (f) => /\.(ppm|pgm|pnm)$/i.test(f.name);

/** Binary Netpbm (P5 greyscale / P6 RGB, 8-bit), e.g. the STARE fundus database. */
async function decodePnm(file) {
  const b = new Uint8Array(await file.arrayBuffer());
  let i = 0;
  const tok = () => {
    for (;;) { while (/\s/.test(String.fromCharCode(b[i]))) i++; if (b[i] === 35) { while (b[i] !== 10) i++; } else break; }
    let t = ''; while (!/\s/.test(String.fromCharCode(b[i]))) t += String.fromCharCode(b[i++]);
    return t;
  };
  const magic = tok(), w = +tok(), h = +tok(), max = +tok();
  i++;
  if ((magic !== 'P6' && magic !== 'P5') || max > 255) throw new Error(`Unsupported Netpbm file ${file.name}`);
  const ch = magic === 'P6' ? 3 : 1, rgba = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const o = i + p * ch;
    rgba[p * 4] = b[o]; rgba[p * 4 + 1] = b[o + (ch - 1 && 1)]; rgba[p * 4 + 2] = b[o + (ch - 1 && 2)]; rgba[p * 4 + 3] = 255;
  }
  return { w, h, rgba };
}

/** Decode one file into one or more RGBA frames. */
async function decodeFrames(file) {
  if (isPnm(file)) return [await decodePnm(file)];
  if (isTiff(file)) {
    const buf = await file.arrayBuffer();
    const ifds = UTIF.decode(buf);
    const frames = [];
    for (const ifd of ifds) {
      UTIF.decodeImage(buf, ifd);
      if (!ifd.width || !ifd.height) continue;
      frames.push({ w: ifd.width, h: ifd.height, rgba: new Uint8ClampedArray(UTIF.toRGBA8(ifd)) });
    }
    return frames;
  }
  const bmp = await createImageBitmap(file);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  return [{ w: bmp.width, h: bmp.height, rgba: ctx.getImageData(0, 0, bmp.width, bmp.height).data }];
}

function toGrayResampled(frame, tw, th) {
  const { w, h, rgba } = frame;
  const out = new Uint8Array(tw * th);
  const sx = (w - 1) / Math.max(1, tw - 1), sy = (h - 1) / Math.max(1, th - 1);
  const lum = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) lum[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  for (let y = 0; y < th; y++) {
    const fy = y * sy, y0 = Math.floor(fy), y1 = Math.min(y0 + 1, h - 1), ty = fy - y0;
    for (let x = 0; x < tw; x++) {
      const fx = x * sx, x0 = Math.floor(fx), x1 = Math.min(x0 + 1, w - 1), tx = fx - x0;
      const v = (lum[y0 * w + x0] * (1 - tx) + lum[y0 * w + x1] * tx) * (1 - ty) + (lum[y1 * w + x0] * (1 - tx) + lum[y1 * w + x1] * tx) * ty;
      out[y * tw + x] = v;
    }
  }
  return out;
}

/** Load a set of B-scan images (sorted naturally by file name) into a volume. */
export async function loadOctFiles(fileList, { maxW = 768, maxH = 640 } = {}) {
  const files = [...fileList].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const frames = [];
  for (const f of files) frames.push(...(await decodeFrames(f)));
  if (!frames.length) throw new Error('No readable images found.');
  const w = Math.min(frames[0].w, maxW), h = Math.min(frames[0].h, maxH), d = frames.length;
  const data = new Uint8Array(w * h * d);
  frames.forEach((fr, k) => data.set(toGrayResampled(fr, w, h), k * w * h));
  return { w, h, d, data };
}

/** Load a fundus photograph into a canvas (largest side capped). */
export async function loadFundusFile(file, maxSide = 2048) {
  let frame;
  if (isTiff(file) || isPnm(file)) frame = (await decodeFrames(file))[0];
  const src = frame ? null : await createImageBitmap(file);
  const w0 = frame ? frame.w : src.width, h0 = frame ? frame.h : src.height;
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w0 * s);
  canvas.height = Math.round(h0 * s);
  const ctx = canvas.getContext('2d');
  if (frame) {
    const c = new OffscreenCanvas(w0, h0);
    c.getContext('2d').putImageData(new ImageData(frame.rgba, w0, h0), 0, 0);
    ctx.drawImage(c, 0, 0, canvas.width, canvas.height);
  } else ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Reverse slice order in place (first B-scan inferior → superior-first convention). */
export function flipSlices(vol) {
  const { w, h, d, data } = vol, n = w * h, tmp = new Uint8Array(n);
  for (let k = 0; k < Math.floor(d / 2); k++) {
    const a = k * n, b = (d - 1 - k) * n;
    tmp.set(data.subarray(a, a + n));
    data.copyWithin(a, b, b + n);
    data.set(tmp, b);
  }
}
