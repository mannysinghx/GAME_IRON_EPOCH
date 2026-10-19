// Shared constants, colour helpers and hex/world math for the three.js battlefield. World coordinates follow
// render/api.ts: hex circumradius 1, pointy-top odd-r layout, x = sqrt(3) * (col + 0.5 * parity(row)),
// z = 1.5 * row, y up. Screen-north is -z.

import * as THREE from 'three';
import { FACTIONS, T } from '../../shared/config.ts';
import { HexGrid } from '../../shared/hex.ts';
import type { MapStatic } from '../../shared/protocol.ts';
import { parity } from '../../shared/terrain.ts';

export const SQRT3 = Math.sqrt(3);
export const NEUTRAL_HEX = 0x8a93a2;
export const WATER_TOP = 0.14;
export const GROUND_Y = 0.75; // representative ground height for camera targets and ray fallbacks

/** Neighbour direction (E, NE, NW, W, SW, SE) -> index of the hex edge (corner e to e+1) it crosses. */
export const DIR_EDGE: readonly number[] = [1, 0, 5, 4, 3, 2];

/** Unit pointy-top corners, k = 0 at north (-z), clockwise seen from above. */
export const CORNER_X = new Float32Array(6);
export const CORNER_Z = new Float32Array(6);
for (let k = 0; k < 6; k++) {
  const a = ((60 * k - 90) * Math.PI) / 180;
  CORNER_X[k] = Math.cos(a);
  CORNER_Z[k] = Math.sin(a);
}

// ------------------------------------------------------------------ colour
export function factionHex(f: number): number { return f >= 0 && f < FACTIONS.length ? FACTIONS[f].color : NEUTRAL_HEX; }

export function shadeHex(c: number, f: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((c & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

export function cssHex(c: number): string { return `#${c.toString(16).padStart(6, '0')}`; }

// sRGB -> linear through a LUT: tile colours are composed in sRGB (so tints match the 2D look) and converted
// once per rebuild; per-call pow() over 16k tiles at several Hz is wasteful.
const LUT_N = 1024;
const LUT = new Float32Array(LUT_N + 1);
for (let i = 0; i <= LUT_N; i++) {
  const c = i / LUT_N;
  LUT[i] = c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}
export function toLinear(v: number): number {
  const x = v <= 0 ? 0 : v >= 1 ? LUT_N : v * LUT_N;
  const i = x | 0;
  const f = x - i;
  return i >= LUT_N ? LUT[LUT_N] : LUT[i] + (LUT[i + 1] - LUT[i]) * f;
}

const _c = new THREE.Color();
/** Linear-space rgb of an sRGB hex colour, scaled by `mul` (HDR when mul > 1). */
export function linRGB(hex: number, out: Float32Array | number[], o = 0, mul = 1): void {
  _c.setHex(hex);
  out[o] = _c.r * mul; out[o + 1] = _c.g * mul; out[o + 2] = _c.b * mul;
}

/** Linear faction colours, index f + 1 (0 = neutral). */
export const FACTION_LIN = new Float32Array((FACTIONS.length + 1) * 3);
/** sRGB 0..1 faction colours, index f + 1. */
export const FACTION_SRGB = new Float32Array((FACTIONS.length + 1) * 3);
for (let f = -1; f < FACTIONS.length; f++) {
  const hex = factionHex(f);
  linRGB(hex, FACTION_LIN, (f + 1) * 3);
  FACTION_SRGB[(f + 1) * 3] = ((hex >> 16) & 255) / 255;
  FACTION_SRGB[(f + 1) * 3 + 1] = ((hex >> 8) & 255) / 255;
  FACTION_SRGB[(f + 1) * 3 + 2] = (hex & 255) / 255;
}
export function fIdx(f: number): number { return f >= 0 && f < FACTIONS.length ? (f + 1) * 3 : 0; }

/** Reusable linear colour scratch for callers that need an rgb triple without allocating. */
export const RGB = new Float32Array(3);
export function linMix(hexA: number, hexB: number, t: number, mul: number): Float32Array {
  linRGB(mixHex(hexA, hexB, t), RGB, 0, mul);
  return RGB;
}

// ------------------------------------------------------------------ terrain palette (2D charcoal palette)
const PALETTE = [0x2a3038, 0x1e2a25, 0x3a3e46, 0x34302c, 0x223033, 0x2d3239, 0x10283e, 0x10283e];

/** Base tile colour in sRGB 0..1: palette, per-tile variant jitter, elevation brightening. */
export function baseSrgb(terrain: number, elev: number, variant: number, out: Float32Array, o: number): void {
  let col = PALETTE[terrain] ?? PALETTE[0];
  if (terrain === T.PLAINS) col = mixHex(0x2a3038, 0x2f3a33, (variant & 7) / 22);
  const v = (variant - 128) / 128;
  const f = 1.05 + v * 0.07 + elev * 0.07;
  out[o] = (((col >> 16) & 255) / 255) * f;
  out[o + 1] = (((col >> 8) & 255) / 255) * f;
  out[o + 2] = ((col & 255) / 255) * f;
}

export function isWater(terrain: number): boolean { return terrain === T.RIVER || terrain === T.CROSSING; }
export function topHeight(terrain: number, elev: number): number { return isWater(terrain) ? WATER_TOP : 0.3 + elev * 0.45; }

// ------------------------------------------------------------------ hex/world math
export function tileWX(c: number, r: number): number { return SQRT3 * (c + 0.5 * parity(r)); }
export function tileWZ(r: number): number { return 1.5 * r; }

/** Nearest offset coordinates (unbounded) of world point (x, z); written to out[0], out[1]. */
export function worldToCR(x: number, z: number, out: Int32Array | number[]): void {
  const r0 = Math.round(z / 1.5);
  let bc = 0, br = 0, bd = Infinity;
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    const c0 = Math.round(x / SQRT3 - 0.5 * parity(r));
    for (let c = c0 - 1; c <= c0 + 1; c++) {
      const dx = tileWX(c, r) - x, dz = 1.5 * r - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bc = c; br = r; }
    }
  }
  out[0] = bc; out[1] = br;
}

export function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x61c88647);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Yaw about +y that turns a model facing +x toward direction (dx, dz). */
export function yawOf(dx: number, dz: number): number { return Math.atan2(-dz, dx); }

export function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
export function smooth01(t: number): number { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); }

/**
 * Static theatre geometry shared by every layer. `top` is the prism top (water tiles sit low); `walk` is the
 * surface things stand on: the same as `top` except on crossings, where it is the bridge deck.
 */
export interface Theatre {
  map: MapStatic; grid: HexGrid; w: number; h: number; n: number;
  x: Float32Array; z: Float32Array; top: Float32Array; walk: Float32Array;
  /** Per tile (x, z): unit direction of the bridge axis on crossings, (0, 0) elsewhere. */
  deck: Float32Array;
}

/** Half thickness of the bridge deck box (models.ts bridgeGeometry, 0.07 tall, centred on the pose). */
export const DECK_HALF = 0.035;

/**
 * Bridge pose on a crossing tile: out[0] = yaw along the neighbour pair with the most land, out[1] = deck
 * centre height (the higher bank + 0.03; a missing bank counts as plains).
 */
export function deckPose(grid: HexGrid, terrain: Uint8Array, top: Float32Array, x: Float32Array, z: Float32Array, tile: number, out: Float32Array): void {
  let best = 0, bd = -1;
  const land = (v: number) => v >= 0 && terrain[v] !== T.RIVER && terrain[v] !== T.CROSSING;
  for (let d = 0; d < 3; d++) {
    const a = grid.nb[tile * 6 + d], b = grid.nb[tile * 6 + d + 3];
    const score = (land(a) ? 1 : 0) + (land(b) ? 1 : 0);
    if (score > bd) { bd = score; best = d; }
  }
  const a = grid.nb[tile * 6 + best], b = grid.nb[tile * 6 + best + 3];
  out[0] = a >= 0 && b >= 0 ? yawOf(x[b] - x[a], z[b] - z[a]) : 0;
  const ya = land(a) ? top[a] : GROUND_Y, yb = land(b) ? top[b] : GROUND_Y;
  out[1] = Math.max(ya, yb) + 0.03;
}

const _pose = new Float32Array(2);
export function buildTheatre(map: MapStatic): Theatre {
  const grid = new HexGrid(map.w, map.h);
  const n = grid.n;
  const x = new Float32Array(n), z = new Float32Array(n), top = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const c = t % map.w, r = (t / map.w) | 0;
    x[t] = tileWX(c, r); z[t] = tileWZ(r);
    top[t] = topHeight(map.terrain[t], map.elev[t]);
  }
  // units, effects and markers on a crossing stand on the deck, not in the water under it
  const walk = top.slice(), deck = new Float32Array(n * 2);
  for (let t = 0; t < n; t++) {
    if (map.terrain[t] !== T.CROSSING) continue;
    deckPose(grid, map.terrain, top, x, z, t, _pose);
    walk[t] = _pose[1] + DECK_HALF;
    deck[t * 2] = Math.cos(_pose[0]); deck[t * 2 + 1] = -Math.sin(_pose[0]); // inverse of yawOf
  }
  return { map, grid, w: map.w, h: map.h, n, x, z, top, walk, deck };
}

const _cr = [0, 0];
/** Theatre tile nearest to (x, z), or -1 outside [0,w) x [0,h). */
export function tileAt(th: Theatre, x: number, z: number): number {
  worldToCR(x, z, _cr);
  const c = _cr[0], r = _cr[1];
  if (c < 0 || r < 0 || c >= th.w || r >= th.h) return -1;
  return r * th.w + c;
}

/** Writes the world position of a hex corner (radius scaled) into out[o..o+1] as x, z. */
export function cornerXZ(cx: number, cz: number, k: number, radius: number, out: Float32Array, o: number): void {
  const kk = ((k % 6) + 6) % 6;
  out[o] = cx + CORNER_X[kk] * radius;
  out[o + 1] = cz + CORNER_Z[kk] * radius;
}

/** Disposes every geometry and material below `o` (scene graph teardown). */
export function disposeObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) for (const x of mat) x.dispose();
    else if (mat) mat.dispose();
  });
}
