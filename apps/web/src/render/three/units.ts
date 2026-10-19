// Units: one instanced mesh per class part with per-instance faction colour. Positions interpolate between
// committed frames exactly like the 2D renderer (tile -> next by progress t, stacking offsets per occupied
// tile, exponential smoothing), follow tile heights, and yaw toward their heading or, in combat, their
// target. Rifle squads draw 1..5 soldiers from hp, walkers animate legs, artillery raises its barrel when
// set up. Markers (selection, evacuation rings) go to the ring batch; bars and glyphs to the HUD batch.

import * as THREE from 'three';
import { U } from '../../shared/config.ts';
import { UF, UNIT_STRIDE } from '../../shared/protocol.ts';
import { FACTION_LIN, clamp, fIdx, lerpAngle, smooth01, tileAt, yawOf, type Theatre } from './common.ts';
import { RING, SH_CHEVRON, SH_RECT, SH_STAR, touchRange, type RingBatch, type SpriteBatch, P_DOT, type ParticleSystem } from './batches.ts';
import { partMaterial } from './materials.ts';
import {
  artilleryBarrelGeometry, artilleryCarriageGeometry, engineerGeometry, scoutGeometry, soldierGeometry, walkerBodyGeometry,
  walkerLegGeometry,
} from './models.ts';

export interface UnitVis {
  id: number; cls: number; faction: number; owner: number; tile: number; next: number; prog: number;
  x: number; y: number; z: number; tx: number; ty: number; tz: number;
  yaw: number; heading: number; hp: number; supply: number; morale: number; flags: number; target: number;
  soldiers: number; seen: number; idx: number; phase: number; legPhase: number; setup: number; move: number;
  shown: boolean;
}

const FORM: readonly (readonly [number, number])[] = [[0.15, 0], [0.03, -0.11], [0.03, 0.11], [-0.09, -0.2], [-0.09, 0.2]];
const LEGS: readonly (readonly [number, number, number])[] = [[0.12, 0.13, 0], [0.12, -0.13, Math.PI], [-0.12, 0.13, Math.PI], [-0.12, -0.13, 0]];
const STACK_R = 0.42;
/** Fraction of a tile move over which a unit hops a height step (always ahead of the step going up). */
const STEP_T = 0.14;
/** Largest distance of a unit from the bridge axis on a crossing, so squads and walkers stay on the deck. */
const BRIDGE_LANE = 0.24;

type Part = 'scout' | 'soldier' | 'wbody' | 'wleg' | 'eng' | 'acar' | 'abar';
const PARTS: Part[] = ['scout', 'soldier', 'wbody', 'wleg', 'eng', 'acar', 'abar'];
const PER_UNIT: Record<Part, number> = { scout: 1, soldier: 5, wbody: 1, wleg: 4, eng: 1, acar: 1, abar: 1 };

/** Writes T(x,y,z) * Ry(yaw) * Rz(pitch) * S(k) into a column-major instance matrix slot. */
function writeYP(arr: Float32Array, i: number, x: number, y: number, z: number, yaw: number, pitch: number, k: number): void {
  const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const o = i * 16;
  arr[o] = c * cp * k; arr[o + 1] = sp * k; arr[o + 2] = -s * cp * k; arr[o + 3] = 0;
  arr[o + 4] = -c * sp * k; arr[o + 5] = cp * k; arr[o + 6] = s * sp * k; arr[o + 7] = 0;
  arr[o + 8] = s * k; arr[o + 9] = 0; arr[o + 10] = c * k; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}

export interface UnitFrameCtx {
  now: number; dt: number; camDist: number; camX: number; camY: number; camZ: number;
  selectedOwner: number; selectedUnit: number; fog: Uint8Array | null;
  rings: RingBatch; hud: SpriteBatch; sparks: ParticleSystem;
  targetPos: (id: number, out: Float32Array) => boolean;
}

const _tp = new Float32Array(3);

export class UnitLayer {
  readonly group = new THREE.Group();
  readonly units = new Map<number, UnitVis>();
  readonly list: UnitVis[] = [];
  private meshes = {} as Record<Part, THREE.InstancedMesh>;
  private geos = {} as Record<Part, THREE.BufferGeometry>;
  private material: THREE.MeshStandardMaterial;
  private th: Theatre | null = null;
  private occCount = new Int16Array(0);
  private occSlot = new Int16Array(0);
  private touched: number[] = [];
  private frameNo = 0;
  private counts: Record<Part, number> = { scout: 0, soldier: 0, wbody: 0, wleg: 0, eng: 0, acar: 0, abar: 0 };
  scale = 1;

  constructor() {
    this.material = partMaterial({ glow: 2.0, roughness: 0.55, metalness: 0.35 });
    this.geos = {
      scout: scoutGeometry(), soldier: soldierGeometry(), wbody: walkerBodyGeometry(), wleg: walkerLegGeometry(),
      eng: engineerGeometry(), acar: artilleryCarriageGeometry(), abar: artilleryBarrelGeometry(),
    };
    for (const p of PARTS) this.meshes[p] = this.makeMesh(p, 160 * PER_UNIT[p]);
  }

  private makeMesh(p: Part, cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geos[p], this.material, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const c = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    c.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = c;
    m.count = 0;
    m.castShadow = true;
    m.receiveShadow = false;
    m.frustumCulled = false;
    this.group.add(m);
    return m;
  }

  private ensure(p: Part, need: number): void {
    const m = this.meshes[p];
    if (need <= m.instanceMatrix.count) return;
    let cap = m.instanceMatrix.count;
    while (cap < need) cap *= 2;
    this.group.remove(m);
    m.dispose();
    this.meshes[p] = this.makeMesh(p, cap);
  }

  setTheatre(th: Theatre): void {
    this.th = th;
    this.occCount = new Int16Array(th.n);
    this.occSlot = new Int16Array(th.n);
    this.units.clear();
    this.list.length = 0;
  }

  /**
   * Interpolated position between tile and next by progress t. Height follows the surface the unit stands
   * on (bridge decks on crossings) and changes in a short hop at the shared edge: up just before the edge,
   * down just after it, so the unit never sinks into the higher prism.
   */
  private target(tile: number, next: number, t: number, out: Float32Array): void {
    const th = this.th!, W = th.walk;
    if (next < 0 || next >= th.n) { out[0] = th.x[tile]; out[1] = W[tile]; out[2] = th.z[tile]; return; }
    out[0] = th.x[tile] + (th.x[next] - th.x[tile]) * t;
    out[2] = th.z[tile] + (th.z[next] - th.z[tile]) * t;
    const a = W[tile], b = W[next];
    out[1] = a + (b - a) * smooth01(b > a ? (t - 0.5 + STEP_T) / STEP_T : (t - 0.5) / STEP_T);
  }

  /** Consumes a committed frame's unit block (stride UNIT_STRIDE). */
  apply(a: Float32Array): void {
    const th = this.th;
    if (!th) return;
    const seen = ++this.frameNo;
    const n = (a.length / UNIT_STRIDE) | 0;
    for (const t of this.touched) { this.occCount[t] = 0; this.occSlot[t] = 0; }
    this.touched.length = 0;
    for (let i = 0; i < n; i++) {
      const o = i * UNIT_STRIDE;
      const tile = a[o + 4], next = a[o + 5];
      const occ = next >= 0 && a[o + 6] > 0.5 ? next : tile;
      if (occ < 0 || occ >= th.n) continue;
      if (this.occCount[occ] === 0) this.touched.push(occ);
      this.occCount[occ]++;
    }
    for (let i = 0; i < n; i++) {
      const o = i * UNIT_STRIDE;
      const id = a[o], cls = a[o + 1], faction = a[o + 2], owner = a[o + 3], tile = a[o + 4], next = a[o + 5], t = a[o + 6];
      if (tile < 0 || tile >= th.n) continue;
      const hp = a[o + 7];
      this.target(tile, next, t, _tp);
      let u = this.units.get(id);
      if (!u) {
        u = {
          id, cls, faction, owner, tile, next, prog: t, x: _tp[0], y: _tp[1], z: _tp[2], tx: _tp[0], ty: _tp[1], tz: _tp[2],
          yaw: (id * 1.7) % (Math.PI * 2), heading: (id * 1.7) % (Math.PI * 2), hp, supply: 1, morale: 1, flags: 0, target: -1,
          soldiers: 5, seen, idx: this.list.length, phase: (id * 0.618) % 1 * Math.PI * 2, legPhase: 0, setup: 0, move: 0, shown: true,
        };
        this.units.set(id, u);
        this.list.push(u);
      }
      let x = _tp[0], z = _tp[2];
      const occ = next >= 0 && t > 0.5 ? next : tile;
      const cnt = occ >= 0 && occ < th.n ? this.occCount[occ] : 1;
      if (cnt > 1) {
        const k = this.occSlot[occ]++;
        const ang = (k / cnt) * Math.PI * 2 + 0.6;
        x += Math.cos(ang) * STACK_R; z += Math.sin(ang) * STACK_R;
      }
      // over a crossing the unit stands on the deck: pull it into the bridge lane (smoothing slides it there)
      const ut = tileAt(th, x, z);
      if (ut >= 0 && (th.deck[ut * 2] !== 0 || th.deck[ut * 2 + 1] !== 0)) {
        const ax = th.deck[ut * 2], az = th.deck[ut * 2 + 1];
        const lat = (x - th.x[ut]) * -az + (z - th.z[ut]) * ax;
        if (Math.abs(lat) > BRIDGE_LANE) { const d = lat - Math.sign(lat) * BRIDGE_LANE; x -= -az * d; z -= ax * d; }
      }
      if (next >= 0 && next < th.n) {
        const hx = th.x[next] - th.x[tile], hz = th.z[next] - th.z[tile];
        if (hx || hz) u.heading = yawOf(hx, hz);
      }
      u.tx = x; u.ty = _tp[1]; u.tz = z;
      u.cls = cls; u.faction = faction; u.owner = owner; u.tile = tile; u.next = next; u.prog = t;
      u.hp = hp; u.supply = a[o + 8]; u.morale = a[o + 9]; u.flags = a[o + 10]; u.target = a[o + 11];
      u.soldiers = cls === U.RIFLE ? Math.max(1, Math.min(5, Math.ceil(hp * 5))) : 0;
      u.seen = seen;
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const u = this.list[i];
      if (u.seen === seen) continue;
      this.units.delete(u.id);
      const last = this.list.pop()!;
      if (last !== u) { this.list[i] = last; last.idx = i; }
    }
  }

  /** Current interpolated position of a unit (fx anchors); false if unknown. */
  pos(id: number, out: Float32Array): boolean {
    const u = this.units.get(id);
    if (!u) return false;
    out[0] = u.x; out[1] = u.y + 0.22 * this.scale; out[2] = u.z;
    return true;
  }

  centroid(owner: number, out: Float32Array): boolean {
    let x = 0, z = 0, n = 0;
    for (let i = 0; i < this.list.length; i++) { const u = this.list[i]; if (u.owner === owner) { x += u.x; z += u.z; n++; } }
    if (!n) return false;
    out[0] = x / n; out[1] = 0; out[2] = z / n;
    return true;
  }

  update(c: UnitFrameCtx): void {
    const th = this.th;
    if (!th) return;
    const dt = c.dt;
    const k = 1 - Math.exp(-dt / 85), ky = 1 - Math.exp(-dt / 110), kyaw = 1 - Math.exp(-dt / 120), ks = 1 - Math.exp(-dt / 300);
    // icon scaling: units grow with distance so silhouettes stay readable from strategic zoom
    const S = 1 + clamp((c.camDist - 35) / 160, 0, 1) * 1.5;
    this.scale = S;
    const counts = this.counts;
    for (let p = 0; p < PARTS.length; p++) counts[PARTS[p]] = 0;
    let nScout = 0, nRifle = 0, nWalk = 0, nEng = 0, nArt = 0;
    for (let i = 0; i < this.list.length; i++) {
      const u = this.list[i];
      if (u.cls === U.SCOUT) nScout++; else if (u.cls === U.RIFLE) nRifle++; else if (u.cls === U.WALKER) nWalk++; else if (u.cls === U.ENGINEER) nEng++; else nArt++;
    }
    this.ensure('scout', nScout); this.ensure('soldier', nRifle * 5); this.ensure('wbody', nWalk); this.ensure('wleg', nWalk * 4);
    this.ensure('eng', nEng); this.ensure('acar', nArt); this.ensure('abar', nArt);
    const now = c.now;
    const detail = c.camDist < 58;
    for (let i = 0; i < this.list.length; i++) {
      const u = this.list[i];
      const dx = (u.tx - u.x) * k, dz = (u.tz - u.z) * k;
      u.x += dx; u.z += dz; u.y += (u.ty - u.y) * ky;
      // the smoothed position can lag onto a higher tile than the smoothed height: stay on the surface beneath
      const under = tileAt(th, u.x, u.z);
      if (under >= 0 && u.y < th.walk[under]) u.y = th.walk[under];
      const spd = Math.hypot(dx, dz) / Math.max(1, dt) * 1000; // world units / s
      u.move += (clamp(spd / 0.5, 0, 1) - u.move) * (1 - Math.exp(-dt / 160));
      let want = u.heading;
      if ((u.flags & UF.COMBAT) && u.target >= 0 && c.targetPos(u.target, _tp)) {
        const hx = _tp[0] - u.x, hz = _tp[2] - u.z;
        if (hx * hx + hz * hz > 1e-4) want = yawOf(hx, hz);
      }
      u.yaw = lerpAngle(u.yaw, want, kyaw);
      if (u.cls === U.ARTILLERY) u.setup += (((u.flags & UF.SETUP) ? 1 : 0) - u.setup) * ks;
      u.legPhase += spd * dt * 0.001 * 11;
      u.shown = !c.fog || c.fog[u.tile] === 2;
      if (!u.shown) continue;
      const fo = fIdx(u.faction);
      const fr = FACTION_LIN[fo], fg = FACTION_LIN[fo + 1], fb = FACTION_LIN[fo + 2];
      const tm = now * 0.001 + u.phase;
      switch (u.cls) {
        case U.SCOUT: {
          const bob = Math.sin(tm * 3.1) * 0.018 * S;
          this.put('scout', counts.scout++, u.x, u.y + bob, u.z, u.yaw, Math.sin(tm * 2.3) * 0.04, S, fr, fg, fb);
          break;
        }
        case U.RIFLE: {
          const cy = Math.cos(u.yaw), sy = Math.sin(u.yaw);
          for (let s = 0; s < u.soldiers; s++) {
            const lx = FORM[s][0] * S, lz = FORM[s][1] * S;
            const wx = u.x + lx * cy + lz * sy, wz = u.z - lx * sy + lz * cy;
            const step = Math.abs(Math.sin(u.legPhase * 1.4 + s * 1.9)) * 0.02 * u.move * S;
            const sway = Math.sin(tm * 1.3 + s * 2.1) * 0.08 * (1 - u.move);
            this.put('soldier', counts.soldier++, wx, u.y + step, wz, u.yaw + sway, 0, S, fr, fg, fb);
          }
          break;
        }
        case U.WALKER: {
          const bob = Math.abs(Math.sin(u.legPhase)) * 0.025 * u.move * S + Math.sin(tm * 1.7) * 0.006 * S;
          this.put('wbody', counts.wbody++, u.x, u.y + bob, u.z, u.yaw, 0, S, fr, fg, fb);
          const cy = Math.cos(u.yaw), sy = Math.sin(u.yaw);
          for (let l = 0; l < 4; l++) {
            const leg = LEGS[l];
            const flip = leg[2];
            const lx = leg[0] * S, lz = leg[1] * S;
            const hx = u.x + lx * cy + lz * sy, hz = u.z - lx * sy + lz * cy;
            const swing = Math.sin(u.legPhase + (l === 1 || l === 2 ? Math.PI : 0)) * 0.38 * u.move;
            this.put('wleg', counts.wleg++, hx, u.y + 0.36 * S + bob, hz, u.yaw + flip, flip ? -swing : swing, S, fr, fg, fb);
          }
          break;
        }
        case U.ENGINEER: {
          const rumble = Math.sin(tm * 23) * 0.004 * u.move * S;
          this.put('eng', counts.eng++, u.x, u.y + rumble, u.z, u.yaw, 0, S, fr, fg, fb);
          if ((u.flags & UF.BUILDING) && Math.random() < dt / 140) {
            const a = Math.random() * 6.283;
            c.sparks.spawn(u.x + Math.cos(a) * 0.3 * S, u.y + 0.3 * S, u.z + Math.sin(a) * 0.3 * S, Math.cos(a) * 0.8, 1.2 + Math.random(), Math.sin(a) * 0.8, 380, 0.09, 0.03, 1, 1.6, 2.6, 3.2, P_DOT, 6, 0.5);
          }
          break;
        }
        default: {
          this.put('acar', counts.acar++, u.x, u.y, u.z, u.yaw, 0, S, fr, fg, fb);
          const cy = Math.cos(u.yaw), sy = Math.sin(u.yaw);
          const px = u.x + 0.02 * S * cy, pz = u.z - 0.02 * S * sy;
          this.put('abar', counts.abar++, px, u.y + 0.24 * S, pz, u.yaw, 0.05 + u.setup * 0.55, S, fr, fg, fb);
        }
      }
      this.markers(u, c, S, detail, fr, fg, fb);
    }
    for (let pi = 0; pi < PARTS.length; pi++) {
      const p = PARTS[pi];
      const m = this.meshes[p];
      m.count = counts[p];
      touchRange(m.instanceMatrix, counts[p]);
      touchRange(m.instanceColor!, counts[p]);
    }
  }

  private put(p: Part, i: number, x: number, y: number, z: number, yaw: number, pitch: number, k: number, r: number, g: number, b: number): void {
    const m = this.meshes[p];
    writeYP(m.instanceMatrix.array as Float32Array, i, x, y, z, yaw, pitch, k);
    const ca = m.instanceColor!.array as Float32Array;
    ca[i * 3] = r; ca[i * 3 + 1] = g; ca[i * 3 + 2] = b;
  }

  private markers(u: UnitVis, c: UnitFrameCtx, S: number, detail: boolean, fr: number, fg: number, fb: number): void {
    const now = c.now;
    const sel = u.id === c.selectedUnit ? 2 : u.owner === c.selectedOwner && u.owner >= 0 ? 1 : 0;
    const gy = u.y + 0.035;
    if (sel === 2) {
      const p = 1 + Math.sin(now / 260) * 0.05;
      c.rings.push(u.x, gy, u.z, 0.5 * S * p, 0.075 * S, RING, 2.2, 2.2, 2.2, 0.95);
      c.rings.push(u.x, gy, u.z, 0.62 * S * p, 0.03 * S, RING, fr * 1.6, fg * 1.6, fb * 1.6, 0.6);
    } else if (sel === 1) {
      c.rings.push(u.x, gy, u.z, 0.42 * S, 0.05 * S, RING, fr * 1.5, fg * 1.5, fb * 1.5, 0.75);
    }
    if (u.flags & UF.EVAC) c.rings.push(u.x, gy, u.z, 0.56 * S, 0.035 * S, RING, 1.2, 1.2, 1.2, 0.45 + 0.2 * Math.sin(now / 200));
    const top = u.cls === U.WALKER ? 0.72 : u.cls === U.SCOUT ? 0.36 : 0.42;
    const hy = u.y + top * S;
    const ddx = u.x - c.camX, ddy = hy - c.camY, ddz = u.z - c.camZ;
    const near = ddx * ddx + ddy * ddy + ddz * ddz < 120 * 120 || c.camDist > 150;
    if (u.flags & UF.RETREAT) c.hud.push(u.x, hy, u.z, -13, 5, 3.5, 4, SH_CHEVRON, 1, 1, 1, 0.8);
    if (u.flags & UF.VETERAN) c.hud.push(u.x, hy, u.z, 0, 15, 5, 5, SH_STAR, 1, 0.82, 0.4, 0.95);
    const showHp = sel === 2 || ((u.hp < 0.995 || detail || sel === 1) && near && (detail || u.hp < 0.995 || sel > 0));
    if (showHp) {
      const h = u.hp;
      const r = h > 0.6 ? 0.494 : h > 0.3 ? 1 : 1, g = h > 0.6 ? 0.886 : h > 0.3 ? 0.82 : 0.365, b = h > 0.6 ? 0.659 : h > 0.3 ? 0.4 : 0.365;
      c.hud.bar(u.x, hy, u.z, 6, 16, h, r, g, b, 0.95);
    }
    if (u.supply < 0.3 && near) c.hud.push(u.x, hy, u.z, 12, 6, 2, 2, SH_RECT, 1, 0.71, 0.28, 0.5 + 0.5 * Math.sin(now / 160));
  }

  dispose(): void {
    for (const p of PARTS) { this.meshes[p].dispose(); this.geos[p].dispose(); }
    this.material.dispose();
  }
}
