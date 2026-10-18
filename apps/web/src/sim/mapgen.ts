// Seeded map generation (design doc §3.2). Produces connected routes, multiple supply paths,
// comparable faction starts, and rejects seeds that fail connectivity or balance checks.

import { S, T, TERRAIN } from '../shared/config.ts';
import { HexGrid } from '../shared/hex.ts';
import { Rng } from '../shared/rng.ts';

export interface SiteSpec { kind: number; tile: number; name: string; faction: number }
export interface CoreSpec { faction: number; slot: number; tile: number }

export interface MapData {
  w: number; h: number; seed: number;
  terrain: Uint8Array; elev: Uint8Array; variant: Uint8Array;
  sites: SiteSpec[]; cores: CoreSpec[]; reserveEntry: number[]; bridges: { tile: number; name: string }[];
  attempts: number;
}

function noiseField(rng: Rng, grid: HexGrid, scale: number, octaves: number): Float32Array {
  const out = new Float32Array(grid.n);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const s = scale / (1 << o);
    const gw = Math.ceil(grid.w / s) + 3, gh = Math.ceil((grid.h * 0.87) / s) + 3;
    const lattice = new Float32Array(gw * gh);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng.float();
    for (let i = 0; i < grid.n; i++) {
      const c = grid.col(i), r = grid.row(i);
      const x = (c + 0.5 * (r & 1)) / s, y = (r * 0.87) / s;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const a = lattice[y0 * gw + x0], b = lattice[y0 * gw + x0 + 1];
      const cc = lattice[(y0 + 1) * gw + x0], d = lattice[(y0 + 1) * gw + x0 + 1];
      out[i] += amp * (a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy);
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < grid.n; i++) out[i] /= total;
  return out;
}

function passable(t: number): boolean { return TERRAIN[t].cost > 0; }

function nearestLand(grid: HexGrid, terrain: Uint8Array, taken: Set<number>, c: number, r: number, prefer?: (t: number) => boolean): number {
  c = Math.max(1, Math.min(grid.w - 2, Math.round(c)));
  r = Math.max(1, Math.min(grid.h - 2, Math.round(r)));
  const center = grid.idx(c, r);
  for (let rad = 0; rad < 8; rad++) {
    const ring = grid.within(center, rad);
    let best = -1;
    for (const t of ring) {
      if (grid.dist(t, center) !== rad) continue;
      const tt = terrain[t];
      if (!passable(tt) || tt === T.CROSSING || taken.has(t)) continue;
      const col = grid.col(t), row = grid.row(t);
      if (col < 1 || row < 1 || col > grid.w - 2 || row > grid.h - 2) continue;
      if (prefer && prefer(tt)) return t;
      if (best < 0 || t < best) best = t;
    }
    if (best >= 0 && !prefer) return best;
    if (best >= 0 && rad >= 2) return best;
  }
  return center;
}

function roadPath(grid: HexGrid, terrain: Uint8Array, from: number, to: number): number[] {
  const dist = new Float64Array(grid.n).fill(Infinity);
  const prev = new Int32Array(grid.n).fill(-1);
  const open: number[] = [from];
  dist[from] = 0;
  const cost = (t: number) => {
    switch (terrain[t]) {
      case T.ROAD: return 4; case T.PLAINS: return 10; case T.FOREST: return 15; case T.RUIN: return 12;
      case T.MARSH: return 22; case T.RIDGE: return 34; case T.CROSSING: return 6; default: return Infinity;
    }
  };
  // simple binary heap keyed by dist
  const heap: number[] = [];
  const push = (t: number) => {
    heap.push(t);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (dist[heap[p]] <= dist[heap[i]]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0]; const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && dist[heap[l]] < dist[heap[m]]) m = l;
        if (r < heap.length && dist[heap[r]] < dist[heap[m]]) m = r;
        if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  open.length = 0;
  push(from);
  while (heap.length) {
    const u = pop();
    if (u === to) break;
    for (let d = 0; d < 6; d++) {
      const v = grid.nb[u * 6 + d];
      if (v < 0) continue;
      const c = cost(v);
      if (!isFinite(c)) continue;
      const nd = dist[u] + c;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(v); }
    }
  }
  const path: number[] = [];
  let cur = to;
  if (prev[cur] < 0 && cur !== from) return path;
  while (cur >= 0) { path.push(cur); if (cur === from) break; cur = prev[cur]; }
  return path.reverse();
}

function connected(grid: HexGrid, terrain: Uint8Array, from: number, targets: number[]): boolean {
  const seen = new Uint8Array(grid.n);
  const q = [from]; seen[from] = 1;
  while (q.length) {
    const u = q.pop()!;
    for (let d = 0; d < 6; d++) {
      const v = grid.nb[u * 6 + d];
      if (v >= 0 && !seen[v] && passable(terrain[v])) { seen[v] = 1; q.push(v); }
    }
  }
  return targets.every((t) => seen[t] === 1);
}

const MINE_NAMES = ['Ashfall Pit', 'Cobalt Seam', 'Gantry Mine', 'Ironreach', 'Slagfield', 'Hollow Vein', 'Redstack', 'Quarry Nine', 'Deepcut', 'Talon Pit', 'Ore Terrace', 'Black Lode', 'Rustvale', 'Cinder Shaft', 'Graywell', 'Lodestar'];
const REFINERY_NAMES = ['Reactor Kel', 'Reactor Ivo', 'Reactor Sum', 'Reactor Tor', 'Reactor Ash', 'Reactor Nev', 'Reactor Oro', 'Reactor Pyl'];
const RELAY_NAMES = ['Relay 03', 'Relay 05', 'Relay 07', 'Relay 09', 'Relay 11', 'Relay 12', 'Relay 14', 'Relay 16'];
const HUB_NAMES = ['Hub Meridian', 'Hub Lattice', 'Hub Foundry', 'Hub Gate'];

/** Generate the 64x64 four-faction world. */
export function generateWorldMap(seed: number, w: number, h: number): MapData {
  const rng = new Rng(seed ^ 0x5eed1234);
  for (let attempt = 1; attempt <= 12; attempt++) {
    const m = tryWorld(rng, seed, w, h);
    if (m) { m.attempts = attempt; return m; }
  }
  throw new Error('map generation failed validation 12 times');
}

function tryWorld(rng: Rng, seed: number, w: number, h: number): MapData | null {
  const grid = new HexGrid(w, h);
  const terrain = new Uint8Array(grid.n);
  const elev = new Uint8Array(grid.n);
  const variant = new Uint8Array(grid.n);
  const e = noiseField(rng, grid, 14, 4);
  const m = noiseField(rng, grid, 10, 3);
  for (let i = 0; i < grid.n; i++) {
    variant[i] = rng.int(256);
    const ev = e[i], mv = m[i];
    let t: number = T.PLAINS;
    if (ev > 0.66) t = T.RIDGE;
    else if (ev < 0.3 && mv > 0.5) t = T.MARSH;
    else if (mv > 0.6) t = T.FOREST;
    terrain[i] = t;
    elev[i] = t === T.RIDGE ? (ev > 0.76 ? 3 : 2) : t === T.MARSH ? 0 : 1;
  }
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const center = grid.idx(Math.round(cx), Math.round(cy));
  const nearCenter = (t: number) => grid.dist(t, center) <= 3;

  // Rivers: one west-east, one north-south, meeting at a central plateau which stays dry land.
  const phase = [rng.float() * 6.28, rng.float() * 6.28, rng.float() * 6.28, rng.float() * 6.28];
  const riverTiles = new Set<number>();
  const markRiver = (c: number, r: number) => {
    const ci = Math.round(c), ri = Math.round(r);
    if (!grid.inBounds(ci, ri)) return;
    const t = grid.idx(ci, ri);
    if (nearCenter(t)) return;
    riverTiles.add(t);
  };
  for (let x = 0; x < w; x += 0.2) {
    const y = cy + 2.6 * Math.sin(x * 0.17 + phase[0]) + 1.4 * Math.sin(x * 0.41 + phase[1]);
    markRiver(x - 0.5 * (Math.round(y) & 1), y);
  }
  for (let y = 0; y < h; y += 0.2) {
    const x = cx + 2.6 * Math.sin(y * 0.19 + phase[2]) + 1.4 * Math.sin(y * 0.37 + phase[3]);
    markRiver(x - 0.5 * (Math.round(y) & 1), y);
  }
  for (const t of riverTiles) { terrain[t] = T.RIVER; elev[t] = 0; }
  // banks
  for (const t of riverTiles) {
    for (let d = 0; d < 6; d++) {
      const v = grid.nb[t * 6 + d];
      if (v >= 0 && terrain[v] !== T.RIVER && terrain[v] !== T.RIDGE && rng.pct(30)) { terrain[v] = T.MARSH; elev[v] = 0; }
    }
  }
  // central plateau
  for (const t of grid.within(center, 3)) {
    terrain[t] = grid.dist(t, center) === 3 && rng.pct(45) ? T.RUIN : T.PLAINS;
    elev[t] = 2;
  }

  // Crossings: two per river arm.
  const bridges: { tile: number; name: string }[] = [];
  const arms: { name: string; horizontal: boolean; sign: number }[] = [
    { name: 'N', horizontal: false, sign: -1 }, { name: 'S', horizontal: false, sign: 1 },
    { name: 'W', horizontal: true, sign: -1 }, { name: 'E', horizontal: true, sign: 1 },
  ];
  for (const arm of arms) {
    for (const [k, frac] of [[1, 0.42], [2, 0.8]] as const) {
      const span = arm.horizontal ? cx : cy;
      const along = (arm.horizontal ? cx : cy) + arm.sign * span * frac;
      let best = -1, bestScore = Infinity;
      for (const t of riverTiles) {
        const c = grid.col(t), r = grid.row(t);
        const pos = arm.horizontal ? c : r;
        const score = Math.abs(pos - along);
        if (score > 5) continue;
        // a clean crossing has land on both banks
        const nb = (d: number) => grid.nb[t * 6 + d];
        const land = (v: number) => v >= 0 && terrain[v] !== T.RIVER;
        const ok = arm.horizontal
          ? (land(nb(1)) || land(nb(2))) && (land(nb(4)) || land(nb(5)))
          : land(nb(0)) && land(nb(3));
        if (!ok) continue;
        // avoid double-thick river at the crossing
        const riverNbrs = [0, 1, 2, 3, 4, 5].filter((d) => { const v = nb(d); return v >= 0 && terrain[v] === T.RIVER; }).length;
        if (riverNbrs > 2) continue;
        if (score < bestScore || (score === bestScore && t < best)) { best = t; bestScore = score; }
      }
      if (best >= 0) {
        terrain[best] = T.CROSSING; elev[best] = 0;
        bridges.push({ tile: best, name: `Crossing ${arm.name}-${k}` });
      }
    }
  }
  if (bridges.length < 6) return null;

  // Faction starts: four quadrants, two command cores each, mirrored offsets.
  const quad = [
    { f: 0, sx: -1, sy: -1 }, { f: 1, sx: 1, sy: -1 }, { f: 2, sx: -1, sy: 1 }, { f: 3, sx: 1, sy: 1 },
  ];
  const taken = new Set<number>();
  const cores: CoreSpec[] = [];
  const sites: SiteSpec[] = [];
  const reserveEntry: number[] = [];
  const qp = (q: { sx: number; sy: number }, u: number, v: number): [number, number] => [cx + q.sx * (cx - u * w), cy + q.sy * (cy - v * h)];
  const clearAround = (t: number, rad: number) => {
    for (const v of grid.within(t, rad)) {
      if (terrain[v] === T.RIVER || terrain[v] === T.CROSSING) continue;
      terrain[v] = T.PLAINS; elev[v] = 1;
    }
  };
  for (const q of quad) {
    const [bx, by] = qp(q, 0.22, 0.24);
    const offs: [number, number][] = [[-4, 4], [5, -3]];
    offs.forEach(([ox, oy], slot) => {
      // mirrored: east factions flip the x offset, south factions flip the y offset
      const cc = bx + ox * (q.sx < 0 ? 1 : -1), rr = by + oy * (q.sy < 0 ? 1 : -1);
      const t = nearestLand(grid, terrain, taken, cc, rr);
      clearAround(t, 3);
      taken.add(t);
      cores.push({ faction: q.f, slot, tile: t });
    });
    const [ex, ey] = qp(q, 0.07, 0.07);
    const entry = nearestLand(grid, terrain, taken, ex, ey);
    clearAround(entry, 1);
    reserveEntry[q.f] = entry;
  }
  // Faction-start resources: one mine beside each core, one refinery between the pair.
  for (const core of cores) {
    const q = quad[core.faction];
    const c = grid.col(core.tile), r = grid.row(core.tile);
    const dx = core.slot === 0 ? -2 : 2;
    const t = nearestLand(grid, terrain, taken, c + dx * (q.sx < 0 ? 1 : -1), r + 2 * (q.sy < 0 ? -1 : 1));
    taken.add(t);
    sites.push({ kind: S.MINE, tile: t, name: '', faction: core.faction });
  }
  for (const q of quad) {
    const [bx, by] = qp(q, 0.22, 0.24);
    const t = nearestLand(grid, terrain, taken, bx, by);
    taken.add(t);
    sites.push({ kind: S.REFINERY, tile: t, name: '', faction: q.f });
  }
  // Neutral sites, mirrored template per quadrant.
  const template: { kind: number; u: number; v: number; prefer?: (t: number) => boolean }[] = [
    { kind: S.MINE, u: 0.41, v: 0.09 },
    { kind: S.MINE, u: 0.09, v: 0.41 },
    { kind: S.REFINERY, u: 0.3, v: 0.31 },
    { kind: S.RELAY, u: 0.31, v: 0.45, prefer: (t) => t === T.RIDGE },
    { kind: S.RELAY, u: 0.45, v: 0.31, prefer: (t) => t === T.RIDGE },
    { kind: S.HUB, u: 0.42, v: 0.42 },
  ];
  for (const q of quad) {
    for (const s of template) {
      const [c, r] = qp(q, s.u, s.v);
      const t = nearestLand(grid, terrain, taken, c, r, s.prefer);
      taken.add(t);
      if (s.kind === S.HUB) clearAround(t, 1);
      sites.push({ kind: s.kind, tile: t, name: '', faction: -1 });
    }
    // ruin clusters
    for (const [u, v] of [[0.3, 0.16], [0.16, 0.3], [0.38, 0.22]] as const) {
      const [c, r] = qp(q, u, v);
      const t = nearestLand(grid, terrain, taken, c, r);
      for (const x of grid.within(t, 1 + rng.int(2))) {
        if (taken.has(x) || terrain[x] === T.RIVER || terrain[x] === T.CROSSING) continue;
        if (rng.pct(70)) { terrain[x] = T.RUIN; elev[x] = 1; }
      }
    }
  }
  sites.push({ kind: S.CITADEL, tile: center, name: 'Citadel Prime', faction: -1 });
  taken.add(center);

  // Roads connect cores, hubs, crossings, and the citadel.
  const roadTargets: [number, number][] = [];
  for (const q of quad) {
    const cs = cores.filter((c) => c.faction === q.f);
    roadTargets.push([cs[0].tile, cs[1].tile]);
    const hub = sites.filter((s) => s.kind === S.HUB).sort((a, b) => grid.dist(a.tile, cs[0].tile) - grid.dist(b.tile, cs[0].tile))[0];
    roadTargets.push([cs[0].tile, hub.tile], [hub.tile, center]);
    const nearB = bridges.slice().sort((a, b) => grid.dist(a.tile, cs[1].tile) - grid.dist(b.tile, cs[1].tile)).slice(0, 2);
    for (const b of nearB) roadTargets.push([cs[1].tile, b.tile]);
  }
  for (const [a, b] of roadTargets) {
    for (const t of roadPath(grid, terrain, a, b)) {
      if (taken.has(t) || terrain[t] === T.CROSSING || terrain[t] === T.RIVER) continue;
      terrain[t] = T.ROAD;
      if (elev[t] > 2) elev[t] = 2;
      if (elev[t] === 0) elev[t] = 1;
    }
  }

  // Validation: every core, the citadel and every site reachable from the first core; balanced starts.
  const targets = [...cores.map((c) => c.tile), center, ...sites.map((s) => s.tile), ...reserveEntry];
  if (!connected(grid, terrain, cores[0].tile, targets)) return null;
  for (const q of quad) {
    const mine = cores.filter((c) => c.faction === q.f);
    const res = sites.filter((s) => s.faction === -1 && (s.kind === S.MINE || s.kind === S.REFINERY) && Math.min(...mine.map((c) => grid.dist(c.tile, s.tile))) <= 18).length;
    if (res < 2) return null;
  }

  // Deterministic names, ordered by tile.
  const nameKinds: [number, string[]][] = [[S.MINE, MINE_NAMES], [S.REFINERY, REFINERY_NAMES], [S.RELAY, RELAY_NAMES], [S.HUB, HUB_NAMES]];
  for (const [kind, names] of nameKinds) {
    sites.filter((s) => s.kind === kind).sort((a, b) => a.tile - b.tile).forEach((s, i) => { s.name = names[i % names.length]; });
  }
  return { w, h, seed, terrain, elev, variant, sites, cores, reserveEntry, bridges, attempts: 0 };
}

/** Equal-budget duel arena for proving-ground evaluations (§7.2). Two sides, mirrored layout. */
export function generateDuelMap(seed: number): MapData {
  const w = 30, h = 21;
  const rng = new Rng(seed ^ 0xd0e1);
  const grid = new HexGrid(w, h);
  const terrain = new Uint8Array(grid.n);
  const elev = new Uint8Array(grid.n);
  const variant = new Uint8Array(grid.n);
  const e = noiseField(rng, grid, 7, 3);
  const m = noiseField(rng, grid, 6, 2);
  for (let i = 0; i < grid.n; i++) {
    const c = grid.col(i), r = grid.row(i);
    const mc = w - 1 - c, mr = h - 1 - r;
    const j = grid.idx(mc, mr);
    // point-mirrored: use the lower index's noise so both halves match
    const src = Math.min(i, j);
    const ev = e[src], mv = m[src];
    let t: number = T.PLAINS;
    if (ev > 0.7) t = T.RIDGE; else if (mv > 0.64) t = T.FOREST; else if (ev < 0.27) t = T.MARSH;
    else if (mv < 0.24) t = T.RUIN;
    terrain[i] = t;
    elev[i] = t === T.RIDGE ? 2 : t === T.MARSH ? 0 : 1;
    variant[i] = rng.int(256);
  }
  const a = grid.idx(3, 10), b = grid.idx(26, 10);
  for (const core of [a, b]) for (const t of grid.within(core, 2)) { terrain[t] = T.PLAINS; elev[t] = 1; }
  const centre = grid.idx(15, 10), north = grid.idx(15, 4), south = grid.idx(14, 16);
  for (const t of [centre, north, south]) { terrain[t] = T.PLAINS; elev[t] = 1; }
  for (const t of roadPath(grid, terrain, a, b)) if (t !== a && t !== b) terrain[t] = T.ROAD;
  const sites: SiteSpec[] = [
    { kind: S.RELAY, tile: centre, name: 'Arena Centre', faction: -1 },
    { kind: S.RELAY, tile: north, name: 'Arena North', faction: -1 },
    { kind: S.RELAY, tile: south, name: 'Arena South', faction: -1 },
    { kind: S.MINE, tile: grid.idx(5, 13), name: 'West Pit', faction: 0 },
    { kind: S.MINE, tile: grid.idx(24, 7), name: 'East Pit', faction: 1 },
  ];
  return {
    w, h, seed, terrain, elev, variant, sites,
    cores: [{ faction: 0, slot: 0, tile: a }, { faction: 1, slot: 0, tile: b }],
    reserveEntry: [a, b], bridges: [], attempts: 1,
  };
}
