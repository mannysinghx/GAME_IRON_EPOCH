// Seamless, infinite terrain field shared by the simulation's map generator and the renderer's endless
// scenery. Every function is a pure function of (seed, column, row), defined for any integer coordinate,
// so land outside the simulated theatre continues the theatre's terrain without a seam.

import { T } from './config.ts';

/** Row parity that is correct for negative rows too (odd-r offset layout). */
export function parity(r: number): number { return ((r % 2) + 2) % 2; }

function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Integer lattice hash in [0, 1). */
export function hash2(seed: number, x: number, y: number): number {
  return mix32((seed >>> 0) ^ mix32(Math.imul(x | 0, 0x27d4eb2d) ^ mix32(Math.imul(y | 0, 0x165667b1) + 0x9e3779b9))) / 4294967296;
}

/** Smooth value noise at continuous coordinates. */
export function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(seed, x0, y0), b = hash2(seed, x0 + 1, y0);
  const c = hash2(seed, x0, y0 + 1), d = hash2(seed, x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal value noise; `scale` is the lattice spacing of the first octave in tile units. */
export function fbm(seed: number, x: number, y: number, scale: number, octaves: number): number {
  let amp = 1, total = 0, sum = 0;
  for (let o = 0; o < octaves; o++) {
    const s = scale / (1 << o);
    sum += amp * valueNoise((seed + Math.imul(o + 1, 0x632be5ab)) >>> 0, x / s, y / s);
    total += amp;
    amp *= 0.5;
  }
  return sum / total;
}

/** Continuous position of a tile centre in column units (x) and row units (y). */
export function tileXY(c: number, r: number): [number, number] { return [c + 0.5 * parity(r), r * 0.87]; }

export interface TerrainSample { terrain: number; elev: number; variant: number }

const SEED_E = 0x51ed, SEED_M = 0x6a11, SEED_R = 0x7e22, SEED_V = 0x0b0b;

/**
 * Base terrain before theatre features (rivers, roads, sites, cores). Thresholds match the original
 * generator: ridge above 0.66 (high ridge above 0.76), marsh in wet lowland, forest in wet ground,
 * scattered industrial ruins, plains otherwise.
 */
export function sampleBaseTerrain(seed: number, c: number, r: number): TerrainSample {
  const [x, y] = tileXY(c, r);
  const e = fbm((seed ^ SEED_E) >>> 0, x, y, 14, 4);
  const m = fbm((seed ^ SEED_M) >>> 0, x, y, 10, 3);
  const ru = fbm((seed ^ SEED_R) >>> 0, x, y, 6, 2);
  const variant = Math.floor(hash2((seed ^ SEED_V) >>> 0, c, r) * 256);
  let terrain: number = T.PLAINS;
  if (e > 0.66) terrain = T.RIDGE;
  else if (e < 0.3 && m > 0.5) terrain = T.MARSH;
  else if (m > 0.6) terrain = T.FOREST;
  else if (ru > 0.74) terrain = T.RUIN;
  const elev = terrain === T.RIDGE ? (e > 0.76 ? 3 : 2) : terrain === T.MARSH ? 0 : 1;
  return { terrain, elev, variant };
}

export interface RiverParams { cx: number; cy: number; ah: [number, number, number, number]; av: [number, number, number, number] }

/** Two rivers (west-east and north-south) crossing at the theatre centre, extended forever. */
export function riverParams(seed: number, w: number, h: number): RiverParams {
  const ph = (k: number) => hash2((seed ^ 0x41a7) >>> 0, k, 7) * Math.PI * 2;
  return { cx: (w - 1) / 2, cy: (h - 1) / 2, ah: [ph(0), ph(1), 0, 0], av: [ph(2), ph(3), 0, 0] };
}

const A1 = 4.2, F1 = 0.11, A2 = 2.0, F2 = 0.29;

/** Perpendicular distance (column units) from a tile centre to the nearest river centre-line. */
export function riverDistance(p: RiverParams, c: number, r: number): number {
  const x = c + 0.5 * parity(r);
  // west-east river: row as a function of x
  const yh = p.cy + A1 * Math.sin(F1 * x + p.ah[0]) + A2 * Math.sin(F2 * x + p.ah[1]);
  const dy = A1 * F1 * Math.cos(F1 * x + p.ah[0]) + A2 * F2 * Math.cos(F2 * x + p.ah[1]);
  const dh = (Math.abs(r - yh) * 0.866) / Math.sqrt(1 + (dy * 0.866) * (dy * 0.866));
  // north-south river: column position as a function of row
  const xv = p.cx + A1 * Math.sin(F1 * r + p.av[0]) + A2 * Math.sin(F2 * r + p.av[1]);
  const dx = (A1 * F1 * Math.cos(F1 * r + p.av[0]) + A2 * F2 * Math.cos(F2 * r + p.av[1])) / 0.866;
  const dv = Math.abs(x - xv) / Math.sqrt(1 + dx * dx);
  return Math.min(dh, dv);
}

/** River test with a width that keeps the channel connected on the hex lattice (circumradius 0.577). */
export function isRiver(p: RiverParams, c: number, r: number): boolean { return riverDistance(p, c, r) <= 0.58; }
