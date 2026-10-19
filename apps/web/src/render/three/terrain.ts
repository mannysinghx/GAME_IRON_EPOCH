// Theatre terrain: instanced bevelled hex prisms for land and water, instanced decor (conifers, rocks,
// ruins with embers, reeds, puddles, grass), road ribbons. Tile colours are composed in sRGB from the 2D
// charcoal palette plus territory tint, frontier lock (darkened, desaturated), reveal ramp and fog view,
// then written straight into the instance colour buffers. Decor brightness follows its tile.

import * as THREE from 'three';
import { T } from '../../shared/config.ts';
import {
  FACTION_SRGB, baseSrgb, fIdx, hash01, isWater, smooth01, toLinear, type Theatre,
} from './common.ts';
import { hexPrismGeometry } from './geometry.ts';
import { emberMaterial, terrainMaterial, waterMaterial } from './materials.ts';
import {
  emberGeometry, grassGeometry, puddleGeometry, reedGeometry, roadJointGeometry, roadQuadGeometry, rockGeometry,
  ruinGeometry, treeGeometry,
} from './models.ts';

export const REVEAL_MS = 1500;
const TINT = 0.16;
const AMBER = [1.0, 0.68, 0.3];

interface Decor { mesh: THREE.InstancedMesh; tile: Int32Array; mul: Float32Array }

export interface TileState {
  territory: Int8Array; active: Uint8Array; reveal: Float32Array; fog: Uint8Array | null; tint: boolean;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function setTRS(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number): void {
  _q.setFromAxisAngle(_up, yaw);
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  mesh.setMatrixAt(i, _m);
}

function colorAttr(mesh: THREE.InstancedMesh, count: number): Float32Array {
  const arr = new Float32Array(count * 3).fill(1);
  const a = new THREE.InstancedBufferAttribute(arr, 3);
  a.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = a;
  return arr;
}

export class TheatreTerrain {
  readonly group = new THREE.Group();
  readonly land: THREE.InstancedMesh;
  readonly water: THREE.InstancedMesh;
  private th: Theatre;
  private landIdx: Int32Array;
  private waterIdx: Int32Array;
  private base: Float32Array;
  private bright: Float32Array; // linear brightness multiplier per tile, for decor
  private landCol: Float32Array;
  private waterCol: Float32Array;
  private decor: Decor[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];

  constructor(th: Theatre) {
    this.th = th;
    const { map, n } = th;
    let nw = 0;
    for (let t = 0; t < n; t++) if (isWater(map.terrain[t])) nw++;
    const hexGeo = hexPrismGeometry(0.07, 2.2);
    const landMat = terrainMaterial({ roughness: 0.93 });
    const waterMat = waterMaterial();
    this.geos.push(hexGeo);
    this.mats.push(landMat, waterMat);
    this.land = new THREE.InstancedMesh(hexGeo, landMat, Math.max(1, n - nw));
    this.water = new THREE.InstancedMesh(hexGeo, waterMat, Math.max(1, nw));
    this.landCol = colorAttr(this.land, Math.max(1, n - nw));
    this.waterCol = colorAttr(this.water, Math.max(1, nw));
    this.landIdx = new Int32Array(n).fill(-1);
    this.waterIdx = new Int32Array(n).fill(-1);
    this.base = new Float32Array(n * 3);
    this.bright = new Float32Array(n).fill(1);
    let li = 0, wi = 0;
    for (let t = 0; t < n; t++) {
      const tt = map.terrain[t];
      baseSrgb(tt, map.elev[t], map.variant[t], this.base, t * 3);
      _m.makeTranslation(th.x[t], th.top[t], th.z[t]);
      if (isWater(tt)) { this.waterIdx[t] = wi; this.water.setMatrixAt(wi++, _m); }
      else { this.landIdx[t] = li; this.land.setMatrixAt(li++, _m); }
    }
    this.land.count = li; this.water.count = wi;
    for (const m of [this.land, this.water]) {
      m.receiveShadow = true;
      m.castShadow = false;
      m.frustumCulled = false;
      m.instanceMatrix.needsUpdate = true;
    }
    this.group.add(this.land, this.water);
    this.buildDecor();
    this.buildRoads();
  }

  private addDecor(geo: THREE.BufferGeometry, mat: THREE.Material, tiles: number[], place: (i: number, mesh: THREE.InstancedMesh) => void, mul: (i: number, out: Float32Array) => void, shadow: boolean): void {
    if (!tiles.length) { geo.dispose(); return; }
    const mesh = new THREE.InstancedMesh(geo, mat, tiles.length);
    const m = new Float32Array(tiles.length * 3);
    for (let i = 0; i < tiles.length; i++) { place(i, mesh); mul(i, m.subarray(i * 3, i * 3 + 3)); }
    colorAttr(mesh, tiles.length);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadow;
    mesh.receiveShadow = !shadow;
    mesh.frustumCulled = false;
    this.geos.push(geo);
    this.decor.push({ mesh, tile: Int32Array.from(tiles), mul: m });
    this.group.add(mesh);
  }

  private buildDecor(): void {
    const { map, n, x, z, top } = this.th;
    const decorMat = terrainMaterial({ roughness: 0.85 });
    const puddleMat = waterMaterial({ shimmer: 0.6 });
    const ember = emberMaterial(new THREE.Color(1.0, 0.45, 0.12).multiplyScalar(4.5));
    this.mats.push(decorMat, puddleMat, ember);
    // collect placements: [tile, x, z, yaw, scale, sy] per kind
    const trees: number[] = [], treeP: number[] = [];
    const rocks: number[] = [], rockP: number[] = [];
    const ruins: number[] = [], ruinP: number[] = [];
    const embers: number[] = [], emberP: number[] = [];
    const reeds: number[] = [], reedP: number[] = [];
    const grass: number[] = [], grassP: number[] = [];
    const puddles: number[] = [], puddleP: number[] = [];
    const seed = map.seed | 0;
    const jitter = (t: number, k: number, sx: number, sz: number, out: number[], extra: number[]) => {
      const rx = hash01(seed, t, k * 3 + 1) - 0.5, rz = hash01(seed, t, k * 3 + 2) - 0.5;
      out.push(t);
      extra.push(x[t] + rx * sx, z[t] + rz * sz, hash01(seed, t, k * 3 + 3) * Math.PI * 2, 0.82 + hash01(t, k, seed) * 0.42);
    };
    for (let t = 0; t < n; t++) {
      const tt = map.terrain[t], v = map.variant[t];
      switch (tt) {
        case T.FOREST: { const c = 3 + (v % 3); for (let k = 0; k < c; k++) jitter(t, k, 1.25, 1.15, trees, treeP); break; }
        case T.RIDGE: { for (let k = 0; k < 3; k++) jitter(t, k, 1.1, 1.0, rocks, rockP); break; }
        case T.RUIN: {
          for (let k = 0; k < 3; k++) {
            jitter(t, k, 1.05, 0.95, ruins, ruinP);
            if (hash01(seed, t, 40 + k) > 0.82) { embers.push(t); const j = ruinP.length - 4; emberP.push(ruinP[j], ruinP[j + 1], 0, 1); }
          }
          break;
        }
        case T.MARSH: {
          for (let k = 0; k < 4; k++) jitter(t, k, 1.2, 1.1, reeds, reedP);
          jitter(t, 9, 0.5, 0.4, puddles, puddleP);
          break;
        }
        case T.PLAINS: { if (v % 3 === 0) for (let k = 0; k < 3; k++) jitter(t, k, 1.3, 1.2, grass, grassP); break; }
      }
    }
    const varMul = (t: number, k: number, lo: number, hi: number, out: Float32Array) => {
      const f = lo + hash01(seed ^ 0x5151, t, k) * (hi - lo);
      out[0] = f; out[1] = f; out[2] = f;
    };
    this.addDecor(treeGeometry(), decorMat, trees, (i, m) => setTRS(m, i, treeP[i * 4], top[trees[i]] - 0.01, treeP[i * 4 + 1], treeP[i * 4 + 2], treeP[i * 4 + 3], treeP[i * 4 + 3] * (0.9 + hash01(i, 7, seed) * 0.35), treeP[i * 4 + 3]), (i, o) => varMul(trees[i], i, 0.8, 1.15, o), true);
    this.addDecor(rockGeometry(), decorMat, rocks, (i, m) => { const s = 0.8 + hash01(i, 3, seed) * 0.9; setTRS(m, i, rockP[i * 4], top[rocks[i]], rockP[i * 4 + 1], rockP[i * 4 + 2], s, s, s); }, (i, o) => varMul(rocks[i], i, 0.85, 1.15, o), true);
    this.addDecor(ruinGeometry(), decorMat, ruins, (i, m) => {
      const w = 0.17 + hash01(i, 1, seed) * 0.28, h = 0.1 + hash01(i, 2, seed) * 0.3, d = 0.15 + hash01(i, 4, seed) * 0.22;
      setTRS(m, i, ruinP[i * 4], top[ruins[i]], ruinP[i * 4 + 1], ruinP[i * 4 + 2], w, h, d);
    }, (i, o) => varMul(ruins[i], i, 0.8, 1.15, o), true);
    this.addDecor(emberGeometry(), ember, embers, (i, m) => setTRS(m, i, emberP[i * 4], top[embers[i]] + 0.12 + hash01(i, 5, seed) * 0.2, emberP[i * 4 + 1], 0, 1, 1, 1), (_i, o) => { o[0] = 1; o[1] = 1; o[2] = 1; }, false);
    this.addDecor(reedGeometry(), decorMat, reeds, (i, m) => setTRS(m, i, reedP[i * 4], top[reeds[i]], reedP[i * 4 + 1], reedP[i * 4 + 2], reedP[i * 4 + 3], reedP[i * 4 + 3], reedP[i * 4 + 3]), (i, o) => varMul(reeds[i], i, 0.85, 1.1, o), false);
    this.addDecor(grassGeometry(), decorMat, grass, (i, m) => setTRS(m, i, grassP[i * 4], top[grass[i]], grassP[i * 4 + 1], grassP[i * 4 + 2], grassP[i * 4 + 3], grassP[i * 4 + 3], grassP[i * 4 + 3]), (i, o) => varMul(grass[i], i, 0.8, 1.1, o), false);
    this.addDecor(puddleGeometry(), puddleMat, puddles, (i, m) => setTRS(m, i, puddleP[i * 4], top[puddles[i]] + 0.004, puddleP[i * 4 + 1], puddleP[i * 4 + 2], 0.9 + hash01(i, 6, seed) * 0.6, 1, 0.45 + hash01(i, 8, seed) * 0.25), (_i, o) => { o[0] = 1; o[1] = 1; o[2] = 1; }, false);
  }

  /** Roads connect road tile centres to road/crossing neighbours, split at the shared edge so steps hide. */
  private buildRoads(): void {
    const { map, grid, n, x, z, top } = this.th;
    const roadish = (t: number) => map.terrain[t] === T.ROAD || map.terrain[t] === T.CROSSING;
    const segT: number[] = [], segP: number[] = [];
    const joints: number[] = [];
    for (let t = 0; t < n; t++) {
      if (map.terrain[t] !== T.ROAD) continue;
      joints.push(t);
      for (let d = 0; d < 6; d++) {
        const v = grid.nb[t * 6 + d];
        if (v < 0 || !roadish(v)) continue;
        const mx = (x[t] + x[v]) / 2, mz = (z[t] + z[v]) / 2;
        // centre -> shared edge midpoint, on this tile's top; the neighbour draws its own half
        // (crossing tiles carry the bridge deck instead)
        segT.push(t);
        segP.push(x[t], z[t], mx, mz);
      }
    }
    if (!segT.length) return;
    const quad = roadQuadGeometry();
    const joint = roadJointGeometry();
    const mat = terrainMaterial({ roughness: 0.8 });
    mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -2;
    this.mats.push(mat);
    const layers: [number, number, number][] = [[0.3, 0.013, 0x1b1f25], [0.2, 0.02, 0x444a54], [0.035, 0.026, 0x6a727e]];
    const tilesQ: number[] = [], tilesJ: number[] = [];
    for (let l = 0; l < layers.length; l++) for (const t of segT) tilesQ.push(t);
    for (let l = 0; l < 2; l++) for (const t of joints) tilesJ.push(t);
    const segN = segT.length;
    const lin = new Float32Array(3);
    this.addDecor(quad, mat, tilesQ, (i, m) => {
      const l = Math.floor(i / segN), s = i % segN;
      const [w, dy] = layers[l];
      const ax = segP[s * 4], az = segP[s * 4 + 1], bx = segP[s * 4 + 2], bz = segP[s * 4 + 3];
      const len = Math.hypot(bx - ax, bz - az);
      setTRS(m, i, ax, top[segT[s]] + dy, az, Math.atan2(-(bz - az), bx - ax), len + (l < 2 ? w * 0.4 : 0), 1, w);
    }, (i, o) => {
      const l = Math.floor(i / segN);
      const c = layers[l][2];
      lin[0] = toLinear(((c >> 16) & 255) / 255); lin[1] = toLinear(((c >> 8) & 255) / 255); lin[2] = toLinear((c & 255) / 255);
      const k = l === 2 ? 0.4 : 1;
      o[0] = lin[0] * k; o[1] = lin[1] * k; o[2] = lin[2] * k;
    }, false);
    const jn = joints.length;
    this.addDecor(joint, mat, tilesJ, (i, m) => {
      const l = Math.floor(i / jn), t = joints[i % jn];
      const [w, dy] = layers[l];
      setTRS(m, i, x[t], top[t] + dy + 0.0005, z[t], 0, w, 1, w);
    }, (i, o) => {
      const c = layers[Math.floor(i / jn)][2];
      o[0] = toLinear(((c >> 16) & 255) / 255); o[1] = toLinear(((c >> 8) & 255) / 255); o[2] = toLinear((c & 255) / 255);
    }, false);
  }

  /**
   * Recomposes every tile colour. Returns true while a reveal ramp is still running (caller keeps
   * recomposing each frame until it settles).
   */
  compose(s: TileState, now: number): boolean {
    const { n } = this.th;
    const base = this.base;
    let animating = false;
    for (let t = 0; t < n; t++) {
      let r = base[t * 3], g = base[t * 3 + 1], b = base[t * 3 + 2];
      if (s.tint) {
        const f = s.territory[t];
        if (f >= 0) {
          const o = fIdx(f);
          r += (FACTION_SRGB[o] - r) * TINT; g += (FACTION_SRGB[o + 1] - g) * TINT; b += (FACTION_SRGB[o + 2] - b) * TINT;
        }
      }
      let br = 1;
      const act = s.active[t];
      const rv = s.reveal[t];
      const age = rv > 0 ? now - rv : REVEAL_MS;
      if (!act || age < REVEAL_MS) {
        const lum = r * 0.3 + g * 0.59 + b * 0.11;
        const lr = (r + (lum - r) * 0.5) * 0.72, lg = (g + (lum - g) * 0.5) * 0.72, lb = (b + (lum - b) * 0.5) * 0.72;
        if (!act) { r = lr; g = lg; b = lb; br = 0.72; }
        else {
          animating = true;
          const k = smooth01(age / REVEAL_MS);
          const flash = Math.sin(Math.PI * k) * 0.16;
          r = lr + (r - lr) * k + AMBER[0] * flash; g = lg + (g - lg) * k + AMBER[1] * flash; b = lb + (b - lb) * k + AMBER[2] * flash;
          br = 0.72 + 0.28 * k + flash;
        }
      }
      if (s.fog) {
        const fv = s.fog[t];
        const m = fv === 2 ? 1 : fv === 1 ? 0.5 : 0.2;
        r *= m; g *= m; b *= m; br *= m;
      }
      const li = this.landIdx[t];
      const arr = li >= 0 ? this.landCol : this.waterCol;
      const o = (li >= 0 ? li : this.waterIdx[t]) * 3;
      arr[o] = toLinear(r); arr[o + 1] = toLinear(g); arr[o + 2] = toLinear(b);
      this.bright[t] = br === 1 ? 1 : toLinear(Math.min(1, br * 0.5)) / toLinear(0.5);
    }
    (this.land.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.water.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
    for (const d of this.decor) {
      const col = (d.mesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
      const cnt = d.tile.length;
      for (let i = 0; i < cnt; i++) {
        const b = this.bright[d.tile[i]];
        col[i * 3] = d.mul[i * 3] * b; col[i * 3 + 1] = d.mul[i * 3 + 1] * b; col[i * 3 + 2] = d.mul[i * 3 + 2] * b;
      }
      (d.mesh.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
    return animating;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const d of this.decor) d.mesh.dispose();
    this.land.dispose();
    this.water.dispose();
  }
}
