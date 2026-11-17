import './style.css';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { state, LAYERS, octToFundusMM, fundusMMToPx, fundusMMPerPx, discMM, octXmm, octZmm, hasGeom, geomPx } from './state.js';
import { parseVol, parseHeyexXml } from './io/heidelberg.js';
import { parseDukeMat } from './io/matlab.js';
import { compareToDevice, fillDeviceSeg } from './processing/compare.js';
import { PRESETS, loadOctFiles, loadFundusFile, flipSlices } from './io/loaders.js';
import { generatePhantom } from './synth/phantom.js';
import { detectLandmarks, meanFundusColor } from './processing/landmarks.js';
import { runSegmentation } from './processing/segment.js';
import { computeAnalysis } from './processing/analysis.js';
import { Viewer } from './render/viewer.js';
import { BscanPanel, MapPanel, RegPanel, renderStats } from './ui/panels.js';
import { thicknessGradientCSS } from './util.js';

const $ = (id) => document.getElementById(id);
const viewer = new Viewer($('viewport'));
const eye = viewer.eye, retina = viewer.retina;

// ------------------------------------------------------------------ helpers
const busy = (text) => { $('busy').hidden = !text; if (text) $('busyText').textContent = text; };
const setStatus = (id, text, cls = '') => { const el = $(id); el.textContent = text; el.className = `status ${cls}`; };
document.querySelector('.legend-bar').style.background = thicknessGradientCSS(150, 450);

let fundusTexCanvas = null, fundusPlainTex = null;

function prepareFundusTexture() {
  const f = state.fundus;
  if (!f) { fundusTexCanvas = null; fundusPlainTex?.dispose(); fundusPlainTex = null; return; }
  // texture with a feathered alpha mask so the photo blends into the procedural periphery
  const { width: W, height: H } = f.canvas;
  const m = document.createElement('canvas');
  m.width = W; m.height = H;
  const mctx = m.getContext('2d', { willReadFrequently: true });
  const src = f.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  const mask = mctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const l = 0.3 * src.data[i * 4] + 0.59 * src.data[i * 4 + 1] + 0.11 * src.data[i * 4 + 2];
    mask.data[i * 4 + 3] = l > 14 ? 255 : 0;
  }
  mctx.putImageData(mask, 0, 0);
  const b = document.createElement('canvas');
  b.width = W; b.height = H;
  const bctx = b.getContext('2d', { willReadFrequently: true });
  bctx.filter = `blur(${Math.max(2, W * 0.012)}px)`;
  bctx.drawImage(m, 0, 0);
  const blurred = bctx.getImageData(0, 0, W, H).data;
  const out = new ImageData(new Uint8ClampedArray(src.data), W, H);
  let grey = true;
  for (let i = 0; i < W * H && grey; i += 997) { const r = src.data[i * 4], g = src.data[i * 4 + 1], b = src.data[i * 4 + 2]; if (Math.abs(r - g) > 6 || Math.abs(g - b) > 6) grey = false; }
  f.isGrey = grey;
  if (grey && $('inTint').checked) {
    // monochrome (IR-SLO / red-free) → fundus-like pseudo-colour for the 3D views only
    for (let i = 0; i < W * H; i++) {
      const l = src.data[i * 4 + 1] / 255;
      out.data[i * 4] = 255 * Math.min(1, 0.18 + 1.05 * l);
      out.data[i * 4 + 1] = 255 * Math.min(1, 0.05 + 0.78 * l ** 1.5);
      out.data[i * 4 + 2] = 255 * Math.min(1, 0.03 + 0.6 * l ** 2.2);
    }
  }
  for (let i = 0; i < W * H; i++) {
    const a = blurred[i * 4 + 3] / 255, t = Math.min(1, Math.max(0, (a - 0.55) / 0.4));
    out.data[i * 4 + 3] = t * t * (3 - 2 * t) * 255;
  }
  fundusTexCanvas = document.createElement('canvas');
  fundusTexCanvas.width = W; fundusTexCanvas.height = H;
  fundusTexCanvas.getContext('2d').putImageData(out, 0, 0);
  fundusPlainTex?.dispose();
  const plain = document.createElement('canvas');
  plain.width = W; plain.height = H;
  const opaque = new ImageData(new Uint8ClampedArray(out.data), W, H);
  for (let i = 0; i < W * H; i++) opaque.data[i * 4 + 3] = 255;
  plain.getContext('2d').putImageData(opaque, 0, 0);
  fundusPlainTex = new THREE.CanvasTexture(plain);
  fundusPlainTex.colorSpace = THREE.SRGBColorSpace;
  fundusPlainTex.anisotropy = 8;
}

// ------------------------------------------------------------------ panels
const bscan = new BscanPanel($('bscanCanvas'), (canvas) => retina.setSlice(state.slice, canvas), () => {
  afterAnalysis(); mapPanel.draw(); renderStats($('stats')); update3D();
  setStatus('segStatus', `Manual correction applied (B-scan ${state.slice + 1}). CST ${Math.round(state.analysis.sectors.C)} µm.`, 'ok');
});
$('editLayer').onchange = (e) => { bscan.editLayer = e.target.value || null; $('bscanCanvas').style.cursor = bscan.editLayer ? 'crosshair' : ''; };
const mapPanel = new MapPanel($('mapCanvas'), (k) => setSlice(k));
// mouse wheel / trackpad scrolling over the B-scan or en-face map steps through B-scans
for (const id of ['bscanCanvas', 'mapCanvas']) {
  let acc = 0;
  $(id).addEventListener('wheel', (e) => {
    if (!state.volume || state.volume.d < 2) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // lines → pixels
    if (Math.abs(dy) >= 50) { acc = 0; setSlice(state.slice + Math.sign(dy)); return; } // mouse-wheel notch → 1 B-scan
    acc += dy; // trackpad: continuous, ~30 px per B-scan
    const steps = Math.trunc(acc / 30);
    if (steps) { acc -= steps * 30; setSlice(state.slice + steps); }
  }, { passive: false });
}
const reg = new RegPanel($('regCanvas'), (mode, p) => {
  if (mode === 'fovea') state.fundus.fovea = p; else state.fundus.disc = p;
  setModeButtons(null);
  refreshFundusDependent();
});

function setSlice(k) {
  if (!state.volume) return;
  state.slice = Math.max(0, Math.min(state.volume.d - 1, k));
  $('sliceSlider').value = state.slice;
  $('sliceLabel').textContent = `${state.slice + 1} / ${state.volume.d}  ·  y = ${octZmm(state.slice).toFixed(2)} mm`;
  bscan.draw();
  mapPanel.draw();
}

// ------------------------------------------------------------------ 3D updates
const fundusUV = () => {
  if (!state.fundus) return null;
  const f = state.fundus;
  return (X, Z) => { const p = fundusMMToPx(octToFundusMM(X, Z)); return { u: p.x / f.width, v: 1 - p.y / f.height }; };
};

function update3D({ rebuildRetina = true } = {}) {
  const f = state.fundus;
  if (f) {
    eye.setFundus(f, { texCanvas: fundusTexCanvas, mmPerPx: fundusMMPerPx(), baseColor: meanFundusColor(fundusTexCanvas, f.fovea, f.fovDiamPx / 2) });
  } else eye.setFundus(null);
  eye.setDisc(discMM());
  eye.setAxialLength(state.axialLength);
  eye.setOctPatch({
    vol: state.volume, analysis: state.analysis, map: octToFundusMM,
    visible: $('eyePatch').checked, mode: $('eyePatchMode').value, exag: +$('eyeExag').value,
  });
  if (rebuildRetina) {
    retina.setData({ vol: state.volume, seg: state.seg, analysis: state.analysis, fundusTex: fundusPlainTex, fundusUV: fundusUV() });
    retina.setSlice(state.slice, bscan.native);
  }
  $('legend').hidden = !state.analysis || (viewer.mode === 'eye' && $('eyePatchMode').value !== 'thickness');
  updateHud();
}

function updateHud() {
  const parts = [];
  if (viewer.mode === 'pathway') {
    $('hudTitle').textContent = 'Visual pathway · eye to visual cortex';
    parts.push('Anatomical illustration (standard adult anatomy, not patient-specific)');
    parts.push('Streamlines coloured by visual hemifield: nasal retinal fibres cross at the chiasm');
  } else if (viewer.mode === 'eye') {
    $('hudTitle').textContent = 'Anatomical eye';
    parts.push(`Axial length ${state.axialLength.toFixed(1)} mm · ${state.laterality}`);
    parts.push(!state.fundus ? 'Procedural fundus (no photo loaded)'
      : state.fundus.isGrey && $('inTint').checked ? `Retina textured with the ${state.fundus.isSlo ? 'IR-SLO' : 'monochrome fundus'} (pseudo-coloured)`
      : 'Retina textured with the registered fundus photo');
    if (hasGeom()) parts.push('OCT↔fundus registration from device geometry');
    if (state.analysis) parts.push(`OCT macular relief ×${$('eyeExag').value}`);
    parts.push('Anterior segment: schematic-eye biometry');
  } else {
    $('hudTitle').textContent = 'Retina detail · OCT reconstruction';
    if (state.volume) parts.push(`${state.volume.widthMM}×${state.volume.lengthMM} mm · ${state.volume.w}×${state.volume.h}×${state.volume.d} voxels · depth ×${retina.opts.exag}`);
    else parts.push('Load OCT data to reconstruct the retina');
  }
  $('hudSub').textContent = parts.join('  ·  ');
}

function refreshAll() {
  reg.draw(); bscan.draw(); mapPanel.draw();
  renderStats($('stats'));
  $('statsLat').textContent = state.laterality;
  update3D();
}

function refreshFundusDependent() {
  prepareFundusTexture();
  reg.draw();
  update3D();
}

// ------------------------------------------------------------------ data loading
function setFundus(canvas, fovDeg, extra = {}) {
  const lm = detectLandmarks(canvas);
  state.fundus = { canvas, width: canvas.width, height: canvas.height, fovDeg, ...lm, ...extra };
  state.laterality = lm.laterality;
  $('inLat').value = lm.laterality;
  prepareFundusTexture();
}

function setVolume(vol) {
  const p = currentDims();
  state.volume = { ...vol, ...p, ...(vol.widthMM ? { widthMM: vol.widthMM, lengthMM: vol.lengthMM, depthMM: vol.depthMM } : {}) };
  if ($('inFlip').checked) flipSlices(state.volume);
  state.seg = null; state.analysis = null;
  $('sliceSlider').max = state.volume.d - 1;
  setSlice(Math.floor(state.volume.d / 2));
  $('inW').value = state.volume.widthMM; $('inL').value = state.volume.lengthMM; $('inD').value = state.volume.depthMM;
}

function currentDims() { return { widthMM: +$('inW').value, lengthMM: +$('inL').value, depthMM: +$('inD').value }; }

function dataSummary() {
  const s = [];
  if (state.fundus) s.push(`Fundus ${state.fundus.width}×${state.fundus.height}px, ${state.fundus.fovDeg}° (${state.laterality}).`);
  if (state.volume) s.push(`OCT ${state.volume.d} B-scans of ${state.volume.w}×${state.volume.h}px (${state.volume.widthMM}×${state.volume.lengthMM}×${state.volume.depthMM} mm).`);
  setStatus('dataStatus', s.join(' ') || 'No data loaded.', s.length ? 'ok' : '');
}

/** Re-run analysis and everything derived from it (fovea on SLO, device comparison). */
function afterAnalysis() {
  state.analysis = computeAnalysis(state.volume, state.seg, state.laterality);
  if (hasGeom()) {
    // exact: the OCT fovea's position on the SLO comes from the recorded B-scan geometry
    state.fundus.fovea = geomPx(state.analysis.fovea.x, state.analysis.fovea.z);
    prepareFundusTexture();
  }
  state.comparison = state.deviceSeg ? compareToDevice(state) : null;
}

async function segment() {
  if (!state.volume) return setStatus('segStatus', 'Load an OCT volume first.', 'err');
  $('btnSeg').disabled = true;
  busy('Segmenting retinal layers…');
  const t0 = performance.now();
  try {
    state.seg = await runSegmentation(state.volume, +$('segSmooth').value, (v) => {
      $('segProgress').style.width = `${v * 100}%`;
      $('busyText').textContent = `Segmenting retinal layers… ${Math.round(v * 100)}%`;
    });
    afterAnalysis();
    setStatus('segStatus', `5 boundaries × ${state.volume.d} B-scans in ${((performance.now() - t0) / 1000).toFixed(1)} s. CST ${Math.round(state.analysis.sectors.C)} µm. Check the B-scan overlay for errors.`, 'ok');
    if (viewer.mode === 'eye' && !$('eyePatchMode').value) $('eyePatchMode').value = 'thickness';
    refreshAll();
  } catch (e) {
    console.error(e);
    setStatus('segStatus', `Segmentation failed: ${e.message || e}`, 'err');
  } finally { busy(null); $('btnSeg').disabled = false; }
}

$('btnDemo').onclick = async () => {
  busy('Generating synthetic case…');
  try {
    const ph = await generatePhantom((v, msg) => { $('busyText').textContent = msg; });
    state.axialLength = ph.axialLength; $('inAL').value = ph.axialLength;
    $('inFov').value = ph.fovDeg; $('preset').value = 'custom'; $('inFlip').checked = false;
    state.reg = { dx: 0, dy: 0, rot: 0, scale: 1 }; syncRegSliders();
    state.geom = state.deviceSeg = state.deviceStats = state.comparison = state.refLabel = null;
    setFundus(ph.fundusCanvas, ph.fovDeg);
    setVolume(ph.volume);
    dataSummary();
    refreshAll();
    await segment();
  } finally { busy(null); }
};

$('fileFundus').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  busy('Loading fundus photo…');
  try { setFundus(await loadFundusFile(file), +$('inFov').value); state.reg = { dx: 0, dy: 0, rot: 0, scale: 1 }; syncRegSliders(); dataSummary(); refreshAll(); }
  catch (err) { setStatus('dataStatus', `Could not read fundus: ${err.message}`, 'err'); }
  finally { busy(null); }
};

$('fileOct').onchange = async (e) => {
  if (!e.target.files.length) return;
  busy('Loading OCT B-scans…');
  try {
    const files = [...e.target.files];
    if (files.some((f) => /\.vol$/i.test(f.name)) || files.some((f) => /\.xml$/i.test(f.name))) {
      const vf = files.find((f) => /\.vol$/i.test(f.name));
      const dev = vf ? await parseVol(vf, (v) => ($('busyText').textContent = `Reading ${vf.name}… ${Math.round(v * 100)}%`))
        : await parseHeyexXml(files, (v) => ($('busyText').textContent = `Reading Heyex XML export… ${Math.round(v * 100)}%`));
      await loadDevice(dev, vf ? vf.name : 'Heyex XML export');
      return;
    }
    const mf = files.find((f) => /\.mat$/i.test(f.name));
    if (mf) { // MATLAB volume (e.g. Duke DME dataset) with optional expert tracings; size from the fields above
      const dev = await parseDukeMat(mf, { grader: 1, dims: currentDims() });
      await loadDevice(dev, mf.name);
      return;
    }
    const vol = await loadOctFiles(e.target.files);
    state.geom = state.deviceSeg = state.deviceStats = state.comparison = state.refLabel = null;
    setVolume({ ...vol, ...currentDims() });
    dataSummary();
    refreshAll();
    if (vol.d < 2) setStatus('segStatus', 'Only one B-scan: 2D segmentation works, 3D surfaces need a volume (≥2 B-scans).', 'err');
  } catch (err) { setStatus('dataStatus', `Could not read OCT: ${err.message}`, 'err'); }
  finally { busy(null); }
};

async function loadDevice(dev, name) {
  $('preset').value = 'custom'; $('inFlip').checked = false;
  state.reg = { dx: 0, dy: 0, rot: 0, scale: 1 }; syncRegSliders();
  state.geom = dev.geom ? { ...dev.geom, sloScale: dev.sloScale } : null;
  state.deviceSeg = dev.deviceSeg || null; state.deviceStats = dev.deviceStats || null;
  state.refLabel = dev.refLabel || (dev.deviceSeg ? 'device' : null);
  $('btnDeviceSeg').textContent = state.refLabel && state.refLabel !== 'device' ? 'Use expert layers' : 'Use device layers';
  if (dev.slo) {
    $('inFov').value = dev.fovDeg;
    // IR-SLO: the optic disc is not reliably the brightest blob (drusen, reflexes), so use the
    // population position until the user clicks the disc
    setFundus(dev.slo, dev.fovDeg, { isSlo: true, mmPerPx: dev.sloScale, disc: null });
  }
  if (dev.laterality) { state.laterality = dev.laterality; $('inLat').value = dev.laterality; }
  setVolume(dev.volume);
  dataSummary();
  const extras = [dev.slo && 'IR-SLO localizer', dev.geom && 'B-scan positions', dev.deviceSeg && `${state.refLabel} layers`].filter(Boolean);
  setStatus('dataStatus', `${name}: ${$('dataStatus').textContent}${extras.length ? ` ${extras.join(' + ')} loaded.` : ''}`, 'ok');
  refreshAll();
  busy(null);
  await segment();
}

$('btnDeviceSeg').onclick = () => {
  if (!state.deviceSeg || !state.volume) return;
  state.seg = { surfaces: fillDeviceSeg(state.deviceSeg, state.volume), device: true };
  afterAnalysis();
  setStatus('segStatus', `Showing the ${state.refLabel === 'device' ? 'device (Heidelberg)' : state.refLabel} segmentation. Run segmentation to switch back to OcuForm.`, 'ok');
  refreshAll();
};
$('inTint').onchange = () => refreshFundusDependent();

// presets & parameters
for (const [k, p] of Object.entries(PRESETS)) $('preset').add(new Option(p.label, k));
$('preset').value = 'spectralis';
$('preset').onchange = () => {
  const p = PRESETS[$('preset').value];
  if (!p.widthMM) return;
  $('inW').value = p.widthMM; $('inL').value = p.lengthMM; $('inD').value = p.depthMM;
  applyDims();
};
function applyDims() {
  if (!state.volume) return;
  Object.assign(state.volume, currentDims());
  if (state.seg) afterAnalysis();
  dataSummary(); refreshAll();
}
for (const id of ['inW', 'inL', 'inD']) $(id).onchange = () => { $('preset').value = 'custom'; applyDims(); };
$('inFov').onchange = () => { if (state.fundus) { state.fundus.fovDeg = +$('inFov').value; dataSummary(); refreshFundusDependent(); } };
$('inAL').onchange = () => { state.axialLength = +$('inAL').value; refreshFundusDependent(); };
$('inLat').onchange = () => {
  state.laterality = $('inLat').value;
  if (state.seg) afterAnalysis();
  refreshAll();
};
$('inFlip').onchange = () => {
  if (!state.volume) return;
  flipSlices(state.volume);
  if (state.seg) {
    const { w, d } = state.volume;
    for (const L of LAYERS) {
      const S = state.seg.surfaces[L.key], c = S.slice();
      for (let k = 0; k < d; k++) S.set(c.subarray((d - 1 - k) * w, (d - k) * w), k * w);
    }
    afterAnalysis();
  }
  refreshAll();
};

// ------------------------------------------------------------------ registration
function bindSlider(id, fmt, fn) {
  const el = $(id), out = el.parentElement.querySelector('output');
  const show = () => (out.textContent = fmt(+el.value));
  el.addEventListener('input', () => { show(); fn(+el.value); });
  show();
  return { set: (v) => { el.value = v; show(); } };
}
const regSliders = {
  dx: bindSlider('regDx', (v) => `${v.toFixed(2)}`, (v) => { state.reg.dx = v; regChanged(); }),
  dy: bindSlider('regDy', (v) => `${v.toFixed(2)}`, (v) => { state.reg.dy = v; regChanged(); }),
  rot: bindSlider('regRot', (v) => `${v.toFixed(1)}°`, (v) => { state.reg.rot = v; regChanged(); }),
  scale: bindSlider('regScale', (v) => `${v.toFixed(3)}`, (v) => { state.reg.scale = v; regChanged(); }),
};
function syncRegSliders() { for (const k of Object.keys(regSliders)) regSliders[k].set(state.reg[k]); }
bindSlider('regAlpha', (v) => v.toFixed(2), (v) => { reg.alpha = v; reg.draw(); });
let regTimer = 0;
function regChanged() {
  reg.draw();
  clearTimeout(regTimer);
  regTimer = setTimeout(() => update3D(), 120);
}
function setModeButtons(mode) {
  reg.mode = mode;
  $('btnSetFovea').classList.toggle('on', mode === 'fovea');
  $('btnSetDisc').classList.toggle('on', mode === 'disc');
}
$('btnSetFovea').onclick = () => setModeButtons(reg.mode === 'fovea' ? null : 'fovea');
$('btnSetDisc').onclick = () => setModeButtons(reg.mode === 'disc' ? null : 'disc');
$('btnAuto').onclick = () => {
  if (!state.fundus) return;
  Object.assign(state.fundus, detectLandmarks(state.fundus.canvas));
  state.reg = { dx: 0, dy: 0, rot: 0, scale: 1 }; syncRegSliders();
  refreshFundusDependent();
};

// ------------------------------------------------------------------ segmentation & slices
bindSlider('segSmooth', (v) => v.toFixed(1), () => {});
$('btnSeg').onclick = segment;
$('sliceSlider').oninput = (e) => setSlice(+e.target.value);
$('bscanOverlay').onchange = (e) => { bscan.overlay = e.target.checked; bscan.draw(); };
$('mapMode').onchange = (e) => { mapPanel.mode = e.target.value; mapPanel.draw(); };

// ------------------------------------------------------------------ 3D controls
document.querySelectorAll('#viewMode button').forEach((b) => (b.onclick = async () => {
  const mode = b.dataset.mode;
  document.querySelectorAll('#viewMode button').forEach((x) => x.classList.toggle('active', x === b));
  if (mode === 'pathway' && !viewer.pathway) {
    busy('Building the visual pathway…');
    await new Promise((r) => setTimeout(r, 30));
    try { applyPathwayControls(await viewer.ensurePathway()); } finally { busy(null); }
  }
  viewer.setMode(mode);
  $('eyeCtrls').hidden = mode !== 'eye';
  $('retinaCtrls').hidden = mode !== 'retina';
  $('pathCtrls').hidden = mode !== 'pathway';
  $('legend').hidden = !state.analysis || mode === 'pathway' || (mode === 'eye' && $('eyePatchMode').value !== 'thickness');
  updateHud();
}));
function applyPathwayControls(p) {
  p.setBrainOpacity(+$('pathBrain').value);
  p.setNerveOpacity(+$('pathNerve').value);
  p.setBrainCut($('pathCut').value);
  p.setIris($('eyeIris').value);
  document.querySelectorAll('#pathCtrls [data-part]').forEach((c) => p.setVisible(c.dataset.part, c.checked));
}
bindSlider('pathBrain', (v) => (v < 0.01 ? 'off' : v > 0.98 ? 'solid' : `${Math.round(v * 100)}%`), (v) => viewer.pathway?.setBrainOpacity(v));
bindSlider('pathNerve', (v) => (v > 0.98 ? 'solid' : `${Math.round(v * 100)}%`), (v) => viewer.pathway?.setNerveOpacity(v));
$('pathCut').onchange = (e) => viewer.pathway?.setBrainCut(e.target.value);
document.querySelectorAll('#pathCtrls [data-part]').forEach((c) => (c.onchange = () => viewer.pathway?.setVisible(c.dataset.part, c.checked)));
bindSlider('eyeCut', (v) => (v < 0.01 ? 'off' : `${Math.round(v * 100)}%`), (v) => eye.setCut(v));
eye.setCut(0.5);
bindSlider('eyePupil', (v) => v.toFixed(1), (v) => eye.setPupil(v));
let exagTimer = 0;
bindSlider('eyeExag', (v) => `×${v}`, () => { clearTimeout(exagTimer); exagTimer = setTimeout(() => update3D({ rebuildRetina: false }), 60); });
$('eyePatch').onchange = () => update3D({ rebuildRetina: false });
$('eyePatchMode').onchange = () => update3D({ rebuildRetina: false });
$('eyeIris').onchange = (e) => { eye.setIris(e.target.value); viewer.pathway?.setIris(e.target.value); };

const lt = $('layerToggles');
for (const L of LAYERS) {
  const lab = document.createElement('label');
  lab.className = 'check';
  lab.innerHTML = `<input type="checkbox" ${retina.visible[L.key] ? 'checked' : ''}/> <span class="swatch" style="background:${L.color}"></span> ${L.name}`;
  lab.querySelector('input').onchange = (e) => { retina.visible[L.key] = e.target.checked; retina.applyVisibility(); };
  lt.appendChild(lab);
}
let retTimer = 0;
bindSlider('retExag', (v) => `×${v.toFixed(1)}`, (v) => {
  retina.opts.exag = v;
  clearTimeout(retTimer);
  retTimer = setTimeout(() => { retina.setData({ vol: state.volume, seg: state.seg, analysis: state.analysis, fundusTex: fundusPlainTex, fundusUV: fundusUV() }); retina.setSlice(state.slice, bscan.native); updateHud(); }, 80);
});
$('retIlmMode').onchange = (e) => { retina.opts.ilmMode = e.target.value; update3D(); };
$('retVolMode').onchange = (e) => { retina.opts.volMode = e.target.value; retina.applyVisibility(); };
$('retBscan').onchange = (e) => { retina.opts.showBscan = e.target.checked; retina.applyVisibility(); };
bindSlider('retVolOp', (v) => v.toFixed(2), (v) => { retina.opts.volOpacity = v; retina.applyVisibility(); });
bindSlider('retVolLo', (v) => v.toFixed(2), (v) => { retina.opts.volLo = v; retina.applyVisibility(); });
bindSlider('retClip', (v) => `${Math.round(v * 100)}%`, (v) => { retina.opts.clip = v; retina.applyVisibility(); });

// ------------------------------------------------------------------ export
const download = (url, name) => { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); };
$('btnPng').onclick = () => download(viewer.screenshot(), `ocuform-${viewer.mode}.png`);
$('btnCsv').onclick = () => {
  const a = state.analysis, v = state.volume;
  if (!a) return;
  const lines = [['z_mm\\x_mm', ...Array.from({ length: v.w }, (_, i) => octXmm(i).toFixed(4))].join(',')];
  for (let k = 0; k < v.d; k++) lines.push([octZmm(k).toFixed(4), ...Array.from(a.thickness.subarray(k * v.w, (k + 1) * v.w), (t) => t.toFixed(1))].join(','));
  download(URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), 'retinal-thickness-um.csv');
};
$('btnGlb').onclick = () => {
  const g = new THREE.Group();
  for (const [k, m] of Object.entries(retina.surfaces)) { const c = m.clone(); c.name = k; g.add(c); }
  if (!g.children.length) return;
  new GLTFExporter().parse(g, (buf) => download(URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' })), 'retina-surfaces.glb'),
    (err) => console.error(err), { binary: true });
};

// initial paint
dataSummary();
refreshAll();
window.ocuform = { state, viewer };

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || !state.volume) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setSlice(state.slice + 1); e.preventDefault(); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setSlice(state.slice - 1); e.preventDefault(); }
});
