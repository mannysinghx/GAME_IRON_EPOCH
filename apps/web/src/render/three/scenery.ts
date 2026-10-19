// Endless, non-simulated land outside the theatre. Chunks of CHUNK x CHUNK tiles are sampled from the same
// pure terrain functions the map generator uses (sampleBaseTerrain + isRiver), so the theatre edge has no
// seam. To keep draw calls flat, every chunk lives in a fixed slot of a few large instanced meshes (one per
// terrain/decor kind); loading a chunk rewrites only its slot range. Up to MAX_SLOTS chunks stay resident;
// chunks no longer wanted are evicted least-recently-wanted first. A stale slot is still correct terrain,
// so eviction never needs to clear it. Where the loaded land ends, EDGE_FADE melts it (and the bare ground
// disc beyond) into the fog colour, so the end of the world never shows even at low pitch.

import * as THREE from 'three';
import { CHUNK, T } from '../../shared/config.ts';
import { hash2, isRiver, riverParams, sampleBaseTerrain, type RiverParams } from '../../shared/terrain.ts';
import { SQRT3, WATER_TOP, baseSrgb, clamp, smooth01, tileWX, tileWZ, toLinear } from './common.ts';
import { buildParts, hexPrismGeometry, trs } from './geometry.ts';
import { EDGE_FADE, emberMaterial, terrainMaterial, waterMaterial } from './materials.ts';

export const MAX_SLOTS = 160;
const PER_FRAME = 2;
// Per-chunk instance caps, from the measured per-chunk demand over 3840 chunks and 4 seeds: decor near the
// 95th percentile (tree p95 243 / max 394, rock 83 / 188, ruin 40 / 109, reed 72 / 272, grass 54 / 74),
// water above its maximum (27). A chunk that wants more decor is thinned uniformly by selection sampling
// rather than truncated, so no rows of a chunk ever go bare.
const CAP = { land: CHUNK * CHUNK, water: 40, tree: 240, rock: 96, ruin: 64, ember: 16, reed: 96, grass: 64 } as const;
type Kind = keyof typeof CAP;
const KINDS: Kind[] = ['land', 'water', 'tree', 'rock', 'ruin', 'ember', 'reed', 'grass'];

/** Decor kinds that are thinned, indexed by DK; each terrain has at most one. */
const DK_TREE = 0, DK_ROCK = 1, DK_RUIN = 2, DK_REED = 3, DK_GRASS = 4;
const DK_KIND: Kind[] = ['tree', 'rock', 'ruin', 'reed', 'grass'];
const DK_SALT = [0x7101, 0x7202, 0x7303, 0x7404, 0x7505];

const DIM = 0.66, DESAT = 0.34;
const CW = CHUNK * SQRT3, CHH = CHUNK * 1.5; // chunk extent in world units (x, z)
/** How far ahead of the near screen edge the stream centre may sit when the view is too big to cover. */
const NEAR_REACH = 90;

function sceneryTree(): THREE.BufferGeometry {
  return buildParts([
    { geo: new THREE.ConeGeometry(0.18, 0.34, 5, 1, true), color: 0x1f3d2c, m: trs(0, 0.2, 0) },
    { geo: new THREE.ConeGeometry(0.12, 0.26, 5, 1, true), color: 0x2a5039, m: trs(0, 0.4, 0, 0, 0.6, 0) },
  ]);
}
// every slot draws its full cap whether filled or not, so far-field decor stays as cheap as possible: an
// 8-face boulder instead of the theatre's 20-face rock, an octahedral ember
function sceneryRock(): THREE.BufferGeometry {
  return buildParts([{ geo: new THREE.OctahedronGeometry(0.17, 0), color: 0x4a4f58, m: trs(0, 0.035, 0, 0.35, 0.4, 0.15, 1.1, 0.5, 0.85) }]);
}
function sceneryRuin(): THREE.BufferGeometry {
  return buildParts([{ geo: new THREE.BoxGeometry(1, 1, 1), color: 0x4a443e, m: trs(0, 0.5, 0) }]);
}
function sceneryTuft(color: number, h: number): THREE.BufferGeometry {
  return buildParts([
    { geo: new THREE.ConeGeometry(0.012, h, 3, 1, true), color, m: trs(0.02, h / 2, 0, 0, 0, 0.2) },
    { geo: new THREE.ConeGeometry(0.012, h * 0.8, 3, 1, true), color, m: trs(-0.03, h * 0.4, 0.02, 0.2, 1, 0) },
    { geo: new THREE.ConeGeometry(0.012, h * 0.9, 3, 1, true), color, m: trs(0, h * 0.45, -0.03, -0.2, 2, 0) },
  ]);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _rgb = new Float32Array(3);

// per-chunk scratch for the two build passes (count candidates, then place): samples are cached so the
// expensive fbm terrain sampling runs once per tile
const N = CHUNK * CHUNK;
const sTerr = new Int8Array(N); // -1 = inside the theatre (drawn there), else terrain (RIVER for river tiles)
const sElev = new Uint8Array(N);
const sVar = new Uint8Array(N);
const sDk = new Int8Array(N); // decor kind of the tile or -1
const sCnt = new Uint8Array(N); // decor candidates on the tile
const want = new Int32Array(5), seenK = new Int32Array(5), took = new Int32Array(5);

export class SceneryField {
  readonly group = new THREE.Group();
  private meshes = {} as Record<Kind, THREE.InstancedMesh>;
  private fill = {} as Record<Kind, number>;
  private seed = 0; private w = 0; private h = 0;
  private rp: RiverParams | null = null;
  private slotKey = new Float64Array(MAX_SLOTS).fill(NaN);
  private slotUse = new Float64Array(MAX_SLOTS);
  private keyToSlot = new Map<number, number>();
  private maxSlot = -1;
  private desired: number[] = [];
  private desiredSet = new Set<number>();
  private lastCx = 1e9; private lastCy = 1e9; private lastR = -1;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private loadedOnce = false;
  /** Chunks around the wanted set that are not loaded (cx, cy pairs): the edge of the streamed land. */
  private edge = new Int32Array(0);
  private nEdge = 0;
  /** World distance from the stream centre to the nearest unloaded chunk (EDGE_FADE radius). */
  extent = 1e8;

  constructor() {
    const land = terrainMaterial({ roughness: 0.95, fogBoost: 1.22, fogBias: 0.02, edgeFade: true });
    const water = waterMaterial({ fogBoost: 1.22, fogBias: 0.02, shimmer: 0.7, edgeFade: true });
    const decor = terrainMaterial({ roughness: 0.9, fogBoost: 1.22, fogBias: 0.02, edgeFade: true });
    const ember = emberMaterial(new THREE.Color(1.0, 0.45, 0.12).multiplyScalar(3.2), true);
    this.mats.push(land, water, decor, ember);
    const hex = hexPrismGeometry(0, 2.4);
    const geo: Record<Kind, THREE.BufferGeometry> = {
      land: hex, water: hex, tree: sceneryTree(), rock: sceneryRock(), ruin: sceneryRuin(), ember: new THREE.OctahedronGeometry(0.035, 0),
      reed: sceneryTuft(0x3f5b4f, 0.2), grass: sceneryTuft(0x56604f, 0.09),
    };
    for (const k of KINDS) {
      if (k !== 'water') this.geos.push(geo[k]);
      const mat = k === 'land' ? land : k === 'water' ? water : k === 'ember' ? ember : decor;
      const mesh = new THREE.InstancedMesh(geo[k], mat, CAP[k] * MAX_SLOTS);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      (mesh.instanceMatrix.array as Float32Array).fill(0);
      if (k !== 'ember') {
        const c = new THREE.InstancedBufferAttribute(new Float32Array(CAP[k] * MAX_SLOTS * 3), 3);
        c.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = c;
      }
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = k === 'land' || k === 'water';
      mesh.castShadow = false;
      this.meshes[k] = mesh;
      this.group.add(mesh);
    }
  }

  /** New world: forget every chunk (the seed changed). */
  reset(seed: number, w: number, h: number): void {
    this.seed = seed; this.w = w; this.h = h;
    this.rp = riverParams(seed, w, h);
    this.slotKey.fill(NaN);
    this.slotUse.fill(0);
    this.keyToSlot.clear();
    this.maxSlot = -1;
    this.lastR = -1;
    this.loadedOnce = false;
    this.nEdge = 0;
    for (const k of KINDS) this.meshes[k].count = 0;
  }

  get loaded(): number { return this.keyToSlot.size; }

  /**
   * Streams chunks around a centre P placed on the view footprint. `corners` are the ground points under the
   * four screen corners (TL, TR, BR, BL as x, z pairs; rays above the horizon clamped far away). When the
   * footprint fits, P is its middle; when it does not (low pitch, strategic zoom) an oblique view keeps the
   * near part covered, since it fills most of the screen, and lets the far part fade; a top-down view stays
   * centred. The radius (3..9 chunks) reaches the farthest corner; the slot cap bounds the real extent. At
   * most PER_FRAME chunks are built per call (a few ms total). Also places the edge fade.
   */
  update(corners: Float32Array, polar: number, now: number): void {
    if (!this.rp) return;
    const bx = (corners[4] + corners[6]) / 2, bz = (corners[5] + corners[7]) / 2; // near (bottom) edge middle
    const fx = (corners[0] + corners[2]) / 2, fz = (corners[1] + corners[3]) / 2; // far (top) edge middle
    const len = Math.hypot(fx - bx, fz - bz);
    const half = len / 2, near = Math.min(half, NEAR_REACH);
    const off = half + (near - half) * smooth01((polar - 0.35) / 0.6);
    const px = len > 1e-3 ? bx + ((fx - bx) / len) * off : bx, pz = len > 1e-3 ? bz + ((fz - bz) / len) * off : bz;
    let reach = 0;
    for (let k = 0; k < 4; k++) reach = Math.max(reach, Math.hypot(corners[k * 2] - px, corners[k * 2 + 1] - pz));
    const R = Math.round(clamp(reach / CHH + 1.5, 3, 9));
    const ccx = Math.floor(px / CW), ccy = Math.floor(pz / CHH);
    if (ccx !== this.lastCx || ccy !== this.lastCy || R !== this.lastR) {
      this.lastCx = ccx; this.lastCy = ccy; this.lastR = R;
      this.recomputeDesired(px, pz, ccx, ccy, R, now);
    }
    let built = 0;
    const budget = this.loadedOnce ? PER_FRAME : 12; // first fill is faster so the edge is never bare
    for (let i = 0; i < this.desired.length && built < budget; i++) {
      const key = this.desired[i];
      if (this.keyToSlot.has(key)) continue;
      const slot = this.pickSlot();
      if (slot < 0) break;
      this.build(key, slot, now);
      built++;
    }
    if (built === 0) this.loadedOnce = true;
    this.placeFade(px, pz);
  }

  /** Fade from a little inside the nearest unloaded chunk to just before it (world xz distance from P). */
  private placeFade(px: number, pz: number): void {
    let best = 1e8;
    const E = this.edge;
    for (let i = 0; i < this.nEdge; i++) {
      const x0 = E[i * 2] * CW, z0 = E[i * 2 + 1] * CHH;
      const dx = Math.max(x0 - px, 0, px - (x0 + CW)), dz = Math.max(z0 - pz, 0, pz - (z0 + CHH));
      const d = dx * dx + dz * dz;
      if (d < best * best) best = Math.sqrt(d);
    }
    // tiles overhang their chunk rectangle by up to a hex radius; keep the fully fogged band inside that
    const e = Math.max(8, best - 1.5);
    this.extent = e;
    EDGE_FADE.uFadeC.value.set(px, pz);
    EDGE_FADE.uFadeR.value.set(Math.max(e * 0.7, e - 40), e - 2);
  }

  /** Wanted chunks: centres within (R + 0.75) * CHH world units of P (a world-space disc, matching the fade). */
  private recomputeDesired(px: number, pz: number, ccx: number, ccy: number, R: number, now: number): void {
    const cand: { key: number; d: number }[] = [];
    const tcw = Math.ceil(this.w / CHUNK), tch = Math.ceil(this.h / CHUNK);
    const fullW = this.w % CHUNK === 0, fullH = this.h % CHUNK === 0;
    // chunks wholly inside the simulated theatre are drawn by the theatre terrain
    const inTheatre = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < tcw && cy < tch && (fullW || cx < tcw - 1) && (fullH || cy < tch - 1);
    const rw = (R + 0.75) * CHH, rw2 = rw * rw;
    const RX = Math.ceil(rw / CW) + 1, RY = Math.ceil(rw / CHH) + 1;
    for (let dy = -RY; dy <= RY; dy++) {
      for (let dx = -RX; dx <= RX; dx++) {
        const cx = ccx + dx, cy = ccy + dy;
        const ex = (cx + 0.5) * CW - px, ez = (cy + 0.5) * CHH - pz;
        const d = ex * ex + ez * ez;
        if (d > rw2 || inTheatre(cx, cy)) continue;
        cand.push({ key: (cx + 32768) * 65536 + (cy + 32768), d });
      }
    }
    cand.sort((a, b) => a.d - b.d);
    if (cand.length > MAX_SLOTS) cand.length = MAX_SLOTS;
    this.desired = cand.map((c) => c.key);
    this.desiredSet = new Set(this.desired);
    for (const key of this.desired) {
      const s = this.keyToSlot.get(key);
      if (s !== undefined) this.slotUse[s] = now;
    }
    // the edge: every chunk in a margin box that is neither wanted nor theatre
    const BX = RX + 2, BY = RY + 2;
    if (this.edge.length < (2 * BX + 1) * (2 * BY + 1) * 2) this.edge = new Int32Array((2 * BX + 1) * (2 * BY + 1) * 2);
    let n = 0;
    for (let dy = -BY; dy <= BY; dy++) {
      for (let dx = -BX; dx <= BX; dx++) {
        const cx = ccx + dx, cy = ccy + dy;
        if (inTheatre(cx, cy) || this.desiredSet.has((cx + 32768) * 65536 + (cy + 32768))) continue;
        this.edge[n * 2] = cx; this.edge[n * 2 + 1] = cy; n++;
      }
    }
    this.nEdge = n;
  }

  private pickSlot(): number {
    let lru = -1, lruT = Infinity;
    for (let s = 0; s < MAX_SLOTS; s++) {
      const k = this.slotKey[s];
      if (Number.isNaN(k)) return s;
      if (this.desiredSet.has(k)) continue;
      if (this.slotUse[s] < lruT) { lruT = this.slotUse[s]; lru = s; }
    }
    return lru;
  }

  private put(kind: Kind, slot: number, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, r: number, g: number, b: number): boolean {
    const n = this.fill[kind];
    if (n >= CAP[kind]) return false;
    const i = slot * CAP[kind] + n;
    this.fill[kind] = n + 1;
    const mesh = this.meshes[kind];
    if (yaw === 0 && sx === 1 && sy === 1 && sz === 1) _m.makeTranslation(x, y, z);
    else { _q.setFromAxisAngle(_up, yaw); _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz)); }
    mesh.setMatrixAt(i, _m);
    const col = mesh.instanceColor;
    if (col) { const a = col.array as Float32Array; a[i * 3] = r; a[i * 3 + 1] = g; a[i * 3 + 2] = b; }
    return true;
  }

  /**
   * Selection sampling (Knuth's Algorithm S): when a chunk wants more instances of a decor kind than its cap,
   * keep exactly `cap` of them, each candidate with equal chance and deterministically per tile.
   */
  private accept(dk: number, c: number, r: number, sub: number): boolean {
    const n = want[dk], cap = CAP[DK_KIND[dk]];
    const i = seenK[dk]++;
    if (n <= cap) return true;
    const u = hash2((this.seed ^ DK_SALT[dk]) >>> 0, c * 2 + sub, r);
    if (u * (n - i) < cap - took[dk]) { took[dk]++; return true; }
    return false;
  }

  private build(key: number, slot: number, now: number): void {
    const old = this.slotKey[slot];
    if (!Number.isNaN(old)) this.keyToSlot.delete(old);
    this.slotKey[slot] = key;
    this.slotUse[slot] = now;
    this.keyToSlot.set(key, slot);
    if (slot > this.maxSlot) this.maxSlot = slot;
    for (const k of KINDS) this.fill[k] = 0;
    const cx = Math.floor(key / 65536) - 32768, cy = (key % 65536) - 32768;
    const c0 = cx * CHUNK, r0 = cy * CHUNK;
    const seed = this.seed >>> 0, rp = this.rp!;
    want.fill(0); seenK.fill(0); took.fill(0);
    // pass 1: sample every tile once and count decor candidates per kind
    for (let j = 0; j < N; j++) {
      const c = c0 + (j % CHUNK), r = r0 + ((j / CHUNK) | 0);
      sDk[j] = -1; sCnt[j] = 0;
      if (c >= 0 && r >= 0 && c < this.w && r < this.h) { sTerr[j] = -1; continue; }
      const s = sampleBaseTerrain(seed, c, r);
      const river = isRiver(rp, c, r);
      const tt = river ? T.RIVER : s.terrain;
      sTerr[j] = tt; sElev[j] = river ? 0 : s.elev; sVar[j] = s.variant;
      if (river) continue;
      const h0 = hash2(seed ^ 0x3c3c, c, r), h1 = hash2(seed ^ 0x4d4d, c, r);
      let dk = -1, cnt = 0;
      switch (tt) {
        case T.FOREST: dk = DK_TREE; cnt = h0 > 0.35 ? 2 : 1; break;
        case T.RIDGE: dk = DK_ROCK; cnt = h0 > 0.3 ? 1 : 0; break;
        case T.RUIN: dk = DK_RUIN; cnt = 1; break;
        case T.MARSH: dk = DK_REED; cnt = h1 > 0.5 ? 2 : 1; break;
        case T.PLAINS: dk = DK_GRASS; cnt = h1 < 0.22 ? 1 : 0; break;
      }
      if (dk >= 0 && cnt > 0) { sDk[j] = dk; sCnt[j] = cnt; want[dk] += cnt; }
    }
    // pass 2: tiles, then the accepted decor
    for (let j = 0; j < N; j++) {
      const tt = sTerr[j];
      if (tt < 0) continue;
      const c = c0 + (j % CHUNK), r = r0 + ((j / CHUNK) | 0);
      const elev = sElev[j];
      baseSrgb(tt, elev, sVar[j], _rgb, 0);
      const lum = _rgb[0] * 0.3 + _rgb[1] * 0.59 + _rgb[2] * 0.11;
      const lr = toLinear((_rgb[0] + (lum - _rgb[0]) * DESAT) * DIM), lg = toLinear((_rgb[1] + (lum - _rgb[1]) * DESAT) * DIM), lb = toLinear((_rgb[2] + (lum - _rgb[2]) * DESAT) * DIM);
      const x = tileWX(c, r), z = tileWZ(r);
      const top = 0.3 + elev * 0.45;
      // a full water budget (never seen: max 27 of 40) falls back to a land prism so there is no hole
      if (tt === T.RIVER && this.put('water', slot, x, WATER_TOP, z, 0, 1, 1, 1, lr, lg, lb)) continue;
      this.put('land', slot, x, top, z, 0, 1, 1, 1, lr, lg, lb);
      const dk = sDk[j];
      if (dk < 0) continue;
      // sparse decor, deterministic per tile; tone is darker than the theatre's
      const h0 = hash2(seed ^ 0x3c3c, c, r), h1 = hash2(seed ^ 0x4d4d, c, r), h2 = hash2(seed ^ 0x5e5e, c, r);
      const ox = (h1 - 0.5) * 1.1, oz = (h2 - 0.5) * 1.0, yaw = h0 * 6.283;
      const k = 0.6 + h0 * 0.15;
      switch (dk) {
        case DK_TREE: {
          if (this.accept(dk, c, r, 0)) { const s1 = 0.85 + h1 * 0.4; this.put('tree', slot, x + ox, top - 0.01, z + oz, yaw, s1, s1, s1, k, k, k); }
          if (sCnt[j] > 1 && this.accept(dk, c, r, 1)) { const s2 = 0.8 + h2 * 0.35; this.put('tree', slot, x - ox * 0.8 + 0.25, top - 0.01, z - oz * 0.9 - 0.2, yaw * 1.7, s2, s2, s2, k, k, k); }
          break;
        }
        case DK_ROCK: { if (this.accept(dk, c, r, 0)) { const s1 = 0.8 + h1; this.put('rock', slot, x + ox, top, z + oz, yaw, s1, s1, s1, k, k, k); } break; }
        case DK_RUIN: {
          if (!this.accept(dk, c, r, 0)) break;
          this.put('ruin', slot, x + ox, top, z + oz, yaw, 0.2 + h1 * 0.25, 0.1 + h2 * 0.3, 0.16 + h0 * 0.2, k, k, k);
          if (h2 > 0.86) this.put('ember', slot, x + ox, top + 0.25 + h1 * 0.1, z + oz, 0, 1, 1, 1, 1, 1, 1);
          break;
        }
        case DK_REED: {
          if (this.accept(dk, c, r, 0)) this.put('reed', slot, x + ox, top, z + oz, yaw, 1, 1, 1, k, k, k);
          if (sCnt[j] > 1 && this.accept(dk, c, r, 1)) this.put('reed', slot, x - ox, top, z - oz, yaw + 2, 0.9, 0.9, 0.9, k, k, k);
          break;
        }
        case DK_GRASS: { if (this.accept(dk, c, r, 0)) this.put('grass', slot, x + ox, top, z + oz, yaw, 1, 1, 1, k, k, k); break; }
      }
    }
    for (const kind of KINDS) {
      const mesh = this.meshes[kind];
      const cap = CAP[kind];
      const base = slot * cap;
      const arr = mesh.instanceMatrix.array as Float32Array;
      arr.fill(0, (base + this.fill[kind]) * 16, (base + cap) * 16); // unused instances collapse to nothing
      mesh.instanceMatrix.addUpdateRange(base * 16, cap * 16);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) { mesh.instanceColor.addUpdateRange(base * 3, cap * 3); mesh.instanceColor.needsUpdate = true; }
      mesh.count = (this.maxSlot + 1) * cap;
    }
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const k of KINDS) this.meshes[k].dispose();
  }
}
