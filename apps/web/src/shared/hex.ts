// Hex grid math. Pointy-top hexes in "odd-r" offset layout; tile index i = row * w + col.
// Distance and line-of-sight use axial coordinates (q, r) precomputed per tile.

export const SQRT3 = Math.sqrt(3);

// Direction order: E, NE, NW, W, SW, SE
const EVEN_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const ODD_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];

const LOS_R = 11;

export class HexGrid {
  readonly w: number;
  readonly h: number;
  readonly n: number;
  /** n * 6 neighbor indices, -1 when out of bounds */
  readonly nb: Int32Array;
  readonly aq: Int32Array;
  readonly ar: Int32Array;
  /** LOS intermediate axial offsets keyed by offset slot; each entry is [dq0, dr0, dq1, dr1, ...] */
  private readonly losTable: Int8Array[];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.nb = new Int32Array(this.n * 6);
    this.aq = new Int32Array(this.n);
    this.ar = new Int32Array(this.n);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        this.aq[i] = c - ((r - (r & 1)) >> 1);
        this.ar[i] = r;
        const dirs = (r & 1) === 0 ? EVEN_DIRS : ODD_DIRS;
        for (let d = 0; d < 6; d++) {
          const nc = c + dirs[d][0];
          const nr = r + dirs[d][1];
          this.nb[i * 6 + d] = nc >= 0 && nc < w && nr >= 0 && nr < h ? nr * w + nc : -1;
        }
      }
    }
    this.losTable = buildLosTable();
  }

  col(i: number): number { return i % this.w; }
  row(i: number): number { return (i / this.w) | 0; }
  idx(c: number, r: number): number { return r * this.w + c; }
  inBounds(c: number, r: number): boolean { return c >= 0 && c < this.w && r >= 0 && r < this.h; }

  dist(a: number, b: number): number {
    const dq = this.aq[a] - this.aq[b];
    const dr = this.ar[a] - this.ar[b];
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) >> 1;
  }

  fromAxial(q: number, r: number): number {
    if (r < 0 || r >= this.h) return -1;
    const c = q + ((r - (r & 1)) >> 1);
    if (c < 0 || c >= this.w) return -1;
    return r * this.w + c;
  }

  /** All tiles within `radius` of center (inclusive), appended to out. */
  within(center: number, radius: number, out: number[] = []): number[] {
    const cq = this.aq[center];
    const cr = this.ar[center];
    for (let dq = -radius; dq <= radius; dq++) {
      const lo = Math.max(-radius, -dq - radius);
      const hi = Math.min(radius, -dq + radius);
      for (let dr = lo; dr <= hi; dr++) {
        const t = this.fromAxial(cq + dq, cr + dr);
        if (t >= 0) out.push(t);
      }
    }
    return out;
  }

  /**
   * Line-of-sight test from a to b. `blocks(tile, maxElev)` decides whether an intermediate tile obstructs.
   * Returns true when nothing blocks. Pairs beyond the precomputed radius fall back to visible=false.
   */
  los(a: number, b: number, blocks: (t: number) => boolean): boolean {
    const dq = this.aq[b] - this.aq[a];
    const dr = this.ar[b] - this.ar[a];
    if (Math.abs(dq) > LOS_R || Math.abs(dr) > LOS_R || Math.abs(dq + dr) > LOS_R) return false;
    const row = this.losTable[(dq + LOS_R) * (2 * LOS_R + 1) + (dr + LOS_R)];
    if (!row) return true;
    const q0 = this.aq[a];
    const r0 = this.ar[a];
    for (let k = 0; k < row.length; k += 2) {
      const t = this.fromAxial(q0 + row[k], r0 + row[k + 1]);
      if (t >= 0 && blocks(t)) return false;
    }
    return true;
  }

  /** Tiles on the hex line from a to b, inclusive of both ends. */
  line(a: number, b: number): number[] {
    const n = this.dist(a, b);
    const out: number[] = [];
    const aq = this.aq[a] + 1e-6, ar = this.ar[a] + 2e-6;
    const bq = this.aq[b] + 1e-6, br = this.ar[b] + 2e-6;
    for (let i = 0; i <= n; i++) {
      const t = n === 0 ? 0 : i / n;
      const [q, r] = axialRound(aq + (bq - aq) * t, ar + (br - ar) * t);
      const tile = this.fromAxial(q, r);
      if (tile >= 0 && out[out.length - 1] !== tile) out.push(tile);
    }
    return out;
  }
}

function axialRound(fq: number, fr: number): [number, number] {
  const fs = -fq - fr;
  let q = Math.round(fq), r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return [q, r];
}

function buildLosTable(): Int8Array[] {
  const size = 2 * LOS_R + 1;
  const table: Int8Array[] = new Array(size * size);
  for (let dq = -LOS_R; dq <= LOS_R; dq++) {
    for (let dr = -LOS_R; dr <= LOS_R; dr++) {
      const n = (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) >> 1;
      if (n > LOS_R || n <= 1) continue;
      const pts: number[] = [];
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const [q, r] = axialRound(1e-6 + dq * t, 2e-6 + dr * t);
        pts.push(q, r);
      }
      table[(dq + LOS_R) * size + (dr + LOS_R)] = Int8Array.from(pts);
    }
  }
  return table;
}

// ---------------------------------------------------------------------------------------------
// Screen layout for the 2.5D renderer. Shared so the minimap, picking and renderer agree.

export const HEX_SIZE = 18;
export const TILT = 0.8;
export const ELEV_PX = 6;
export const HEX_W = HEX_SIZE * SQRT3;
export const ROW_H = HEX_SIZE * 1.5 * TILT;

export function tileCX(c: number, r: number): number { return HEX_W * (c + 0.5 * (r & 1)) + HEX_W / 2; }
export function tileCY(r: number): number { return ROW_H * r + HEX_SIZE; }

/** Pointy-top hex corners (squashed by TILT), starting at the top vertex, clockwise. */
export function hexCorners(cx: number, cy: number, size = HEX_SIZE): number[] {
  const pts: number[] = [];
  for (let k = 0; k < 6; k++) {
    const ang = (Math.PI / 180) * (60 * k - 90);
    pts.push(cx + size * Math.cos(ang), cy + size * Math.sin(ang) * TILT);
  }
  return pts;
}
