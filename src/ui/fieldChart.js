// Lesion presets for the visual-pathway view, the visual-field chart (grey-scale, as the patient sees
// it, left eye on the left like a perimetry printout) and a plain-language name for the defect.
// The field maps themselves are computed from which modelled fibres the lesion interrupts
// (VisualPathway.fieldMaps), so presets are only lesion positions, not hard-coded fields.

// Head frame (mm): origin at the chiasm, +x = patient's left, +y = superior, +z = anterior.
export const LESIONS = {
  onL: {
    label: 'Left optic nerve', c: [11.5, -4.8, 22], r: [3.6, 3.6, 3.6],
    note: 'Optic neuritis, trauma or compression of one optic nerve: loss is confined to that eye (with a relative afferent pupillary defect).',
  },
  junction: {
    label: 'Left optic nerve–chiasm junction', c: [3.6, -0.6, 3.0], r: [2.9, 2.9, 2.9],
    note: 'Junctional scotoma: a lesion where the nerve meets the chiasm (e.g. meningioma) blinds that eye and catches crossing fibres of the other eye, giving a temporal defect in the fellow eye — easily missed unless both eyes are tested.',
  },
  adenoma: {
    label: 'Pituitary macroadenoma (chiasm from below)', c: [0, -4.6, 0.6], r: [2.5, 4.7, 4.6], tumour: true,
    note: 'The tumour presses the crossing nasal fibres from below: inferonasal fibres go first, so the defect starts in the upper temporal fields and grows into a bitemporal hemianopia. Use "Lesion size" to grow the tumour.',
  },
  chiasmLat: {
    label: 'Right lateral chiasm (carotid aneurysm)', c: [-5.6, 0.4, 0.3], r: [1.4, 2.4, 1.7],
    note: 'Pressure on the side of the chiasm hits the uncrossed temporal-retina fibres of that eye only: a nasal hemianopia of the right eye (rare; classically an internal carotid aneurysm).',
  },
  tractR: {
    label: 'Right optic tract', c: [-13.8, 3.2, -16], r: [3.4, 3.4, 3.4],
    note: 'Behind the chiasm every lesion is homonymous. Real tract lesions are typically incongruous (the two eyes’ defects differ) because fibres from corresponding points are not yet aligned; this model is perfectly congruous.',
  },
  lgnL: {
    label: 'Left lateral geniculate nucleus', c: [23, 8.2, -28.5], r: [3.8, 3.2, 5.2],
    note: 'Complete LGN damage gives a contralateral homonymous hemianopia (partial lesions from the anterior or lateral choroidal arteries give sectoral defects).',
  },
  meyerL: {
    label: "Left temporal lobe (Meyer's loop)", c: [33.5, -1, -16], r: [6.5, 6.5, 8],
    note: '"Pie in the sky": Meyer’s loop carries the upper contralateral field, so temporal-lobe tumours, abscesses or temporal lobectomy cause a superior homonymous quadrantanopia.',
  },
  parietalL: {
    label: 'Left parietal lobe (dorsal radiation)', c: [31, 19, -54], r: [4.6, 4.6, 6.5],
    note: '"Pie on the floor": the dorsal radiation through the parietal lobe carries the lower contralateral field.',
  },
  pcaL: {
    label: 'Left occipital infarct (PCA stroke)', c: [7, 15.5, -75], r: [8, 11, 13],
    note: 'Posterior cerebral artery stroke: contralateral homonymous hemianopia, often with macular sparing because the occipital pole also receives blood from the middle cerebral artery.',
  },
  poleL: {
    label: 'Left occipital pole', c: [6, 17.4, -101], r: [5, 6, 5],
    note: 'The macula is mapped to the occipital pole, so a small pole lesion (trauma, watershed infarct) gives a contralateral homonymous central scotoma with a normal periphery.',
  },
};

const SIDE = { L: 'left', R: 'right' };
const Q = ['LS', 'RS', 'LI', 'RI'];

/** Loss fractions per eye and quadrant, peripheral (ecc ≥ 0.3) and central (ecc < 0.2). */
function quadrantLoss(map, N) {
  const acc = {};
  for (const k of Q) acc[k] = { p: 0, np: 0, c: 0, nc: 0 };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const v = map[j * N + i];
    if (Number.isNaN(v)) continue;
    const fx = 1 - ((i + 0.5) * 2) / N, fy = 1 - ((j + 0.5) * 2) / N, r = Math.hypot(fx, fy);
    const a = acc[(fx > 0 ? 'L' : 'R') + (fy > 0 ? 'S' : 'I')];
    if (r >= 0.3) { a.p += 1 - v; a.np++; } else if (r < 0.2) { a.c += 1 - v; a.nc++; }
  }
  const out = {};
  for (const k of Q) out[k] = { p: acc[k].p / acc[k].np, c: acc[k].c / acc[k].nc };
  return out;
}

const temporalSide = (eye) => (eye === 'OS' ? 'L' : 'R');

function eyeWords(eye, L) {
  const lost = Q.filter((k) => L[k].p > 0.5), part = Q.filter((k) => L[k].p > 0.12 && L[k].p <= 0.5);
  const centralOnly = !lost.length && !part.length && Q.some((k) => L[k].c > 0.4);
  const tn = (s) => (s === temporalSide(eye) ? 'temporal' : 'nasal');
  const quad = (k) => `${k[1] === 'S' ? 'supero' : 'infero'}${tn(k[0])}`;
  if (lost.length === 4) return 'blind (complete field loss)';
  if (centralOnly) return 'central scotoma';
  if (lost.length === 3) return 'loss of three quadrants';
  if (lost.length === 2 && lost[0][0] === lost[1][0]) return `${tn(lost[0][0])} hemianopia`;
  if (lost.length === 2 && lost[0][1] === lost[1][1]) return `${lost[0][1] === 'S' ? 'superior' : 'inferior'} altitudinal defect`;
  if (lost.length) return lost.map((k) => `${quad(k)} quadrant defect`).join(' + ') + (part.length ? ' (with partial loss elsewhere)' : '');
  if (part.length) return `partial ${part.map(quad).join(' and ')} defect`;
  return 'normal';
}

/** Plain-language name of the binocular field defect. */
export function describeFields(maps) {
  const L = { OS: quadrantLoss(maps.OS, maps.N), OD: quadrantLoss(maps.OD, maps.N) };
  const lost = (e) => Q.filter((k) => L[e][k].p > 0.5).sort().join(',');
  const any = (e) => Q.some((k) => L[e][k].p > 0.12 || L[e][k].c > 0.4);
  if (!any('OS') && !any('OD')) return 'No field defect: the lesion misses the visual fibres.';
  const a = lost('OS'), b = lost('OD');
  // homonymous (same side of the world in both eyes)
  if (a && a === b) {
    const ks = a.split(','), side = ks[0][0];
    if (ks.every((k) => k[0] === side)) {
      const spared = ks.every((k) => L.OS[k].c < 0.35 && L.OD[k].c < 0.35);
      if (ks.length === 2) return `${cap(SIDE[side])} homonymous hemianopia${spared ? ' with macular sparing' : ''}`;
      const sup = ks[0][1] === 'S';
      return `${cap(SIDE[side])} ${sup ? 'superior' : 'inferior'} homonymous quadrantanopia (“pie ${sup ? 'in the sky' : 'on the floor'}”)`;
    }
  }
  if (!a && !b) {
    const periph = Q.some((k) => L.OS[k].p > 0.15 || L.OD[k].p > 0.15);
    const cs = (e) => Q.filter((k) => L[e][k].c > 0.4).map((k) => k[0]);
    const ca = new Set(cs('OS')), cb = new Set(cs('OD'));
    if (!periph && ca.size === 1 && cb.size === 1 && [...ca][0] === [...cb][0]) return `${cap(SIDE[[...ca][0]])} homonymous central scotoma`;
    // incomplete homonymous defect (e.g. a wedge from a partial Meyer's loop lesion)
    const pa = Q.filter((k) => L.OS[k].p > 0.15).sort().join(','), pb = Q.filter((k) => L.OD[k].p > 0.15).sort().join(',');
    if (pa && pa === pb) {
      const ks = pa.split(','), side = ks[0][0];
      if (ks.every((k) => k[0] === side)) {
        if (ks.length === 2) return `Incomplete ${SIDE[side]} homonymous hemianopia`;
        const sup = ks[0][1] === 'S';
        return `Partial ${SIDE[side]} ${sup ? 'superior' : 'inferior'} homonymous quadrantanopia (wedge-shaped \u201cpie ${sup ? 'in the sky' : 'on the floor'}\u201d)`;
      }
    }
  }
  // bitemporal
  const tOS = a && a.split(',').every((k) => k[0] === 'L'), tOD = b && b.split(',').every((k) => k[0] === 'R');
  if (tOS && tOD) {
    const n = a.split(',').length + b.split(',').length;
    if (n === 4) return 'Bitemporal hemianopia';
    if (n === 2 && a.endsWith('S') && b.endsWith('S')) return 'Bitemporal superior quadrantanopia';
    return 'Bitemporal field loss, asymmetric';
  }
  return `Left eye: ${eyeWords('OS', L.OS)}. Right eye: ${eyeWords('OD', L.OD)}.`;
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** Grey-scale fields, left eye on the left, each as the patient sees it. */
export function drawFields(canvas, maps) {
  const dpr = window.devicePixelRatio || 1, W = 360, H = 196;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const N = maps.N, R = 78;
  const tmp = new OffscreenCanvas(N, N), tg = tmp.getContext('2d'), img = tg.createImageData(N, N);
  for (const [k, eye] of ['OS', 'OD'].entries()) {
    const m = maps[eye], cx = 90 + k * 180, cy = 98;
    for (let i = 0; i < N * N; i++) {
      const v = Number.isNaN(m[i]) ? 0 : m[i];
      img.data[i * 4] = 22 + v * 210; img.data[i * 4 + 1] = 24 + v * 212; img.data[i * 4 + 2] = 28 + v * 214; img.data[i * 4 + 3] = 255;
    }
    tg.putImageData(img, 0, 0);
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    g.imageSmoothingEnabled = true;
    g.drawImage(tmp, cx - R, cy - R, 2 * R, 2 * R);
    // physiological blind spot, ~15° temporal and slightly below fixation
    const bx = cx + (eye === 'OS' ? -0.5 : 0.5) * R;
    g.fillStyle = 'rgba(20,22,26,.85)';
    g.beginPath(); g.ellipse(bx, cy + 0.06 * R, 0.07 * R, 0.1 * R, 0, 0, Math.PI * 2); g.fill();
    g.restore();
    g.strokeStyle = 'rgba(120,135,150,.55)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    g.beginPath(); g.arc(cx, cy, R / 2, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#9fb0c2'; g.font = '11px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(eye === 'OS' ? 'Left eye (OS)' : 'Right eye (OD)', cx, 12);
    g.font = '9.5px system-ui, sans-serif'; g.fillStyle = '#6f8093';
    g.textAlign = 'left'; g.fillText(eye === 'OS' ? 'T' : 'N', cx - R + 3, cy - 4);
    g.textAlign = 'right'; g.fillText(eye === 'OS' ? 'N' : 'T', cx + R - 3, cy - 4);
  }
}
