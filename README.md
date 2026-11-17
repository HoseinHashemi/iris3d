# OcuForm 3D

Browser app that reconstructs a 3D eye from a macular OCT volume + colour fundus photograph.

```bash
npm install
npm run dev        # http://localhost:5173  → click "Load synthetic demo case"
npm run build      # static build in dist/
```

## Pipeline
1. **Load** – Heidelberg Spectralis raw `.vol`, Heyex XML export (select the `.xml` + all its `.tif`), MATLAB v5 `.mat`
   (`images` array, e.g. the Duke DME set, with expert tracings as reference), or generic B-scan images / multi-page TIFF
   plus a separate fundus photo (JPEG/PNG/TIFF/PPM). Device files bring their IR-SLO localizer, the exact
   position of every B-scan on it (→ exact OCT↔fundus registration), and the device's own layer segmentation.
   Set the physical scan size (device presets provided), fundus FOV and axial length.
2. **Landmarks & registration** – automatic FOV / optic-disc / fovea detection; fundus scale from Bennett's
   formula (mm/deg = 0.01306·(AL − 1.82)). The OCT fovea is aligned to the fundus fovea; fine-tune with offset/rotation/scale.
3. **Segmentation** (Web Worker) – graph-search (dynamic programming) of ILM, RNFL/GCL, EZ, RPE, Bruch's membrane per
   B-scan → robust cubic 3D BM prior (Tukey IRLS) to reject vessel-shadow failures → second constrained pass →
   local edge snapping + sub-pixel refinement → 3D median/gaussian smoothing.
4. **Analysis** – ILM–BM thickness map, automatic fovea, ETDRS sectors, 6 mm macular volume, en-face projection.
5. **3D** – *Anatomical eye*: schematic-eye anterior segment (aspheric cornea, lens, iris, ciliary body, zonules),
   posterior segment stretched to axial length, fundus mapped by arc length, OCT surface draped at the macula, optic nerve
   placed at the detected disc. *Retina detail*: true segmented surfaces, ray-marched OCT volume, B-scan plane.
   *Visual pathway* (illustration, not patient data): both globes with the six extraocular muscles, optic nerves,
   chiasm, optic tracts, LGN, optic radiations incl. Meyer's loop, and V1 along the calcarine fissure, inside a
   procedurally folded brain with ventricles and the circle of Willis. Fibres are coloured by visual hemifield, so
   the nasal-fibre crossing at the chiasm and the retinotopy (upper field → Meyer's loop → lower calcarine bank) are
   visible. Brain opacity / cut-away, layer toggles and labels in the 3D panel.
6. **Browse / correct** – scroll the mouse wheel over the B-scan or thickness map (or use the arrow keys) to move
   between B-scans. Pick a layer in the B-scan panel (“Edit …”) and draw over it; statistics and 3D update.
   “Use device layers” switches to the device segmentation.
7. **Export** – PNG screenshot, GLB of the surfaces, thickness CSV.

## Accuracy

Synthetic phantom with analytic ground truth (512×400×97, 5 µm/px): ILM −2.6 µm, BM +5.3 µm bias; thickness MAE 7.9 µm; fovea located within 0.05 mm.

Real Heidelberg Spectralis scans vs the **device's own segmentation** (ILM–BM retinal thickness, 3.87 µm axial pixel):

| Scan | Thickness bias | MAE | P95 | CST OcuForm / device |
|---|---|---|---|---|
| layers.vol (97 B-scans, normal) | −0.4 µm | 3.0 µm | 7.6 µm | 271 / 270 µm |
| healthy_OD.vol (512 B-scans, 3.2 mm) | +1.2 µm | 2.8 µm | 6.5 µm | 257 / 255 µm |
| drusen_patient (AMD, Heyex XML) | +2.6 µm | 4.6 µm | 11 µm | 293 / 290 µm (device-reported) |
| Willis_B_712.vol (7 B-scans) | +1.9 µm | 2.5 µm | 5.5 µm | – |

All ETDRS sectors of the drusen case are within 4 µm of the values the Spectralis reported in its own export.

**Diabetic macular edema vs manual expert grading** (Duke DME set, 10 Spectralis volumes, 11 traced B-scans each,
~5 800 A-scans per eye). OcuForm is compared with grader 1; grader 2 vs grader 1 is the human baseline:

| | Thickness MAE | Bias | P95 |
|---|---|---|---|
| OcuForm vs grader 1 (mean of 10 eyes, range) | 5.5 µm (4.8–6.3) | −3.3 … +1.9 µm | 12–16 µm |
| Grader 2 vs grader 1 | 6.8 µm (5.5–8.4) | | 15–19 µm |

On these eyes the automatic ILM–BM thickness is as close to an expert as the two experts are to each other.

**Other pathology (visual review, no ground truth):** OCTID Cirrus B-scans of central serous retinopathy (ILM/BM
correct, EZ follows the detached photoreceptors, RPE stays on Bruch's membrane, PEDs followed), diabetic retinopathy
with cysts and a detached posterior hyaloid (ILM not fooled by the hyaloid), and full-thickness macular holes (ILM
drops to the hole floor). STARE fundus photos (hypertensive/diabetic retinopathy, vein/artery occlusions): optic disc
found automatically in 8 of 12 test photos; dense hard exudates near a disc at the edge of the field can still win,
so check the markers and use *Click disc / Click fovea*.
Run `tests/validate.js` (see test-data/SOURCES.md) after any algorithm change.

**Not supported:** optic-nerve-head scans (no RPE/BM inside the cup — the segmentation is designed for the macula),
other vendors' raw formats (Zeiss .img, Topcon .fda, DICOM — export B-scans as images), wide-field/EDI choroid analysis.

Validated on ~15 volumes and ~20 single pathological B-scans. Very large detachments (> 80 µm), mirror artefacts
near the top of the scan, poor signal and inner-retinal sublayers (RNFL boundary is approximate in edema) can still
fail — always review the B-scan overlay. The cornea, lens and iris are a parametric model, not measured from
these images. Research / education only; not a medical device.
