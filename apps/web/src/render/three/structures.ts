// Structures: one instanced mesh per model (plus animated parts: core crystal and ring, tower beacon,
// objective marker) with per-instance faction colour, so ~25 draw calls cover every structure on the map.
// Under construction draws the same model as a translucent cyan hologram that grows with progress, with a
// progress bar; damaged destructibles get a health bar; broken bridges swap to two stubs. In fog view a
// per-instance dim (iDim) matches the tile darkening (remembered 0.5, unseen 0.2, as the 2D fog overlay did)
// and bars only show on visible tiles.

import * as THREE from 'three';
import { S, STRUCTS } from '../../shared/config.ts';
import { SF, STRUCT_STRIDE } from '../../shared/protocol.ts';
import { FACTION_LIN, deckPose, fIdx, type Theatre } from './common.ts';
import { DISC, RING, touchRange, type RingBatch, type SpriteBatch } from './batches.ts';
import { MaterialCache, partMaterial } from './materials.ts';
import {
  bridgeBrokenGeometry, bridgeGeometry, bunkerGeometry, citadelGeometry, coreBaseGeometry, coreCrystalGeometry, coreRingGeometry,
  depotGeometry, hubGeometry, lampGeometry, mineGeometry, objectiveGeometry, refineryGeometry, relayGeometry, towerGeometry,
} from './models.ts';

export interface StructVis {
  id: number; kind: number; tile: number; faction: number; owner: number; hp: number; build: number; flags: number;
  x: number; y: number; z: number; yaw: number; phase: number; seen: number; idx: number;
}

type Model = 'core' | 'crystal' | 'ring' | 'depot' | 'tower' | 'lamp' | 'bunker' | 'bridge' | 'bridgeX' | 'relay' | 'mine' | 'refinery'
  | 'hub' | 'citadel' | 'objective' | 'hDepot' | 'hTower' | 'hBunker' | 'hBridge';
const MODELS: Model[] = ['core', 'crystal', 'ring', 'depot', 'tower', 'lamp', 'bunker', 'bridge', 'bridgeX', 'relay', 'mine', 'refinery', 'hub', 'citadel', 'objective', 'hDepot', 'hTower', 'hBunker', 'hBridge'];
const HOLO: Partial<Record<number, Model>> = { [S.DEPOT]: 'hDepot', [S.TOWER]: 'hTower', [S.BUNKER]: 'hBunker', [S.BRIDGE]: 'hBridge' };
const BODY: Record<number, Model> = {
  [S.CORE]: 'core', [S.DEPOT]: 'depot', [S.TOWER]: 'tower', [S.BUNKER]: 'bunker', [S.BRIDGE]: 'bridge', [S.RELAY]: 'relay',
  [S.MINE]: 'mine', [S.REFINERY]: 'refinery', [S.HUB]: 'hub', [S.CITADEL]: 'citadel',
};
/** Height of the HUD bar / fx anchor above the tile top, per structure kind. */
export const STRUCT_H = [2.05, 0.62, 1.6, 0.62, 0.35, 1.3, 1.1, 0.9, 0.85, 1.65];
const HOLO_RGB = [0.22, 0.8, 1.0];

function writeY(arr: Float32Array, i: number, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number): void {
  const c = Math.cos(yaw), s = Math.sin(yaw), o = i * 16;
  arr[o] = c * sx; arr[o + 1] = 0; arr[o + 2] = -s * sx; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = s * sz; arr[o + 9] = 0; arr[o + 10] = c * sz; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}

/** fog: the fog view (0 unseen, 1 remembered, 2 visible) or null when fog view is off. */
export interface StructFrameCtx { now: number; rings: RingBatch; hud: SpriteBatch; camX: number; camY: number; camZ: number; fog: Uint8Array | null }

/** Brightness of a structure on a tile with fog value v; matches TheatreTerrain.compose. */
function fogDim(v: number): number { return v === 2 ? 1 : v === 1 ? 0.5 : 0.2; }

function dimAttr(cap: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

export class StructureLayer {
  readonly group = new THREE.Group();
  readonly structs = new Map<number, StructVis>();
  readonly list: StructVis[] = [];
  private meshes = {} as Record<Model, THREE.InstancedMesh>;
  private geos = {} as Record<Model, THREE.BufferGeometry>;
  private counts = {} as Record<Model, number>;
  private mats = new MaterialCache();
  private th: Theatre | null = null;
  private frameNo = 0;

  constructor() {
    const solid = this.mats.get('solid', () => partMaterial({ glow: 1.5, roughness: 0.62, metalness: 0.3, dim: true }));
    const holo = this.mats.get('holo', () => partMaterial({ glow: 1.1, transparent: true, opacity: 0.4, roughness: 0.3, metalness: 0.1, emissive: 0x0b3442, holo: true, dim: true }));
    const bridgeG = bridgeGeometry(), bunkerG = bunkerGeometry(), depotG = depotGeometry(), towerG = towerGeometry();
    // hologram meshes get their own geometry copies: iDim is a per-mesh instanced attribute on the geometry
    this.geos = {
      core: coreBaseGeometry(), crystal: coreCrystalGeometry(), ring: coreRingGeometry(), depot: depotG, tower: towerG, lamp: lampGeometry(),
      bunker: bunkerG, bridge: bridgeG, bridgeX: bridgeBrokenGeometry(), relay: relayGeometry(), mine: mineGeometry(), refinery: refineryGeometry(),
      hub: hubGeometry(), citadel: citadelGeometry(), objective: objectiveGeometry(),
      hDepot: depotG.clone(), hTower: towerG.clone(), hBunker: bunkerG.clone(), hBridge: bridgeG.clone(),
    };
    for (const k of MODELS) {
      const isHolo = k.startsWith('h') && k !== 'hub';
      this.geos[k].setAttribute('iDim', dimAttr(64));
      const m = new THREE.InstancedMesh(this.geos[k], isHolo ? holo : solid, 64);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const c = new THREE.InstancedBufferAttribute(new Float32Array(64 * 3).fill(1), 3);
      c.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = c;
      m.count = 0;
      m.castShadow = !isHolo && k !== 'objective';
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.renderOrder = isHolo ? 2 : 0;
      this.meshes[k] = m;
      this.counts[k] = 0;
      this.group.add(m);
    }
  }

  setTheatre(th: Theatre): void { this.th = th; this.structs.clear(); this.list.length = 0; }

  private ensure(k: Model, need: number): void {
    const m = this.meshes[k];
    if (need <= m.instanceMatrix.count) return;
    let cap = m.instanceMatrix.count;
    while (cap < need) cap *= 2;
    const n = new THREE.InstancedMesh(m.geometry, m.material, cap);
    n.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const c = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    c.setUsage(THREE.DynamicDrawUsage);
    n.instanceColor = c;
    n.castShadow = m.castShadow; n.receiveShadow = m.receiveShadow; n.frustumCulled = false; n.renderOrder = m.renderOrder;
    m.geometry.setAttribute('iDim', dimAttr(cap));
    this.group.remove(m);
    m.dispose();
    this.group.add(n);
    this.meshes[k] = n;
  }

  /** Axis and deck height of a bridge; shared with Theatre.walk so units cross on the deck. */
  private bridgePose(tile: number, out: Float32Array): void {
    const th = this.th!;
    deckPose(th.grid, th.map.terrain, th.top, th.x, th.z, tile, out);
  }

  apply(a: Float32Array): void {
    const th = this.th;
    if (!th) return;
    const seen = ++this.frameNo;
    const n = (a.length / STRUCT_STRIDE) | 0;
    for (let i = 0; i < n; i++) {
      const o = i * STRUCT_STRIDE;
      const id = a[o], kind = a[o + 1], tile = a[o + 2];
      if (tile < 0 || tile >= th.n || kind < 0 || kind >= STRUCTS.length) continue;
      let s = this.structs.get(id);
      if (!s) {
        const pose = _pose;
        let yaw = ((tile * 7 + id) % 6) * (Math.PI / 3), y = th.top[tile];
        if (kind === S.BRIDGE) { this.bridgePose(tile, pose); yaw = pose[0]; y = pose[1]; }
        else if (kind === S.CORE || kind === S.CITADEL || kind === S.TOWER) yaw = 0;
        s = { id, kind, tile, faction: -1, owner: -1, hp: 1, build: 1, flags: 0, x: th.x[tile], y, z: th.z[tile], yaw, phase: (id * 0.37) % 6.28, seen, idx: this.list.length };
        this.structs.set(id, s);
        this.list.push(s);
      }
      s.faction = a[o + 3]; s.owner = a[o + 4]; s.hp = a[o + 5]; s.build = a[o + 6]; s.flags = a[o + 7]; s.seen = seen;
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i];
      if (s.seen === seen) continue;
      this.structs.delete(s.id);
      const last = this.list.pop()!;
      if (last !== s) { this.list[i] = last; last.idx = i; }
    }
  }

  /** Fx anchor (turret muzzle / impact point) of a structure. */
  pos(id: number, out: Float32Array): boolean {
    const s = this.structs.get(id);
    if (!s) return false;
    out[0] = s.x; out[1] = s.y + Math.min(1.0, STRUCT_H[s.kind] * 0.55); out[2] = s.z;
    return true;
  }

  private put(k: Model, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, r: number, g: number, b: number, dim: number): void {
    const i = this.counts[k]++;
    const m = this.meshes[k];
    writeY(m.instanceMatrix.array as Float32Array, i, x, y, z, yaw, sx, sy, sz);
    const ca = m.instanceColor!.array as Float32Array;
    ca[i * 3] = r; ca[i * 3 + 1] = g; ca[i * 3 + 2] = b;
    (m.geometry.getAttribute('iDim').array as Float32Array)[i] = dim;
  }

  update(c: StructFrameCtx): void {
    const now = c.now, t = now * 0.001;
    const fog = c.fog && this.th && c.fog.length === this.th.n ? c.fog : null;
    for (let k = 0; k < MODELS.length; k++) this.counts[MODELS[k]] = 0;
    // worst case every structure of one model: size buffers before writing
    const need = this.list.length;
    for (let k = 0; k < MODELS.length; k++) this.ensure(MODELS[k], need);
    for (let i = 0; i < this.list.length; i++) {
      const s = this.list[i];
      const fo = fIdx(s.faction);
      const fr = FACTION_LIN[fo], fg = FACTION_LIN[fo + 1], fb = FACTION_LIN[fo + 2];
      const fv = fog ? fog[s.tile] : 2;
      const dim = fogDim(fv);
      const constructing = (s.flags & SF.CONSTRUCTING) !== 0;
      const holo = constructing ? HOLO[s.kind] : undefined;
      if (holo) {
        const g = 0.25 + 0.75 * Math.max(0, Math.min(1, s.build));
        const flick = 0.85 + 0.15 * Math.sin(t * 9 + s.phase);
        this.put(holo, s.x, s.y, s.z, s.yaw, 1, g, 1, HOLO_RGB[0] * flick, HOLO_RGB[1] * flick, HOLO_RGB[2] * flick, dim);
      } else {
        const body = s.kind === S.BRIDGE && (s.flags & SF.BROKEN) ? 'bridgeX' : BODY[s.kind];
        if (body) this.put(body, s.x, s.y, s.z, s.yaw, 1, 1, 1, fr, fg, fb, dim);
        if (s.kind === S.CORE && s.hp > 0) {
          const bob = Math.sin(t * 2.1 + s.phase) * 0.06;
          const pulse = 1 + Math.sin(t * 3.3 + s.phase) * 0.06;
          this.put('crystal', s.x, s.y + 1.62 + bob, s.z, t * 0.9 + s.phase, pulse, pulse, pulse, fr, fg, fb, dim);
          this.put('ring', s.x, s.y + 0.64, s.z, t / 1.6 + s.phase, 1, 1, 1, fr, fg, fb, dim);
        } else if (s.kind === S.TOWER) {
          const blink = 0.3 + 0.7 * Math.pow(Math.max(0, Math.sin(t * 1.9 + s.phase)), 6);
          this.put('lamp', s.x, s.y + 1.52, s.z, 0, 1, 1, 1, fr * blink, fg * blink, fb * blink, dim);
        } else if (s.kind === S.RELAY && s.faction >= 0) {
          const p = (now / 1800 + s.phase) % 1;
          c.rings.push(s.x, s.y + 1.06, s.z, 0.28 + p * 0.95, 0.045, RING, fr * 1.8, fg * 1.8, fb * 1.8, 0.65 * (1 - p) * dim);
        } else if (s.kind === S.CITADEL) {
          const p = (now / 2600) % 1;
          if (s.faction >= 0) c.rings.push(s.x, s.y + 0.06, s.z, 1.3 + p * 1.1, 0.07, RING, fr * 1.5, fg * 1.5, fb * 1.5, 0.55 * (1 - p) * dim);
          else c.rings.push(s.x, s.y + 0.06, s.z, 1.3 + p * 1.1, 0.07, RING, 0.62, 0.66, 0.74, 0.4 * (1 - p) * dim);
        }
      }
      if (s.flags & SF.OBJECTIVE) {
        const bob = Math.sin(now / 380 + s.phase) * 0.11;
        this.put('objective', s.x, s.y + STRUCT_H[s.kind] + 0.85 + bob, s.z, t * 1.4, 1, 1, 1, 1, 1, 1, dim);
        const p = (now / 1400 + s.phase) % 1;
        c.rings.push(s.x, s.y + 0.05, s.z, 0.75 + p * 0.5, 0.05, RING, 2.2, 1.5, 0.45, 0.7 * (1 - p) * dim);
        c.rings.push(s.x, s.y + 0.04, s.z, 0.95, 0.05, DISC, 1.0, 0.7, 0.2, 0.18 * dim, 0.25);
      }
      // bars report current state, which only a visible tile can show
      if (fv !== 2) continue;
      const hy = s.y + STRUCT_H[s.kind];
      const ddx = s.x - c.camX, ddy = hy - c.camY, ddz = s.z - c.camZ;
      if (ddx * ddx + ddy * ddy + ddz * ddz > 300 * 300) continue;
      if (constructing) c.hud.bar(s.x, s.y + STRUCT_H[s.kind] * 0.6, s.z, -2, 22, s.build, 0.5, 0.91, 1.0, 0.95);
      else if (STRUCTS[s.kind].destructible && s.hp < 0.999 && !(s.flags & SF.BROKEN)) {
        const h = s.hp;
        const r = h > 0.5 ? 0.494 : 1, g = h > 0.5 ? 0.886 : h > 0.25 ? 0.82 : 0.365, b = h > 0.5 ? 0.659 : h > 0.25 ? 0.4 : 0.365;
        c.hud.bar(s.x, hy, s.z, 4, 24, h, r, g, b, 0.95);
      }
    }
    for (let k = 0; k < MODELS.length; k++) {
      const m = this.meshes[MODELS[k]];
      const n = this.counts[MODELS[k]];
      m.count = n;
      touchRange(m.instanceMatrix, n);
      touchRange(m.instanceColor!, n);
      touchRange(m.geometry.getAttribute('iDim') as THREE.BufferAttribute, n);
    }
  }

  dispose(): void {
    const seen = new Set<THREE.BufferGeometry>();
    for (const k of MODELS) { const g = this.geos[k]; if (!seen.has(g)) { seen.add(g); g.dispose(); } this.meshes[k].dispose(); }
    this.mats.dispose();
  }
}

const _pose = new Float32Array(2);
