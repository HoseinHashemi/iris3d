# Test data (not part of the app; ~1.3 GB, downloaded 2026-11-17)

| File | Source | Licence | Content |
|---|---|---|---|
| layers.vol | github.com/halirutan/spectralis-raw-data (test-data/) | not stated | Spectralis 97×512×496 macular cube, 17 device layers |
| Willis_B_712.vol | same | not stated | 7 B-scans, 384 A-scans |
| valid.vol | same | not stated | single ONH B-scan |
| drusen_patient.zip | github.com/MedVisBonn/eyepydata release v1.0.0 | MIT | AMD/drusen, Heyex XML export (145 B-scans + IR-SLO + device ETDRS) |
| healthy_OD.vol | same | MIT | healthy right eye, 512×512×496 high-density cube |
| duke_dme/2015_BOE_Chiu2.zip | people.duke.edu/~sf59/Chiu_BOE_2014_dataset.htm (Chiu et al., Biomed. Opt. Express 6:1172, 2015) | research/education only, no redistribution, cite the paper | 10 diabetic macular edema volumes (Spectralis, 61×768×496), two experts' manual tracings of 8 boundaries on 11 B-scans each + fluid masks |
| octid/FVLZIL, FLGZZE, MBMQGD | OCTID, Univ. Waterloo, borealisdata.ca (doi 10.5683/SP/FVLZIL, /FLGZZE, /MBMQGD) | CC0 1.0 | single Zeiss Cirrus B-scans (750×500 JPEG, 6 × 2 mm): central serous retinopathy (serous detachment), diabetic retinopathy, macular hole |
| stare/all-images.zip, all-mg-codes.txt | STARE, Clemson University (cecas.clemson.edu/~ahoover/stare) | research use, cite Hoover et al. | 397 fundus photos (PPM) with diagnoses incl. hypertensive retinopathy, diabetic retinopathy, vein/artery occlusions |

Re-run validation: start `npm run dev`, open the app, then in the browser console:
`const v = await import('/tests/validate.js'); await v.runAll();`

Pathology tests (browser console):
`const d = await import('/tests/disease.js'); await d.dukeAll();` — Duke DME vs expert grader 1, with grader 2 vs grader 1 as the human baseline.
`await d.octidMontage(['FVLZIL/CSR1.jpeg', 'MBMQGD/MH2.jpeg', …])` — overlay montage for visual review (no ground truth).
Duke .mat files carry no physical size: set scan width 8.7, length 7.5, depth 1.92 mm before loading one in the app.
