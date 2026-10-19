// Cinematic 3D battlefield (three.js). Consumes committed frames only; it never feeds the simulation.
// Scene: theatre hex terrain + endless streamed scenery, structures, units, overlays and effects, lit by a
// hemisphere sky and a warm shadow-casting sun that follows the camera target. Post: RenderPass ->
// UnrealBloom -> OutputPass (ACES, sRGB) into an MSAA half-float target; HUD sprites (bars, markers) are
// drawn afterwards straight to the canvas so they stay crisp; HTML labels sit in an overlay div.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CHUNK } from '../../shared/config.ts';
import { STRUCT_ID_BASE, type FrameMsg, type MapStatic, type SiteInfo } from '../../shared/protocol.ts';
import {
  DEFAULT_OVERLAYS, type BattleView, type CameraMode, type CameraPreset, type CameraState, type MinimapData, type Overlays,
  type PickInfo, type PlanOverlay,
} from '../api.ts';
import { POINT_MAX, RingBatch, SpriteBatch } from './batches.ts';
import { CameraRig } from './camera.ts';
import { GROUND_Y, SQRT3, buildTheatre, clamp, smooth01, tileAt, type Theatre } from './common.ts';
import { EffectsLayer, type FxCtx } from './effects.ts';
import { LabelLayer } from './labels.ts';
import { TIME, terrainMaterial } from './materials.ts';
import { OverlayLayer } from './overlays.ts';
import { SceneryField } from './scenery.ts';
import { StructureLayer, type StructFrameCtx } from './structures.ts';
import { TheatreTerrain, type TileState } from './terrain.ts';
import { UnitLayer, type UnitFrameCtx } from './units.ts';

const BG = 0x090c12;
const FOG = 0x121821;
const ZENITH = 0x05070b;
const EXPOSURE = 1.0;
const SUN_DIR = new THREE.Vector3(-0.52, 0.8, -0.3).normalize();
const PICK_PX = 18;
const HOVER_MS = 60;
const TILE_MS = 150, FRONT_MS = 330;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _p = new Float32Array(3);
const _ray = new THREE.Raycaster();
const CORNERS = [-1, 1, 1, 1, 1, -1, -1, -1]; // NDC screen corners, clockwise from top-left
const _ndc = new THREE.Vector2();

const SANITIZE = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; varying vec2 vUv;
    void main() {
      vec4 c = texture2D( tDiffuse, vUv );
      if ( any( isnan( c ) ) || any( isinf( c ) ) ) c = vec4( 0.0, 0.0, 0.0, 1.0 );
      gl_FragColor = min( c, vec4( 48.0 ) );
    }`,
};

function skyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: new THREE.Color(FOG) }, uZenith: { value: new THREE.Color(ZENITH) }, uGround: { value: new THREE.Color(0x0b0e13) },
      uSun: { value: SUN_DIR.clone() }, uGlow: { value: new THREE.Color(0x3a2a1a) },
    },
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize( ( modelMatrix * vec4( position, 1.0 ) ).xyz - cameraPosition );
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        gl_Position.z = gl_Position.w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon; uniform vec3 uZenith; uniform vec3 uGround; uniform vec3 uSun; uniform vec3 uGlow;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize( vDir );
        vec3 c = d.y > 0.0 ? mix( uHorizon, uZenith, pow( clamp( d.y * 1.5, 0.0, 1.0 ), 0.55 ) ) : mix( uHorizon, uGround, min( 1.0, -d.y * 5.0 ) );
        c += uGlow * pow( max( 0.0, dot( d, uSun ) ), 10.0 ) * 0.5;
        gl_FragColor = vec4( c, 1.0 );
      }`,
  });
}

export class ThreeRenderer implements BattleView {
  ready = false;
  selectedOwner = -1;
  selectedUnit = -1;
  plan: PlanOverlay | null = null;
  speed = 2;
  commanderNames = new Map<number, { name: string; faction: number; status: string }>();
  opInfo: { code: string; status: string; center: number; radius: number } | null = null;
  battles: { tile: number; intensity: number }[] = [];
  onPick: (p: PickInfo) => void = () => {};
  onHover: (p: PickInfo | null) => void = () => {};
  onFps: (fps: number) => void = () => {};
  onCameraMode: (m: CameraMode) => void = () => {};

  private host: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private sanitize: ShaderPass | null = null;
  private output: OutputPass | null = null;
  private rig: CameraRig | null = null;
  private scene = new THREE.Scene();
  private hudScene = new THREE.Scene();
  private sun = new THREE.DirectionalLight(0xffe0bd, 2.2);
  private hemi = new THREE.HemisphereLight(0xa6b8d6, 0x1a1c22, 0.95);
  private sky: THREE.Mesh | null = null;
  private ground: THREE.Mesh | null = null;
  private labels: LabelLayer | null = null;
  private terrain: TheatreTerrain | null = null;
  private scenery = new SceneryField();
  private units = new UnitLayer();
  private structs = new StructureLayer();
  private fx = new EffectsLayer();
  private over: OverlayLayer;
  private rings = new RingBatch(2400, true, 4);
  private hud = new SpriteBatch(4096, 9);
  private ro: ResizeObserver | null = null;
  private th: Theatre | null = null;
  private map: MapStatic | null = null;
  private pending: MapStatic | null = null;
  private worldId = '';
  private territory: Int8Array = new Int8Array(0);
  private owner: Int16Array = new Int16Array(0);
  private supply: Uint8Array = new Uint8Array(0);
  private fog: Uint8Array | null = null;
  private ghosts: Float32Array | null = null;
  private active: Uint8Array = new Uint8Array(0);
  private reveal: Float32Array = new Float32Array(0);
  private tilesDirty = false; private frontsDirty = false; private supplyDirty = false; private revealing = false;
  private lastTiles = 0; private lastFronts = 0;
  private overlays: Overlays = { ...DEFAULT_OVERLAYS };
  private w = 1; private h = 1;
  private t0 = performance.now();
  private last = 0;
  private fpsAcc = 0; private fpsN = 0;
  private hoverAt = 0;
  private down = { x: 0, y: 0, button: -1 };
  private shadowS = 0;
  private disposed = false;
  private mm: MinimapData | null = null;
  private corners = new Float32Array(8);

  constructor() {
    this.over = new OverlayLayer(this.fx.pointScale);
  }

  // ------------------------------------------------------------------ lifecycle
  async init(host: HTMLElement): Promise<void> {
    this.host = host;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false, stencil: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(BG, 1);
    renderer.info.autoReset = false; // one reset per frame so stats cover shadow, bloom and HUD passes
    // largest point sprite the GPU draws (supply dots); particles are quads and have no such cap
    const gl = renderer.getContext();
    const ptRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
    if (ptRange && ptRange[1] > 1) POINT_MAX.value = ptRange[1];
    const cv = renderer.domElement;
    cv.style.display = 'block'; cv.style.position = 'absolute'; cv.style.left = '0'; cv.style.top = '0';
    cv.style.width = '100%'; cv.style.height = '100%'; cv.style.touchAction = 'none'; cv.style.outline = 'none';
    host.appendChild(cv);
    this.renderer = renderer;
    this.w = Math.max(1, host.clientWidth); this.h = Math.max(1, host.clientHeight);
    renderer.setSize(this.w, this.h, false);

    const sc = this.scene;
    sc.background = new THREE.Color(BG);
    sc.fog = new THREE.FogExp2(FOG, 0.004);
    sc.add(this.hemi);
    const sun = this.sun;
    sun.castShadow = this.overlays.shadows;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 520;
    sc.add(sun, sun.target);

    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMaterial());
    sky.scale.setScalar(2000); sky.renderOrder = -10; sky.frustumCulled = false;
    this.sky = sky;
    // the bare disc beyond the streamed land melts into fog with it (EDGE_FADE), so the world has no rim
    const groundMat = terrainMaterial({ roughness: 1, fogBoost: 1.25, fogBias: 0.04, edgeFade: true });
    const gGeo = new THREE.CircleGeometry(3200, 64).rotateX(-Math.PI / 2);
    const cnt = gGeo.getAttribute('position').count;
    const gc = new Float32Array(cnt * 3);
    const g0 = new THREE.Color(0x1b1e24);
    for (let i = 0; i < cnt; i++) { gc[i * 3] = g0.r; gc[i * 3 + 1] = g0.g; gc[i * 3 + 2] = g0.b; }
    gGeo.setAttribute('color', new THREE.BufferAttribute(gc, 3));
    this.ground = new THREE.Mesh(gGeo, groundMat);
    this.ground.position.y = 0.04;
    this.ground.frustumCulled = false;
    sc.add(sky, this.ground, this.scenery.group, this.structs.group, this.units.group, this.over.group, this.rings.mesh, this.fx.group);
    this.hudScene.add(this.hud.mesh);

    const rig = new CameraRig(cv);
    rig.onMode = (m) => this.onCameraMode(m);
    rig.setAspect(this.w, this.h);
    this.rig = rig;

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(this.w, this.h);
    composer.addPass(new RenderPass(sc, rig.camera));
    // insurance: one stray NaN/Inf in the HDR buffer would be smeared over the whole screen by the bloom
    // blur chain, so scrub them (and clamp fireflies) before bloom runs
    this.sanitize = new ShaderPass(SANITIZE);
    this.sanitize.enabled = this.overlays.bloom;
    composer.addPass(this.sanitize);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.w, this.h), 0.55, 0.42, 0.82);
    this.bloom.enabled = this.overlays.bloom;
    composer.addPass(this.bloom);
    this.output = new OutputPass();
    composer.addPass(this.output);
    this.composer = composer;

    this.labels = new LabelLayer(host);
    cv.addEventListener('pointermove', this.onPointerMove);
    cv.addEventListener('pointerdown', this.onPointerDown);
    cv.addEventListener('pointerup', this.onPointerUp);
    cv.addEventListener('pointerleave', this.onPointerLeave);
    cv.addEventListener('dblclick', this.onDblClick);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.t0 = performance.now();
    this.last = this.t0;
    renderer.setAnimationLoop(this.frame);
    if (this.pending) { const m = this.pending; this.pending = null; this.setStatic(m); }
  }

  private resize(): void {
    const host = this.host, r = this.renderer;
    if (!host || !r || !this.composer || !this.rig) return;
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    this.w = w; this.h = h;
    r.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.rig.setAspect(w, h);
    const pr = r.getPixelRatio();
    this.hud.res.set(w * pr, h * pr);
    this.hud.pr.value = pr;
    this.fx.pointScale.value = (h * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(this.rig.camera.fov / 2)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const r = this.renderer;
    r?.setAnimationLoop(null);
    this.ro?.disconnect();
    const cv = r?.domElement;
    if (cv) {
      cv.removeEventListener('pointermove', this.onPointerMove);
      cv.removeEventListener('pointerdown', this.onPointerDown);
      cv.removeEventListener('pointerup', this.onPointerUp);
      cv.removeEventListener('pointerleave', this.onPointerLeave);
      cv.removeEventListener('dblclick', this.onDblClick);
    }
    this.rig?.dispose();
    this.terrain?.dispose();
    this.scenery.dispose(); this.units.dispose(); this.structs.dispose(); this.fx.dispose(); this.over.dispose();
    this.rings.dispose(); this.hud.dispose();
    if (this.sky) { this.sky.geometry.dispose(); (this.sky.material as THREE.Material).dispose(); }
    if (this.ground) { this.ground.geometry.dispose(); (this.ground.material as THREE.Material).dispose(); }
    this.sun.shadow.map?.dispose();
    // EffectComposer.dispose() frees only its own targets and copy pass; every pass owns GPU resources too
    // (OutputPass: material and full-screen quad). UnrealBloomPass.dispose() (r180) skips its high-pass material.
    if (this.composer) for (const p of this.composer.passes) p.dispose();
    this.bloom?.materialHighPassFilter.dispose();
    this.composer?.dispose();
    this.labels?.dispose();
    r?.dispose();
    cv?.remove();
    this.ready = false;
  }

  // ------------------------------------------------------------------ static map & frontier
  setStatic(map: MapStatic): void {
    if (!this.renderer) { this.pending = map; return; }
    const th = buildTheatre(map);
    if (this.terrain) { this.scene.remove(this.terrain.group); this.terrain.dispose(); }
    this.terrain = new TheatreTerrain(th);
    this.scene.add(this.terrain.group);
    this.th = th; this.map = map;
    const n = th.n;
    this.territory = new Int8Array(n).fill(-1);
    this.owner = new Int16Array(n).fill(-1);
    this.supply = new Uint8Array(n);
    this.fog = null; this.ghosts = null;
    this.active = map.active && map.active.length === n ? map.active.slice() : new Uint8Array(n).fill(1);
    this.reveal = new Float32Array(n);
    this.units.setTheatre(th); this.structs.setTheatre(th); this.fx.setTheatre(th); this.over.setTheatre(th);
    this.labels?.setTheatre(th);
    this.labels?.setSites(map.sites);
    this.over.rebuildFrontier(this.active);
    this.scenery.reset(map.seed, map.w, map.h);
    const b = this.theatreBounds();
    this.rig?.setCursor((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2);
    if (map.worldId !== this.worldId) {
      this.worldId = map.worldId;
      const a = this.activeBounds();
      this.rig?.fit(a.minX, a.maxX, a.minZ, a.maxZ, true);
    }
    this.tilesDirty = true; this.frontsDirty = true; this.supplyDirty = true;
    this.lastTiles = 0; this.lastFronts = 0;
    this.ready = true;
  }

  setFrontier(active: Uint8Array, sites: SiteInfo[], opened: number[]): void {
    const th = this.th;
    if (!th || active.length !== th.n) return;
    const now = performance.now();
    // newly opened tiles come from the mask diff (robust to how `opened` is encoded); one pulse per chunk
    const cw = Math.ceil(th.w / CHUNK);
    const sums = new Map<number, [number, number, number, number]>();
    for (let t = 0; t < th.n; t++) {
      if (!active[t] || this.active[t]) continue;
      this.reveal[t] = now;
      const c = t % th.w, r = (t / th.w) | 0;
      const k = Math.floor(r / CHUNK) * cw + Math.floor(c / CHUNK);
      const s = sums.get(k) ?? [0, 0, 0, 0];
      s[0] += th.x[t]; s[1] += th.top[t]; s[2] += th.z[t]; s[3]++;
      sums.set(k, s);
    }
    for (const s of sums.values()) this.fx.reveal(s[0] / s[3], s[1] / s[3] + 0.08, s[2] / s[3], CHUNK * 0.95, now);
    void opened;
    this.active = active.slice();
    this.labels?.setSites(sites);
    this.over.rebuildFrontier(this.active);
    this.tilesDirty = true;
    this.revealing = sums.size > 0 || this.revealing;
  }

  setOverlays(o: Overlays): void {
    const p = this.overlays;
    if (o.territory !== p.territory) { this.tilesDirty = true; this.frontsDirty = true; }
    if (o.fronts !== p.fronts) this.frontsDirty = true;
    if (o.supply !== p.supply) this.supplyDirty = true;
    if (o.fog !== p.fog) { if (o.fog < 0) { this.fog = null; this.ghosts = null; } this.tilesDirty = true; this.lastTiles = 0; }
    this.overlays = { ...o };
    if (this.bloom) this.bloom.enabled = o.bloom;
    if (this.sanitize) this.sanitize.enabled = o.bloom;
    this.sun.castShadow = o.shadows;
  }

  // ------------------------------------------------------------------ frames
  applyFrame(f: FrameMsg): void {
    const th = this.th;
    if (!this.ready || !th) return;
    const now = performance.now();
    if (f.territory && f.territory.length === th.n) { this.territory = f.territory; this.frontsDirty = true; this.tilesDirty = true; }
    if (f.owner && f.owner.length === th.n) { this.owner = f.owner; this.frontsDirty = true; }
    if (f.supply && f.supply.length === th.n) { this.supply = f.supply; this.supplyDirty = true; }
    if (f.fog && f.fog.length === th.n) { this.fog = f.fog; this.ghosts = f.ghosts ?? null; this.tilesDirty = true; }
    else if (this.overlays.fog < 0 && this.fog) { this.fog = null; this.ghosts = null; this.tilesDirty = true; }
    if (f.opRegion !== undefined) this.over.setOpRegion(f.opRegion);
    if (f.storms) this.fx.setStorms(f.storms);
    this.structs.apply(f.structs);
    this.units.apply(f.units);
    this.labels?.syncStructs(this.structs.list, this.commanderNames);
    const fc = this.fctx ?? (this.fctx = { th, speed: this.speed, pos: this.fxPos, fog: null });
    fc.th = th; fc.speed = this.speed; fc.fog = this.fogView();
    this.fx.applyFx(f.fx, now, fc);
  }

  private fxPos = (id: number, out: Float32Array): boolean =>
    id >= STRUCT_ID_BASE ? this.structs.pos(id - STRUCT_ID_BASE, out) : this.units.pos(id, out);

  // per-frame contexts are reused so the render loop allocates nothing
  private sctx: StructFrameCtx = { now: 0, rings: this.rings, hud: this.hud, camX: 0, camY: 0, camZ: 0, fog: null };
  private fctx: FxCtx | null = null;
  private uctx: UnitFrameCtx = {
    now: 0, dt: 0, camDist: 0, camX: 0, camY: 0, camZ: 0, selectedOwner: -1, selectedUnit: -1, fog: null,
    rings: this.rings, hud: this.hud, sparks: this.fx.add, targetPos: this.fxPos,
  };
  private tctx: TileState = { territory: new Int8Array(0), active: new Uint8Array(0), reveal: new Float32Array(0), fog: null, tint: true };

  private fogView(): Uint8Array | null { return this.overlays.fog >= 0 ? this.fog : null; }

  // ------------------------------------------------------------------ per-frame
  private frame = (): void => {
    const r = this.renderer, rig = this.rig, composer = this.composer;
    if (!r || !rig || !composer || this.disposed) return;
    const now = performance.now();
    const dt = clamp(now - this.last, 0, 100);
    this.last = now;
    r.info.reset();
    TIME.value = (now - this.t0) / 1000;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 500) { this.onFps((this.fpsN * 1000) / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }

    rig.update(dt, now, this.hooks, this.fx.shake);
    const cam = rig.camera, tgt = rig.controls.target;
    const dist = rig.distance;
    (this.scene.fog as THREE.FogExp2).density = 0.62 / (dist + 95);
    // gentle "eye adaptation": strategic views are mostly dark ground, so lift exposure as the camera pulls back
    const far = smooth01((dist - 30) / 230);
    r.toneMappingExposure = EXPOSURE + far * 0.5;
    this.over.setWidthScale(clamp(dist / 42, 1, 4.5), clamp(dist / 55, 1, 3));
    this.fx.setWidthScale(clamp(dist / 70, 1, 2.5));
    this.sky?.position.copy(cam.position);
    this.ground?.position.set(tgt.x, 0.04, tgt.z);
    this.updateShadow(tgt, dist);
    this.groundCorners(this.corners);
    this.scenery.update(this.corners, rig.polar, now);

    const th = this.th;
    if (th && this.terrain) {
      if ((this.tilesDirty && now - this.lastTiles > TILE_MS) || this.revealing) {
        this.tilesDirty = false; this.lastTiles = now;
        const ts = this.tctx;
        ts.territory = this.territory; ts.active = this.active; ts.reveal = this.reveal; ts.fog = this.fogView(); ts.tint = this.overlays.territory;
        this.revealing = this.terrain.compose(ts, now);
      }
      if (this.frontsDirty && now - this.lastFronts > FRONT_MS) {
        this.frontsDirty = false; this.lastFronts = now;
        this.over.rebuildFronts(this.territory, this.owner, this.overlays.fronts);
      }
      if (this.supplyDirty) { this.supplyDirty = false; this.over.rebuildSupply(this.supply, this.overlays.supply); }
    }

    this.rings.begin();
    this.hud.begin();
    const cp = cam.position;
    if (th) {
      const sc = this.sctx, uc = this.uctx;
      sc.now = now; sc.camX = cp.x; sc.camY = cp.y; sc.camZ = cp.z; sc.fog = this.fogView();
      this.structs.update(sc);
      uc.now = now; uc.dt = dt; uc.camDist = dist; uc.camX = cp.x; uc.camY = cp.y; uc.camZ = cp.z;
      uc.selectedOwner = this.selectedOwner; uc.selectedUnit = this.selectedUnit; uc.fog = this.fogView();
      this.units.update(uc);
      this.over.updateOp(now, this.opInfo?.status === 'Running');
      this.over.drawPlan(now, this.plan, this.overlays.plans, this.overlays.danger, this.units, this.rings);
      if (this.overlays.fog >= 0) this.over.drawGhosts(this.ghosts, this.hud, this.rings);
    }
    this.fx.update(now, dt, this.rings, this.overlays.weather);
    this.rings.end();
    this.hud.end();
    this.labels?.update(cam, this.w, this.h, this.overlays.labels, this.th ? this.fogView() : null);

    composer.render(dt / 1000);
    r.autoClear = false;
    r.setRenderTarget(null);
    r.render(this.hudScene, cam);
    r.autoClear = true;
  };

  private hooks = {
    follow: (out: Float32Array): boolean => this.selectedOwner >= 0 && this.units.centroid(this.selectedOwner, out),
    operation: (out: Float32Array): boolean => this.opTarget(out),
    director: (out: Float32Array): boolean => {
      const th = this.th;
      const b = this.battles[0];
      if (th && b && b.tile >= 0 && b.tile < th.n) { out[0] = th.x[b.tile]; out[1] = th.walk[b.tile]; out[2] = th.z[b.tile]; return true; }
      return this.opTarget(out);
    },
  };

  private opTarget(out: Float32Array): boolean {
    if (this.over.opCentre(out)) return true;
    const th = this.th, c = this.opInfo?.center ?? -1;
    if (!th || c < 0 || c >= th.n) return false;
    out[0] = th.x[c]; out[1] = th.walk[c]; out[2] = th.z[c];
    return true;
  }

  /** Shadow frustum follows the target, scales with zoom, and snaps to texels to avoid shimmering. */
  private updateShadow(tgt: THREE.Vector3, dist: number): void {
    const sun = this.sun;
    const S = clamp(dist * 0.85, 16, 150);
    const cam = sun.shadow.camera;
    if (Math.abs(S - this.shadowS) > 0.5) {
      this.shadowS = S;
      cam.left = -S; cam.right = S; cam.top = S; cam.bottom = -S;
      cam.updateProjectionMatrix();
    }
    const texel = (2 * this.shadowS) / 2048;
    // light-space basis (sun direction is fixed)
    _v.set(0, 1, 0).cross(SUN_DIR).normalize(); // right
    _v2.copy(SUN_DIR).cross(_v).normalize(); // up
    const pr = tgt.x * _v.x + tgt.y * _v.y + tgt.z * _v.z;
    const pu = tgt.x * _v2.x + tgt.y * _v2.y + tgt.z * _v2.z;
    const dr = Math.round(pr / texel) * texel - pr, du = Math.round(pu / texel) * texel - pu;
    const x = tgt.x + _v.x * dr + _v2.x * du, y = tgt.y + _v.y * dr + _v2.y * du, z = tgt.z + _v.z * dr + _v2.z * du;
    sun.target.position.set(x, y, z);
    sun.position.set(x + SUN_DIR.x * 240, y + SUN_DIR.y * 240, z + SUN_DIR.z * 240);
    sun.target.updateMatrixWorld();
  }

  // ------------------------------------------------------------------ input
  private local(e: { clientX: number; clientY: number }): [number, number] {
    const rect = this.renderer!.domElement.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (e.buttons !== 0 || e.pointerType === 'touch') return;
    const now = performance.now();
    if (now - this.hoverAt < HOVER_MS) return;
    this.hoverAt = now;
    const [x, y] = this.local(e);
    this.onHover(this.pick(x, y));
  };
  private onPointerDown = (e: PointerEvent): void => { this.down.x = e.clientX; this.down.y = e.clientY; this.down.button = e.button; };
  private onPointerUp = (e: PointerEvent): void => {
    if (this.down.button !== 0 || e.button !== 0) return;
    if (this.rig?.dragged || Math.abs(e.clientX - this.down.x) + Math.abs(e.clientY - this.down.y) > 5) return;
    const [x, y] = this.local(e);
    this.onPick(this.pick(x, y));
  };
  private onPointerLeave = (): void => { this.onHover(null); };
  private onDblClick = (e: MouseEvent): void => {
    const [x, y] = this.local(e);
    if (!this.groundAt(x, y, _p)) return;
    this.setCameraMode('free');
    this.rig?.focus(_p[0], GROUND_Y, _p[2]);
    this.rig?.zoomBy(1.6);
  };

  /** Ray from the camera through a host pixel onto the stepped terrain (fixed-point on tile heights). */
  private groundAt(sx: number, sy: number, out: Float32Array): boolean {
    const rig = this.rig;
    if (!rig) return false;
    _ndc.set((sx / this.w) * 2 - 1, -(sy / this.h) * 2 + 1);
    _ray.setFromCamera(_ndc, rig.camera);
    const o = _ray.ray.origin, d = _ray.ray.direction;
    if (d.y > -1e-4) return false;
    let h = GROUND_Y, x = 0, z = 0;
    for (let i = 0; i < 4; i++) {
      const t = (h - o.y) / d.y;
      x = o.x + d.x * t; z = o.z + d.z * t;
      const tile = this.th ? tileAt(this.th, x, z) : -1;
      h = tile >= 0 ? this.th!.walk[tile] : GROUND_Y;
    }
    out[0] = x; out[1] = h; out[2] = z;
    return true;
  }

  private project(x: number, y: number, z: number): boolean {
    _v.set(x, y, z).project(this.rig!.camera);
    if (_v.z > 1 || _v.z < -1) return false;
    _v.x = (_v.x + 1) * 0.5 * this.w; _v.y = (1 - _v.y) * 0.5 * this.h;
    return true;
  }

  private pick(sx: number, sy: number): PickInfo {
    const none: PickInfo = { kind: 'none', id: -1, owner: -1, faction: -1, tile: -1, cls: -1, structKind: -1, hp: 0, supply: 0, morale: 0, flags: 0, screenX: sx, screenY: sy };
    const th = this.th;
    if (!this.ready || !th || !this.rig) return none;
    const R2 = PICK_PX * PICK_PX;
    let bu = -1, bd = R2;
    const ul = this.units.list, us = this.units.scale;
    for (let i = 0; i < ul.length; i++) {
      const u = ul[i];
      if (!u.shown || !this.project(u.x, u.y + 0.2 * us, u.z)) continue;
      const d = (_v.x - sx) * (_v.x - sx) + (_v.y - sy) * (_v.y - sy);
      if (d < bd) { bd = d; bu = i; }
    }
    if (bu >= 0) {
      const u = ul[bu];
      return { ...none, kind: 'unit', id: u.id, owner: u.owner, faction: u.faction, tile: u.tile, cls: u.cls, hp: u.hp, supply: u.supply, morale: u.morale, flags: u.flags };
    }
    let bs = -1;
    bd = R2;
    const sl = this.structs.list;
    for (let i = 0; i < sl.length; i++) {
      const s = sl[i];
      if (!this.project(s.x, s.y + 0.45, s.z)) continue;
      const d = (_v.x - sx) * (_v.x - sx) + (_v.y - sy) * (_v.y - sy);
      if (d < bd) { bd = d; bs = i; }
    }
    if (bs >= 0) {
      const s = sl[bs];
      return { ...none, kind: 'struct', id: s.id, owner: s.owner, faction: s.faction, tile: s.tile, structKind: s.kind, hp: s.hp, flags: s.flags };
    }
    if (!this.groundAt(sx, sy, _p)) return none;
    const t = tileAt(th, _p[0], _p[2]);
    // ground beyond the theatre is endless, non-simulated scenery: report it so the UI can say so
    if (t < 0) return { ...none, kind: 'tile', tile: -1 };
    return { ...none, kind: 'tile', tile: t, faction: this.territory[t] ?? -1, owner: this.owner[t] ?? -1 };
  }

  // ------------------------------------------------------------------ camera API
  setCameraMode(m: CameraMode): void { this.rig?.setMode(m); }

  focusTile(tile: number, distance?: number): void {
    const th = this.th, rig = this.rig;
    if (!th || !rig || tile < 0 || tile >= th.n) return;
    if (rig.mode !== 'free') rig.setMode('free');
    rig.focus(th.x[tile], GROUND_Y, th.z[tile], distance);
  }

  focusXZ(x: number, z: number): void {
    const rig = this.rig;
    if (!rig || !Number.isFinite(x) || !Number.isFinite(z)) return;
    if (rig.mode !== 'free') rig.setMode('free');
    rig.focus(x, GROUND_Y, z);
  }

  zoomBy(factor: number): void { this.rig?.zoomBy(factor); }
  rotateBy(yawRad: number, pitchRad: number): void { this.rig?.rotateBy(yawRad, pitchRad); }
  panBy(dx: number, dz: number): void { this.rig?.panBy(dx, dz); }
  resetNorth(): void { this.rig?.resetNorth(); }
  setPreset(p: CameraPreset): void { this.rig?.preset(p); }

  fit(): void {
    const rig = this.rig;
    if (!rig || !this.th) return;
    if (rig.mode !== 'free') rig.setMode('free');
    const a = this.activeBounds();
    rig.fit(a.minX, a.maxX, a.minZ, a.maxZ);
  }

  getCameraState(): CameraState {
    return this.rig ? this.rig.state() : { yaw: 0, pitch: Math.PI / 4, distance: 100, x: 0, z: 0, mode: 'free' };
  }

  // ------------------------------------------------------------------ minimap support
  tileXZ(tile: number): [number, number] {
    const th = this.th;
    if (!th || tile < 0 || tile >= th.n) return [0, 0];
    return [th.x[tile], th.z[tile]];
  }

  theatreBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const w = this.th?.w ?? 1, h = this.th?.h ?? 1;
    return { minX: -SQRT3 / 2, maxX: SQRT3 * (w - 0.5) + SQRT3 / 2, minZ: -1, maxZ: 1.5 * (h - 1) + 1 };
  }

  private activeBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const th = this.th;
    if (!th) return this.theatreBounds();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let t = 0; t < th.n; t++) {
      if (!this.active[t]) continue;
      if (th.x[t] < minX) minX = th.x[t]; if (th.x[t] > maxX) maxX = th.x[t];
      if (th.z[t] < minZ) minZ = th.z[t]; if (th.z[t] > maxZ) maxZ = th.z[t];
    }
    if (!Number.isFinite(minX)) return this.theatreBounds();
    return { minX: minX - 1, maxX: maxX + 1, minZ: minZ - 1, maxZ: maxZ + 1 };
  }

  /**
   * Ground points (x, z pairs) under the four screen corners, clockwise from top-left; rays above the
   * horizon clamp to a far point in their heading. Allocation-free; viewFootprint() and scenery use it.
   */
  private groundCorners(out: Float32Array): void {
    const rig = this.rig;
    if (!rig) { out.fill(0); return; }
    const cam = rig.camera, o = cam.position;
    const far = Math.max(900, rig.distance * 5);
    for (let k = 0; k < 4; k++) {
      _v.set(CORNERS[k * 2], CORNERS[k * 2 + 1], 0.5).unproject(cam).sub(o).normalize();
      if (_v.y < -1e-3) {
        // horizontal distance, so a near-horizon ray clamps like one above it
        const t = (GROUND_Y - o.y) / _v.y, hl = Math.hypot(_v.x, _v.z);
        const k2 = hl * t > far ? far / (hl * t) : 1;
        out[k * 2] = o.x + _v.x * t * k2; out[k * 2 + 1] = o.z + _v.z * t * k2;
      } else {
        const hl = Math.hypot(_v.x, _v.z) || 1;
        out[k * 2] = o.x + (_v.x / hl) * far; out[k * 2 + 1] = o.z + (_v.z / hl) * far;
      }
    }
  }

  viewFootprint(): [number, number][] {
    if (!this.rig) return [];
    const c = this.corners;
    this.groundCorners(c);
    return [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]], [c[6], c[7]]];
  }

  minimapData(): MinimapData {
    const th = this.th;
    const mm = this.mm ?? (this.mm = {
      w: 0, h: 0, terrain: new Uint8Array(0), territory: new Int8Array(0), active: new Uint8Array(0),
      structs: [], units: [], opCenter: -1, opRadius: 0, battles: [],
    });
    if (!th) return mm;
    mm.w = th.w; mm.h = th.h; mm.terrain = th.map.terrain; mm.territory = this.territory; mm.active = this.active;
    const sl = this.structs.list;
    mm.structs.length = sl.length;
    for (let i = 0; i < sl.length; i++) {
      const s = sl[i];
      const e = mm.structs[i] ?? (mm.structs[i] = { tile: 0, kind: 0, faction: -1 });
      e.tile = s.tile; e.kind = s.kind; e.faction = s.faction;
    }
    const ul = this.units.list;
    mm.units.length = ul.length;
    for (let i = 0; i < ul.length; i++) {
      const u = ul[i];
      const e = mm.units[i] ?? (mm.units[i] = { x: 0, z: 0, faction: -1 });
      e.x = u.x; e.z = u.z; e.faction = u.faction;
    }
    mm.opCenter = this.opInfo?.center ?? -1;
    mm.opRadius = this.opInfo?.radius ?? 0;
    mm.battles = this.battles;
    return mm;
  }

  hostRect(): DOMRect { return this.host ? this.host.getBoundingClientRect() : new DOMRect(); }
}
