import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EyeModel } from './eye.js';
import { RetinaView } from './retina.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export class Viewer {
  constructor(container) {
    this.container = container;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.localClippingEnabled = true;
    r.setClearColor(0x0a0e14, 1);
    container.prepend(r.domElement);

    const pmrem = new THREE.PMREMGenerator(r);
    const env = (this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture);

    // Anatomical eye scene
    this.eyeScene = new THREE.Scene();
    this.eyeScene.environment = env;
    this.eyeScene.environmentIntensity = 0.75;
    this.eye = new EyeModel();
    this.eyeScene.add(this.eye.group);
    const key = new THREE.DirectionalLight('#fff4e8', 2.2);
    key.position.set(25, 30, 40);
    const rim = new THREE.DirectionalLight('#9cc8ff', 0.8);
    rim.position.set(-30, 10, -20);
    const inside = new THREE.PointLight('#ffffff', 60, 30, 1.6);
    inside.position.set(0, 0, 4);
    this.eyeScene.add(key, rim, inside, new THREE.HemisphereLight('#dfe8f5', '#2a1a14', 0.35));
    this.eyeCam = new THREE.PerspectiveCamera(32, 1, 0.1, 500);
    this.eyeCam.position.set(44, 14, 38);
    this.eyeCtl = new OrbitControls(this.eyeCam, r.domElement);
    this.eyeCtl.enableDamping = true;
    this.eyeCtl.target.set(0, 0, 0);
    this.eyeCtl.minDistance = 8;
    this.eyeCtl.maxDistance = 140;

    // Retina detail scene
    this.retina = new RetinaView();
    this.retina.scene.environment = env;
    this.retina.scene.environmentIntensity = 0.6;
    const k2 = new THREE.DirectionalLight('#ffffff', 2.0);
    k2.position.set(4, 10, 6);
    const f2 = new THREE.DirectionalLight('#a8c8ff', 0.6);
    f2.position.set(-6, -4, -5);
    this.retina.scene.add(k2, f2, new THREE.AmbientLight('#ffffff', 0.25));
    this.retCam = new THREE.PerspectiveCamera(35, 1, 0.01, 200);
    this.retCam.position.set(7.5, 6.5, 10.5);
    this.retCtl = new OrbitControls(this.retCam, r.domElement);
    this.retCtl.enableDamping = true;

    // Visual pathway scene (built lazily: ~1 s of geometry generation)
    this.pathCam = new THREE.PerspectiveCamera(30, 1, 0.5, 2000);
    this.pathCam.position.set(-190, 150, 175);
    this.pathCtl = new OrbitControls(this.pathCam, r.domElement);
    this.pathCtl.enableDamping = true;
    this.pathCtl.target.set(0, 4, -18);
    this.pathCtl.minDistance = 15;
    this.pathCtl.maxDistance = 700;
    this.labelRenderer = new CSS2DRenderer();
    Object.assign(this.labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '1' });
    this.labelRenderer.domElement.classList.add('label-layer');
    container.appendChild(this.labelRenderer.domElement);

    this.setMode('eye');
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    r.setAnimationLoop(() => this.render());
  }

  async ensurePathway() {
    if (this.pathway) return this.pathway;
    const { VisualPathway } = await import('./pathway.js');
    const p = (this.pathway = new VisualPathway());
    p.scene.environment = this.env;
    p.scene.environmentIntensity = 0.7;
    const key = new THREE.DirectionalLight('#fff4e8', 2.4);
    key.position.set(-120, 200, 160);
    const fill = new THREE.DirectionalLight('#a9c9ff', 0.9);
    fill.position.set(150, -40, -120);
    const under = new THREE.DirectionalLight('#ffe0d0', 0.6);
    under.position.set(0, -200, 40);
    p.scene.add(key, fill, under, new THREE.HemisphereLight('#e2ebf7', '#2a1a14', 0.4));
    return p;
  }

  setMode(mode) {
    this.mode = mode;
    this.eyeCtl.enabled = mode === 'eye';
    this.retCtl.enabled = mode === 'retina';
    this.pathCtl.enabled = mode === 'pathway';
    this.labelRenderer.domElement.style.display = mode === 'pathway' ? '' : 'none';
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    for (const c of [this.eyeCam, this.retCam, this.pathCam]) { c.aspect = w / h; c.updateProjectionMatrix(); }
    this.labelRenderer.setSize(w, h);
  }

  render() {
    if (this.mode === 'eye') { this.eyeCtl.update(); this.renderer.render(this.eyeScene, this.eyeCam); }
    else if (this.mode === 'pathway') {
      if (!this.pathway) return;
      this.pathCtl.update();
      this.renderer.render(this.pathway.scene, this.pathCam);
      this.labelRenderer.render(this.pathway.scene, this.pathCam);
    } else { this.retCtl.update(); this.renderer.render(this.retina.scene, this.retCam); }
  }

  screenshot() { this.render(); return this.renderer.domElement.toDataURL('image/png'); }
}
