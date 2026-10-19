// Combat and world effects, ported from the 2D renderer's fx kinds and timings: tracers (rifle double taps,
// heavy walker bolts, cyan turret bolts), muzzle flashes, sparks, explosions (flash, fireball, fire, sparks,
// debris, rising smoke, ground shockwave), artillery shells on parabolic arcs, capture/build/spawn rings,
// core fall with camera shake, scorch decals that fade over 45 s, storms with drifting clouds and lightning.
// Everything lives in fixed pools and preallocated batches; spawning never allocates.

import * as THREE from 'three';
import { U } from '../../shared/config.ts';
import { FX, FX_STRIDE } from '../../shared/protocol.ts';
import { RGB, factionHex, isWater, linRGB, mixHex, tileAt, type Theatre } from './common.ts';
import {
  BillboardBatch, HEX_FILL, P_DOT, P_GLOW, P_SMOKE, ParticleSystem, RING, RibbonBatch, spriteMaterial, touchRange, type RingBatch,
} from './batches.ts';
import { FOG_FACTOR_GLSL, TIME, fogUniforms } from './materials.ts';

interface Tracer { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; t0: number; dur: number; r: number; g: number; b: number; w: number; len: number }
interface Shell { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; t0: number; dur: number; r: number; g: number; b: number; h: number; col: number; boom: boolean }
interface FxRing { x: number; y: number; z: number; t0: number; dur: number; r0: number; r1: number; w: number; r: number; g: number; b: number; a: number; mode: number }
interface Bolt { pts: Float32Array; t0: number }

const MAX_TRACERS = 700, MAX_SHELLS = 160, MAX_RINGS = 420, MAX_BOLTS = 6, MAX_DECALS = 160;

function pool<T>(n: number, make: () => T): T[] { const a: T[] = []; for (let i = 0; i < n; i++) a.push(make()); return a; }

/** Scorch marks: instanced ground quads with a procedural soot blob; age fades in the shader. */
class DecalLayer {
  readonly mesh: THREE.InstancedMesh;
  private data: Float32Array;
  private attr: THREE.InstancedBufferAttribute;
  private cursor = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.data = new Float32Array(MAX_DECALS * 3);
    this.attr = new THREE.InstancedBufferAttribute(this.data, 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iDecal', this.attr);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms(), uTime: TIME },
      fog: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      vertexShader: /* glsl */ `
        attribute vec3 iDecal;
        uniform float uTime;
        varying vec2 vUv; varying float vA; varying float vSeed;
        #include <fog_pars_vertex>
        void main() {
          vUv = uv * 2.0 - 1.0;
          float age = uTime - iDecal.x;
          vA = iDecal.y > 0.0 ? clamp( 1.0 - age / iDecal.y, 0.0, 1.0 ) : 0.0;
          vSeed = iDecal.z;
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying float vA; varying float vSeed;
        #include <fog_pars_fragment>
        void main() {
          float r = length( vUv );
          float ang = atan( vUv.y, vUv.x );
          float edge = 0.78 + 0.12 * sin( ang * 5.0 + vSeed * 6.28 ) + 0.08 * sin( ang * 11.0 - vSeed * 3.0 );
          float a = ( 1.0 - smoothstep( edge * 0.25, edge, r ) ) * 0.62 * vA;
          if ( a <= 0.003 ) discard;
          vec3 col = vec3( 0.006, 0.005, 0.004 );
          ${FOG_FACTOR_GLSL}
          gl_FragColor = vec4( col, a * ( 1.0 - fogF ) );
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_DECALS);
    (this.mesh.instanceMatrix.array as Float32Array).fill(0);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  add(x: number, y: number, z: number, size: number, timeS: number): void {
    const i = this.cursor % MAX_DECALS;
    this.cursor++;
    this.q.setFromAxisAngle(this.up, Math.random() * Math.PI * 2);
    this.m.compose(this.p.set(x, y, z), this.q, this.s.set(size, 1, size * (0.75 + Math.random() * 0.35)));
    this.mesh.setMatrixAt(i, this.m);
    this.data[i * 3] = timeS; this.data[i * 3 + 1] = 45; this.data[i * 3 + 2] = Math.random();
    this.mesh.count = Math.min(this.cursor, MAX_DECALS);
    touchRange(this.mesh.instanceMatrix, this.mesh.count);
    touchRange(this.attr, this.mesh.count);
  }

  clear(): void { this.cursor = 0; this.mesh.count = 0; }

  dispose(): void { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.dispose(); }
}

/** fog: the fog view (0 unseen, 1 remembered, 2 visible) or null; effects only play where the viewer can see. */
export interface FxCtx { th: Theatre; speed: number; pos: (id: number, out: Float32Array) => boolean; fog: Uint8Array | null }

const _a = new Float32Array(3), _b = new Float32Array(3);
function j(): number { return (Math.random() - 0.5) * 0.22; }

export class EffectsLayer {
  readonly group = new THREE.Group();
  readonly add: ParticleSystem;
  readonly smoke: ParticleSystem;
  readonly pointScale = { value: 600 };
  private lines: RibbonBatch;
  private clouds: BillboardBatch;
  private decals = new DecalLayer();
  private light: THREE.PointLight;
  private tracers: Tracer[] = pool(MAX_TRACERS, () => ({ x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, t0: 0, dur: 1, r: 0, g: 0, b: 0, w: 0, len: 0 }));
  private nT = 0;
  private shells: Shell[] = pool(MAX_SHELLS, () => ({ x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, t0: 0, dur: 1, r: 0, g: 0, b: 0, h: 1, col: 0, boom: true }));
  private nS = 0;
  private rings: FxRing[] = pool(MAX_RINGS, () => ({ x: 0, y: 0, z: 0, t0: 0, dur: 1, r0: 0, r1: 0, w: 0, r: 0, g: 0, b: 0, a: 0, mode: 0 }));
  private nR = 0;
  private bolts: Bolt[] = pool(MAX_BOLTS, () => ({ pts: new Float32Array(21), t0: 0 }));
  private nB = 0;
  private storms: { tile: number; radius: number }[] = [];
  private stormKey = '';
  private cloud = new Float32Array(0); // per cloud: storm, ang, rad, spd, height, size, r, g, b, a
  private nCloud = 0;
  shake = 0;
  private th: Theatre | null = null;
  private flashUntil = 0;

  constructor() {
    this.add = new ParticleSystem(4800, spriteMaterial(true, this.pointScale), 6, 320);
    this.smoke = new ParticleSystem(2800, spriteMaterial(false, this.pointScale), 5, 16);
    this.lines = new RibbonBatch(2600, { ground: false, additive: true, renderOrder: 7 });
    this.clouds = new BillboardBatch(160, 8);
    this.light = new THREE.PointLight(0xc8d8ff, 0, 60, 1.6);
    this.light.position.set(0, -50, 0);
    this.group.add(this.decals.mesh, this.smoke.mesh, this.add.mesh, this.lines.mesh, this.clouds.mesh, this.light);
  }

  setWidthScale(k: number): void { this.lines.widthScale.value = k; }

  setTheatre(th: Theatre): void {
    this.th = th;
    this.nT = 0; this.nS = 0; this.nR = 0; this.nB = 0;
    this.add.clear(); this.smoke.clear(); this.decals.clear();
    this.storms = []; this.stormKey = ''; this.nCloud = 0;
  }

  // ------------------------------------------------------------------ spawners
  ring(x: number, y: number, z: number, t0: number, dur: number, r0: number, r1: number, w: number, r: number, g: number, b: number, a: number, mode = RING): void {
    if (this.nR >= MAX_RINGS) return;
    const o = this.rings[this.nR++];
    o.x = x; o.y = y; o.z = z; o.t0 = t0; o.dur = dur; o.r0 = r0; o.r1 = r1; o.w = w; o.r = r; o.g = g; o.b = b; o.a = a; o.mode = mode;
  }

  private tracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t0: number, dur: number, r: number, g: number, b: number, w: number, len: number): void {
    if (this.nT >= MAX_TRACERS) return;
    const o = this.tracers[this.nT++];
    o.x0 = x0; o.y0 = y0; o.z0 = z0; o.x1 = x1; o.y1 = y1; o.z1 = z1; o.t0 = t0; o.dur = dur; o.r = r; o.g = g; o.b = b; o.w = w; o.len = len;
  }

  private glow(x: number, y: number, z: number, life: number, s0: number, s1: number, a: number, r: number, g: number, b: number, delay: number): void {
    this.add.spawn(x, y, z, 0, 0, 0, life, s0, s1, a, r, g, b, P_GLOW, 0, 0, delay);
  }

  spark(x: number, y: number, z: number, r: number, g: number, b: number, n: number, delay: number, speed = 1): void {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, v = (1.2 + Math.random() * 2.4) * speed;
      this.add.spawn(x, y, z, Math.cos(a) * v, 0.6 + Math.random() * 2.2 * speed, Math.sin(a) * v, 260 + Math.random() * 220, 0.07, 0.025, 1, r, g, b, P_DOT, 7, 1.2, delay);
    }
  }

  private puff(x: number, y: number, z: number, size: number, delay: number): void {
    const n = Math.round(1 + size * 2.2);
    for (let k = 0; k < n; k++) {
      const c = 0.034 + Math.random() * 0.04;
      this.smoke.spawn(x + (Math.random() - 0.5) * 0.45 * size, y + 0.15, z + (Math.random() - 0.5) * 0.45 * size,
        (Math.random() - 0.5) * 0.25, 0.35 + Math.random() * 0.4, (Math.random() - 0.5) * 0.25,
        1500 + Math.random() * 1100, 0.45 * size, 2.1 * size, 0.36, c, c * 1.04, c * 1.12, P_SMOKE, 0, 0.35, delay + k * 40);
    }
  }

  explosion(x: number, y: number, z: number, s: number, col: number, delay: number, now: number): void {
    this.glow(x, y + 0.25, z, 200 * s, 0.55 * s, 1.5 * s, 1, 2.6, 2.0, 1.4, delay);
    linRGB(mixHex(col, 0xff6a20, 0.65), RGB, 0, 1.5);
    this.add.spawn(x, y + 0.32, z, 0, 0.5, 0, 480 * s, 0.7 * s, 1.8 * s, 0.55, RGB[0], RGB[1], RGB[2], P_GLOW, 0, 1.5, delay);
    const nf = Math.round(4 * s);
    for (let k = 0; k < nf; k++) {
      const a = Math.random() * 6.283, v = 0.4 + Math.random() * 0.8;
      this.add.spawn(x + Math.cos(a) * 0.15 * s, y + 0.25, z + Math.sin(a) * 0.15 * s, Math.cos(a) * v, 0.6 + Math.random() * 0.9, Math.sin(a) * v,
        460 + Math.random() * 340, 0.3 * s, 0.8 * s, 0.6, 1.3, 0.5, 0.13, P_GLOW, 0, 2.2, delay + 20);
    }
    const ns = Math.round(9 * s);
    for (let k = 0; k < ns; k++) {
      const a = Math.random() * 6.283, v = (1.8 + Math.random() * 3.2) * Math.sqrt(s);
      const hot = Math.random() < 0.5;
      this.add.spawn(x, y + 0.2, z, Math.cos(a) * v, 1.5 + Math.random() * 3.5 * Math.sqrt(s), Math.sin(a) * v, 380 + Math.random() * 380, 0.075, 0.03, 1,
        2.6, hot ? 1.7 : 2.3, hot ? 0.8 : 1.6, P_DOT, 9, 0.6, delay);
    }
    const nd = Math.round(5 * s);
    for (let k = 0; k < nd; k++) {
      const a = Math.random() * 6.283, v = 1 + Math.random() * 2.2 * s;
      this.smoke.spawn(x, y + 0.2, z, Math.cos(a) * v, 2 + Math.random() * 2.5, Math.sin(a) * v, 800 + Math.random() * 400, 0.09, 0.06, 0.95, 0.02, 0.018, 0.015, P_DOT, 9.8, 0.3, delay);
    }
    this.ring(x, y + 0.06, z, now + delay, 420 * s, 0.15, 1.1 * s, 0.1 * s, 1.5, 1.25, 0.95, 0.7);
    this.puff(x, y, z, s, delay + 80);
  }

  private decal(x: number, z: number, size: number, timeS: number): void {
    const th = this.th;
    if (!th) return;
    const t = tileAt(th, x, z);
    // no soot on water or on a bridge (a deck-height decal would hang in the air beside the narrow deck)
    if (t >= 0 && isWater(th.map.terrain[t])) return;
    const y = t >= 0 ? th.walk[t] : 0.75;
    this.decals.add(x, y + 0.01, z, 1.25 * size, timeS);
  }

  /** Frontier chunk opening: a wide amber ring pulse and rising sparkles across the chunk. */
  reveal(x: number, y: number, z: number, radius: number, now: number): void {
    this.ring(x, y, z, now, 1700, 0.5, radius, 0.5, 2.4, 1.6, 0.7, 0.85);
    this.ring(x, y, z, now + 260, 1500, 0.3, radius * 0.75, 0.25, 2.6, 2.0, 1.1, 0.6);
    for (let k = 0; k < 28; k++) {
      const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * radius * 0.8;
      this.add.spawn(x + Math.cos(a) * r, y + 0.1, z + Math.sin(a) * r, 0, 0.8 + Math.random() * 1.4, 0, 900 + Math.random() * 700, 0.1, 0.04, 1, 2.6, 1.7, 0.6, P_DOT, -0.2, 0.8, Math.random() * 600);
    }
  }

  applyFx(fx: Float32Array, now: number, c: FxCtx): void {
    const th = c.th;
    const n = (fx.length / FX_STRIDE) | 0;
    let shots = 0;
    for (let i = 0; i < n; i++) if (fx[i * FX_STRIDE] === FX.SHOT) shots++;
    const budget = Math.max(0, 420 - this.nT);
    const keep = shots > budget ? budget / shots : 1;
    const timeS = TIME.value;
    const fog = c.fog && c.fog.length === th.n ? c.fog : null;
    const W = th.walk;
    for (let i = 0; i < n; i++) {
      const o = i * FX_STRIDE;
      const kind = fx[o], a = fx[o + 1], b = fx[o + 2], f = fx[o + 3], p1 = fx[o + 4];
      const col = factionHex(f);
      const delay = Math.random() * 50;
      // in fog view an effect plays only on a visible tile, like the units (hidden unless visible)
      const tileOk = a >= 0 && a < th.n && (!fog || fog[a] === 2);
      switch (kind) {
        case FX.SHOT: {
          if (keep < 1 && Math.random() > keep) break;
          if (!c.pos(a, _a) || !c.pos(b, _b)) break;
          if (fog && !this.seenAt(fog, _a[0], _a[2]) && !this.seenAt(fog, _b[0], _b[2])) break;
          const cls = p1;
          if (cls === U.RIFLE || cls === U.SCOUT || cls === U.ENGINEER) {
            linRGB(mixHex(col, 0xfff3d6, 0.55), RGB, 0, 2.6);
            const r = RGB[0], g = RGB[1], bb = RGB[2];
            const bursts = cls === U.RIFLE ? 2 : 1;
            for (let k = 0; k < bursts; k++) this.tracer(_a[0] + j(), _a[1] + j() * 0.4, _a[2] + j(), _b[0] + j(), _b[1] + j() * 0.4, _b[2] + j(), now + delay + k * 55, 110, r, g, bb, 0.055, 0.35);
            this.glow(_a[0], _a[1], _a[2], 90, 0.36, 0.14, 0.8, r * 0.8, g * 0.8, bb * 0.8, delay);
            if (Math.random() < 0.5) this.spark(_b[0], _b[1], _b[2], r, g, bb, 2, delay + 110, 0.7);
          } else if (cls === U.WALKER) {
            linRGB(mixHex(col, 0xffffff, 0.35), RGB, 0, 3.2);
            this.tracer(_a[0], _a[1] + 0.1, _a[2], _b[0] + j(), _b[1], _b[2] + j(), now + delay, 140, RGB[0], RGB[1], RGB[2], 0.14, 0.5);
            this.glow(_a[0], _a[1] + 0.1, _a[2], 130, 0.6, 0.25, 0.9, RGB[0], RGB[1], RGB[2], delay);
            this.glow(_b[0], _b[1], _b[2], 220, 0.4, 0.9, 0.7, 2.2, 1.1, 0.45, delay + 140);
            this.spark(_b[0], _b[1], _b[2], 2.6, 1.9, 1.1, 5, delay + 140);
          } else {
            // defensive structure turret bolt
            linRGB(mixHex(col, 0x9feaff, 0.6), RGB, 0, 3);
            this.tracer(_a[0], _a[1] + 0.15, _a[2], _b[0], _b[1], _b[2], now + delay, 160, RGB[0], RGB[1], RGB[2], 0.1, 0.6);
            this.glow(_a[0], _a[1] + 0.15, _a[2], 120, 0.5, 0.2, 0.8, RGB[0], RGB[1], RGB[2], delay);
            this.spark(_b[0], _b[1], _b[2], 1.2, 2.4, 2.7, 3, delay + 160);
          }
          break;
        }
        case FX.SHELL: {
          if (!c.pos(a, _a) || b < 0 || b >= th.n) break;
          const from = !fog || this.seenAt(fog, _a[0], _a[2]), to = !fog || fog[b] === 2;
          if (!from && !to) break;
          const dur = Math.max(260, Math.min(1600, (p1 * 200) / Math.max(0.5, c.speed)));
          if (this.nS < MAX_SHELLS) {
            const s = this.shells[this.nS++];
            s.x0 = _a[0]; s.y0 = _a[1] + 0.1; s.z0 = _a[2]; s.x1 = th.x[b]; s.y1 = W[b] + 0.1; s.z1 = th.z[b]; s.boom = to;
            s.t0 = now + delay; s.dur = dur;
            linRGB(mixHex(col, 0xffe2b0, 0.5), RGB, 0, 3);
            s.r = RGB[0]; s.g = RGB[1]; s.b = RGB[2]; s.col = col;
            s.h = Math.max(1.5, Math.min(9, Math.hypot(s.x1 - s.x0, s.z1 - s.z0) * 0.32));
          }
          if (from) {
            this.glow(_a[0], _a[1] + 0.1, _a[2], 180, 0.6, 0.25, 1, 2.6, 2.1, 1.5, delay);
            this.puff(_a[0], _a[1] - 0.15, _a[2], 0.6, delay);
          }
          break;
        }
        case FX.IMPACT: if (tileOk) this.explosion(th.x[a], W[a], th.z[a], p1 >= 2 ? 0.9 : 0.6, col, delay, now); break;
        case FX.DEATH: {
          if (!tileOk) break;
          const big = b === U.WALKER || b === U.ARTILLERY;
          const x = th.x[a] + (Math.random() - 0.5) * 0.45, z = th.z[a] + (Math.random() - 0.5) * 0.35;
          this.explosion(x, W[a], z, big ? 1.5 : 0.85, col, delay, now);
          this.decal(th.x[a] + (Math.random() - 0.5) * 0.45, th.z[a] + (Math.random() - 0.5) * 0.3, big ? 1.1 : 0.7, timeS);
          break;
        }
        case FX.CAPTURE: {
          if (!tileOk) break;
          const x = th.x[a], y = W[a] + 0.05, z = th.z[a];
          linRGB(col, RGB, 0, 2.2);
          const r = RGB[0], g = RGB[1], bb = RGB[2];
          if (b >= 0) {
            this.ring(x, y, z, now + delay, 1300, 0.33, 2.55, 0.14, r, g, bb, 0.9);
            linRGB(mixHex(col, 0xffffff, 0.5), RGB, 0, 2.2);
            this.ring(x, y, z, now + delay + 200, 1100, 0.22, 1.67, 0.08, RGB[0], RGB[1], RGB[2], 0.7);
            this.ring(x, y + 0.01, z, now + delay, 900, 1, 1, 0.05, r * 0.6, g * 0.6, bb * 0.6, 0.5, HEX_FILL);
            for (let k = 0; k < 12; k++) {
              const ang = Math.random() * 6.283, rr = Math.random() * 0.5;
              this.add.spawn(x + Math.cos(ang) * rr, y, z + Math.sin(ang) * rr, 0, 2 + Math.random() * 2.5, 0, 700 + Math.random() * 400, 0.22, 0.06, 0.9, r, g, bb, P_GLOW, 0, 1.4, delay + k * 25);
            }
          } else {
            this.ring(x, y + 0.01, z, now + delay, 700, 0.95, 0.95, 0.05, r * 0.5, g * 0.5, bb * 0.5, 0.22, HEX_FILL);
          }
          break;
        }
        case FX.BUILT: {
          if (!tileOk) break;
          const x = th.x[a], y = W[a] + 0.05, z = th.z[a];
          this.ring(x, y, z, now + delay, 900, 0.22, 1.45, 0.09, 1.0, 1.8, 2.0, 0.9);
          for (let k = 0; k < 8; k++) this.add.spawn(x + (Math.random() - 0.5) * 0.5, y + 0.2, z + (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.6, 0.8 + Math.random() * 0.9, (Math.random() - 0.5) * 0.6, 700, 0.11, 0.03, 0.9, 1.1, 2.4, 3, P_DOT, 0, 1, delay);
          break;
        }
        case FX.DESTROYED: {
          if (!tileOk) break;
          this.explosion(th.x[a], W[a], th.z[a], 1.6, col, delay, now);
          this.decal(th.x[a], th.z[a], 1.3, timeS);
          break;
        }
        case FX.CORE_FALL: {
          if (!tileOk) break;
          const x = th.x[a], y = W[a], z = th.z[a];
          for (let k = 0; k < 5; k++) this.explosion(x + (Math.random() - 0.5) * 1.45, y + Math.random() * 0.6, z + (Math.random() - 0.5) * 1.1, 1.8, col, delay + k * 140, now);
          this.glow(x, y + 1.2, z, 900, 2, 6, 0.85, 3, 2.3, 1.6, delay);
          this.ring(x, y + 0.08, z, now + delay, 1600, 0.55, 7.2, 0.24, 2.5, 2.05, 1.6, 0.9);
          this.ring(x, y + 0.08, z, now + delay + 180, 1300, 0.4, 4.4, 0.12, 2.2, 1.2, 0.6, 0.7);
          this.decal(x, z, 2.4, timeS);
          this.shake = Math.max(this.shake, 1);
          this.flashUntil = now + 260;
          this.light.position.set(x, y + 3, z);
          break;
        }
        case FX.SPAWN: {
          if (!tileOk) break;
          linRGB(col, RGB, 0, 2);
          this.ring(th.x[a], W[a] + 0.05, th.z[a], now + delay, 600, 0.11, 0.78, 0.07, RGB[0], RGB[1], RGB[2], 0.8);
          break;
        }
      }
    }
  }

  private seenAt(fog: Uint8Array, x: number, z: number): boolean {
    const t = this.th ? tileAt(this.th, x, z) : -1;
    return t >= 0 && fog[t] === 2;
  }

  setStorms(storms: { tile: number; radius: number }[]): void {
    let key = '';
    for (let i = 0; i < storms.length; i++) key += `${storms[i].tile},`;
    if (key === this.stormKey) return;
    this.stormKey = key;
    this.storms = storms.slice();
    const per = 16;
    this.nCloud = Math.min(storms.length * per, 160);
    this.cloud = new Float32Array(this.nCloud * 10);
    const c0 = new THREE.Color(0x5a6a85), c1 = new THREE.Color(0x9fb3d1);
    for (let i = 0; i < this.nCloud; i++) {
      const si = Math.floor(i / per), k = i % per, st = storms[si];
      const o = i * 10;
      const cc = c0.clone().lerp(c1, (k % 5) / 5);
      this.cloud[o] = si; this.cloud[o + 1] = (k / per) * Math.PI * 2; this.cloud[o + 2] = (0.25 + ((k * 37) % 70) / 100) * st.radius * 1.6;
      this.cloud[o + 3] = 0.04 + (k % 5) * 0.012; this.cloud[o + 4] = 5.2 + (k % 4) * 0.9 + Math.random() * 0.8;
      this.cloud[o + 5] = (0.9 + (k % 4) * 0.3) * 3.6;
      this.cloud[o + 6] = cc.r * 0.55; this.cloud[o + 7] = cc.g * 0.55; this.cloud[o + 8] = cc.b * 0.55;
      this.cloud[o + 9] = 0.2 + (k % 3) * 0.05;
    }
  }

  /** Per-frame: advance pools, rebuild the line batch, push effect rings into the shared ring batch. */
  update(now: number, dt: number, rings: RingBatch, weather: boolean): void {
    const th = this.th;
    const L = this.lines;
    L.begin();
    for (let i = this.nT - 1; i >= 0; i--) {
      const t = this.tracers[i];
      const p = (now - t.t0) / t.dur;
      if (p > 1) { this.swap(this.tracers, i, --this.nT); continue; }
      if (p < 0) continue;
      const head = Math.min(1, p * 1.25), tail = Math.max(0, head - t.len);
      const ax = t.x0 + (t.x1 - t.x0) * tail, ay = t.y0 + (t.y1 - t.y0) * tail, az = t.z0 + (t.z1 - t.z0) * tail;
      const bx = t.x0 + (t.x1 - t.x0) * head, by = t.y0 + (t.y1 - t.y0) * head, bz = t.z0 + (t.z1 - t.z0) * head;
      const fade = 1 - p * 0.45;
      L.seg(ax, ay, az, bx, by, bz, t.w * 3.2, t.r * 0.35, t.g * 0.35, t.b * 0.35, 0, 0.5 * fade);
      L.seg(ax, ay, az, bx, by, bz, t.w, t.r, t.g, t.b, 0.15 * fade, fade);
    }
    for (let i = this.nS - 1; i >= 0; i--) {
      const s = this.shells[i];
      const p = (now - s.t0) / s.dur;
      if (p < 0) continue;
      if (p >= 1) {
        if (s.boom) this.explosion(s.x1, s.y1 - 0.1, s.z1, 0.9, s.col, 0, now);
        this.swap(this.shells, i, --this.nS);
        continue;
      }
      let px = 0, py = 0, pz = 0;
      for (let k = 0; k <= 6; k++) {
        const q = Math.max(0, p - 0.16 + (k / 6) * 0.16);
        const x = s.x0 + (s.x1 - s.x0) * q, y = s.y0 + (s.y1 - s.y0) * q + Math.sin(q * Math.PI) * s.h, z = s.z0 + (s.z1 - s.z0) * q;
        if (k > 0) L.seg(px, py, pz, x, y, z, 0.1, s.r, s.g, s.b, ((k - 1) / 6) * 0.55, (k / 6) * 0.55);
        px = x; py = y; pz = z;
      }
      this.add.flash(px, py, pz, 0.32, P_GLOW, 3, 2.8, 2.3, 1);
    }
    // lightning
    if (weather && this.storms.length && th && Math.random() < dt / 2400 && this.nB < MAX_BOLTS) {
      const st = this.storms[Math.floor(Math.random() * this.storms.length)];
      if (st.tile >= 0 && st.tile < th.n) {
        const span = Math.max(2, st.radius * 1.1);
        const x = th.x[st.tile] + (Math.random() - 0.5) * span * 2, z = th.z[st.tile] + (Math.random() - 0.5) * span * 2;
        const bolt = this.bolts[this.nB++];
        bolt.t0 = now;
        const gy = 0.75;
        for (let k = 0; k <= 6; k++) {
          const q = k / 6;
          const jx = k === 0 ? 0 : (Math.random() - 0.5) * 1.3, jz = k === 0 ? 0 : (Math.random() - 0.5) * 1.3;
          bolt.pts[k * 3] = x + jx; bolt.pts[k * 3 + 1] = 15 - (15 - gy) * q; bolt.pts[k * 3 + 2] = z + jz;
        }
        this.add.spawn(x, gy + 0.3, z, 0, 0, 0, 260, 5, 8, 0.32, 0.75, 0.83, 1, P_GLOW, 0, 0, 0);
        this.light.position.set(x, 7, z);
        this.flashUntil = now + 220;
      }
    }
    for (let i = this.nB - 1; i >= 0; i--) {
      const bolt = this.bolts[i];
      const age = now - bolt.t0;
      if (age > 220 || !weather) { this.swap(this.bolts, i, --this.nB); continue; }
      const a = 1 - age / 220;
      const P = bolt.pts;
      for (let k = 0; k < 6; k++) {
        L.seg(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], P[k * 3 + 3], P[k * 3 + 4], P[k * 3 + 5], 0.6, 0.6, 0.7, 1, a * 0.25, a * 0.25);
        L.seg(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], P[k * 3 + 3], P[k * 3 + 4], P[k * 3 + 5], 0.12, 3.5, 3.9, 5, a, a);
      }
    }
    L.end();
    const fl = this.flashUntil - now;
    this.light.intensity = fl > 0 ? (fl / 240) * 90 : 0;
    // rings
    for (let i = this.nR - 1; i >= 0; i--) {
      const r = this.rings[i];
      const p = (now - r.t0) / r.dur;
      if (p > 1) { this.swap(this.rings, i, --this.nR); continue; }
      if (p < 0) continue;
      const e = 1 - Math.pow(1 - p, 3);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      const fade = 1 - p;
      rings.push(r.x, r.y, r.z, rad, r.mode === RING ? r.w * (1 - p * 0.6) : r.w, r.mode, r.r, r.g, r.b, r.a * fade);
    }
    // clouds
    const C = this.clouds;
    C.begin();
    if (weather && th) {
      for (let i = 0; i < this.nCloud; i++) {
        const o = i * 10;
        const st = this.storms[this.cloud[o]];
        if (!st || st.tile < 0 || st.tile >= th.n) continue;
        this.cloud[o + 1] += this.cloud[o + 3] * dt * 0.001;
        const ang = this.cloud[o + 1], rad = this.cloud[o + 2];
        const sz = this.cloud[o + 5];
        C.push(th.x[st.tile] + Math.cos(ang) * rad, this.cloud[o + 4], th.z[st.tile] + Math.sin(ang) * rad, sz, sz * 0.62, i * 0.77,
          this.cloud[o + 6], this.cloud[o + 7], this.cloud[o + 8], this.cloud[o + 9]);
      }
    }
    C.end();
    this.add.update(dt);
    this.smoke.update(dt);
    this.shake *= Math.exp(-dt / 380);
    if (this.shake < 0.01) this.shake = 0;
  }

  private swap<T>(arr: T[], i: number, last: number): void {
    if (i === last) return;
    const tmp = arr[i]; arr[i] = arr[last]; arr[last] = tmp;
  }

  dispose(): void {
    this.add.dispose(); this.smoke.dispose(); this.lines.dispose(); this.clouds.dispose(); this.decals.dispose();
    (this.add.mesh.material as THREE.Material).dispose();
    (this.smoke.mesh.material as THREE.Material).dispose();
  }
}
