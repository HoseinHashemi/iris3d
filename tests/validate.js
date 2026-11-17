// Validation harness — run in the browser console of the dev server:
//   const v = await import('/tests/validate.js'); await v.runAll();
// Needs the sample files in /test-data (see README). Results are logged and returned.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = () => window.iris3d.state;
const r1 = (v) => (Number.isFinite(v) ? +v.toFixed(1) : null);

const reset = () => { const s = S(); s.analysis = null; s.comparison = null; };

async function loadFiles(paths) {
  reset();
  const dt = new DataTransfer();
  for (const p of paths) dt.items.add(new File([await (await fetch(`/test-data/${p}`)).blob()], p.split('/').pop()));
  const inp = document.getElementById('fileOct');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));
}
async function waitDone(pred, timeout = 300000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) { await sleep(1000); if (pred()) return (performance.now() - t0) / 1000; }
  throw new Error('timeout');
}
const sec = (o) => o && Object.fromEntries(['C', 'S1', 'N1', 'I1', 'T1', 'S3', 'N3', 'I3', 'T3'].map((k) => [k, Number.isFinite(o[k]) ? Math.round(o[k]) : null]));

function deviceReport(name, seconds) {
  const s = S(), c = s.comparison;
  const out = {
    case: name, seconds: Math.round(seconds),
    dims: `${s.volume.w}×${s.volume.h}×${s.volume.d}, ${s.volume.widthMM}×${s.volume.lengthMM} mm`,
    boundaries_um: Object.fromEntries(Object.entries(c.layers).map(([k, v]) => [k, v && { bias: r1(v.bias), mae: r1(v.mae), p95: r1(v.p95) }])),
    thickness_um: { bias: r1(c.thickness.bias), mae: r1(c.thickness.mae), p95: r1(c.thickness.p95) },
    etdrs_iris3d: sec(s.analysis.sectors), etdrs_deviceLayers: sec(c.devAnalysis.sectors), etdrs_deviceReported: sec(c.reported),
  };
  console.log(out);
  return out;
}

export async function phantom() {
  reset();
  document.getElementById('btnDemo').click();
  const t = await waitDone(() => S().analysis && S().volume?.d === 97 && !S().deviceSeg);
  const s = S(), v = s.volume, Sf = s.seg.surfaces, w = v.w, h = v.h, d = v.d, um = (v.depthMM * 1000) / h;
  const off = { x: 0.12, y: -0.08 };
  const eI = [], eB = [], eT = [];
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    const xm = (x / (w - 1) - 0.5) * 6, ym = (z / (d - 1) - 0.5) * 6, rx = xm + off.x, ry = ym + off.y, r = Math.hypot(rx, ry);
    const fov = Math.exp(-((r / 0.4) ** 2)), q = (k) => 1 - Math.exp(-((r / k) ** 2));
    const bm = h * 0.7 - 1.4 * (xm * xm + ym * ym) + 2 * xm;
    const elm = 64 + 12 * fov, on = elm + 45 + 105 * Math.exp(-((r / 0.75) ** 2)), op = on + 24 * q(0.35), inl = op + 40 * q(0.45), ipl = inl + 40 * q(0.45);
    const gcl = ipl + q(0.4) * (18 + 42 * Math.exp(-(((r - 1) / 0.65) ** 2)));
    const ilm = gcl + q(0.6) * Math.min(70, 8 + 5 * r + 14 * Math.max(0, rx) + 6 * Math.abs(ry));
    const i = z * w + x;
    eI.push((Sf.ILM[i] - (bm - ilm / um)) * um); eB.push((Sf.BM[i] - bm) * um); eT.push(s.analysis.thickness[i] - ilm);
  }
  const st = (a) => { const abs = a.map(Math.abs).sort((p, q) => p - q); return { bias: r1(a.reduce((p, q) => p + q, 0) / a.length), mae: r1(abs.reduce((p, q) => p + q, 0) / a.length), p95: r1(abs[Math.floor(a.length * 0.95)]) }; };
  const out = { case: 'synthetic phantom (ground truth)', seconds: Math.round(t), ILM: st(eI), BM: st(eB), thickness: st(eT), foveaError_mm: r1(Math.hypot(s.analysis.fovea.x + off.x, s.analysis.fovea.z + off.y) * 10) / 10 };
  console.log(out);
  return out;
}

export async function vol(name) {
  await loadFiles([name]);
  const t = await waitDone(() => S().comparison && S().analysis && document.getElementById('fileOct').files[0]?.name === name && !document.getElementById('btnSeg').disabled);
  return deviceReport(name, t);
}

export async function xml(dir = 'drusen_patient/drusen_patient', file = 'metaclean.xml') {
  const text = await (await fetch(`/test-data/${dir}/${file}`)).text();
  const tifs = [...new Set([...text.matchAll(/[\\/]([A-Za-z0-9_]+\.tif)/g)].map((m) => m[1]))];
  await loadFiles([`${dir}/${file}`, ...tifs.map((t) => `${dir}/${t}`)]);
  const t = await waitDone(() => S().comparison && S().deviceStats && S().volume?.d === tifs.length - 1 && !document.getElementById('btnSeg').disabled);
  return deviceReport(`${file} (Heyex XML)`, t);
}

export async function runAll() {
  const res = [await phantom(), await vol('layers.vol'), await xml(), await vol('healthy_OD.vol')];
  console.table(res.map((r) => ({ case: r.case, thicknessBias: (r.thickness || r.thickness_um).bias, thicknessMAE: (r.thickness || r.thickness_um).mae, thicknessP95: (r.thickness || r.thickness_um).p95 })));
  return res;
}
