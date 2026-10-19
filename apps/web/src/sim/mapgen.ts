// Seeded map generation (design doc §3.2, §3.4). The world map is the full 128 x 128 launch theatre. Base terrain
// and rivers come from the shared infinite field (shared/terrain.ts) with the world seed itself, so the renderer's
// scenery beyond the edge continues without a seam. Factions, roads and starting sites fill the central 64 x 64
// (open at start); every frontier chunk gets mirrored sites that are instantiated only when that chunk opens.
// Seeds whose routes fail connectivity or start-balance checks are rejected and regenerated.

import { CHUNK, FRONTIER, S, T, TERRAIN } from '../shared/config.ts';
import { HexGrid } from '../shared/hex.ts';
import { Rng } from '../shared/rng.ts';
import { hash2, isRiver, riverParams, sampleBaseTerrain } from '../shared/terrain.ts';

export interface SiteSpec { kind: number; tile: number; name: string; faction: number }
export interface CoreSpec { faction: number; slot: number; tile: number }
export interface BridgeSpec { tile: number; name: string }

export interface MapData {
  w: number; h: number; seed: number;
  terrain: Uint8Array; elev: Uint8Array; variant: Uint8Array;
  sites: SiteSpec[]; cores: CoreSpec[]; reserveEntry: number[]; bridges: BridgeSpec[];
  /** Frontier sites / bridges keyed by chunk index (cy * chunksX + cx); never structures until the chunk opens. */
  frontierSites: Record<number, SiteSpec[]>; frontierBridges: Record<number, BridgeSpec[]>;
  attempts: number;
}

/** Quadrant order matches faction ids: 0 NW, 1 NE, 2 SW, 3 SE. */
export const QUADS = [
  { key: 'NW', sx: -1, sy: -1 }, { key: 'NE', sx: 1, sy: -1 }, { key: 'SW', sx: -1, sy: 1 }, { key: 'SE', sx: 1, sy: 1 },
] as const;

export interface FrontierPlan {
  cw: number; ch: number;
  initial: number[]; // chunks open at world creation
  groups: number[][]; // opening order: each group is one chunk per quadrant (NW, NE, SW, SE) at mirrored positions
  names: Record<number, string>; // frontier chunk labels, e.g. NW-3 (third NW chunk to open)
}

/** Deterministic frontier schedule: ring by ring outward from the initial square, nearest chunk first. */
export function frontierPlan(seed: number, w: number, h: number): FrontierPlan {
  const cw = Math.floor(w / CHUNK), ch = Math.floor(h / CHUNK);
  const lo = FRONTIER.initialMin, hi = FRONTIER.initialMax;
  const initial: number[] = [];
  for (let cy = lo; cy <= hi; cy++) for (let cx = lo; cx <= hi; cx++) initial.push(cy * cw + cx);
  const nw: { cx: number; cy: number; ring: number; d2: number; tie: number }[] = [];
  for (let cy = 0; cy < ch >> 1; cy++) {
    for (let cx = 0; cx < cw >> 1; cx++) {
      if (cx >= lo && cy >= lo) continue;
      // integer squared distance from chunk centre to map centre, so mirrored chunks tie exactly
      const dx = (2 * cx + 1) * CHUNK - w, dy = (2 * cy + 1) * CHUNK - h;
      nw.push({ cx, cy, ring: Math.max(lo - cx, lo - cy), d2: dx * dx + dy * dy, tie: hash2((seed ^ 0xf3a7) >>> 0, cx, cy) });
    }
  }
  nw.sort((a, b) => a.ring - b.ring || a.d2 - b.d2 || a.tie - b.tie);
  const names: Record<number, string> = {};
  const groups = nw.map((c, k) => QUADS.map((q) => {
    const mx = q.sx < 0 ? c.cx : cw - 1 - c.cx, my = q.sy < 0 ? c.cy : ch - 1 - c.cy;
    const ci = my * cw + mx;
    names[ci] = `${q.key}-${k + 1}`;
    return ci;
  }));
  return { cw, ch, initial, groups, names };
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

/** Nearest acceptable land tile to (c, r), searching rings out to radius 7; -1 when none qualifies. */
function nearestLand(
  grid: HexGrid, terrain: Uint8Array, taken: Set<number>, c: number, r: number,
  prefer: ((t: number) => boolean) | undefined, accept: (t: number) => boolean,
): number {
  c = Math.max(1, Math.min(grid.w - 2, Math.round(c)));
  r = Math.max(1, Math.min(grid.h - 2, Math.round(r)));
  const center = grid.idx(c, r);
  for (let rad = 0; rad < 8; rad++) {
    const ring = grid.within(center, rad);
    let best = -1;
    for (const t of ring) {
      if (grid.dist(t, center) !== rad) continue;
      const tt = terrain[t];
      if (!passable(tt) || tt === T.CROSSING || taken.has(t) || !accept(t)) continue;
      const col = grid.col(t), row = grid.row(t);
      if (col < 1 || row < 1 || col > grid.w - 2 || row > grid.h - 2) continue;
      if (prefer && prefer(tt)) return t;
      if (best < 0 || t < best) best = t;
    }
    if (best >= 0 && !prefer) return best;
    if (best >= 0 && rad >= 2) return best;
  }
  return -1;
}

function roadPath(grid: HexGrid, terrain: Uint8Array, from: number, to: number, mask?: Uint8Array): number[] {
  const dist = new Float64Array(grid.n).fill(Infinity);
  const prev = new Int32Array(grid.n).fill(-1);
  dist[from] = 0;
  const cost = (t: number) => {
    if (mask && !mask[t]) return Infinity;
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

function connected(grid: HexGrid, terrain: Uint8Array, from: number, targets: number[], mask?: Uint8Array): boolean {
  const seen = new Uint8Array(grid.n);
  const q = [from]; seen[from] = 1;
  while (q.length) {
    const u = q.pop()!;
    for (let d = 0; d < 6; d++) {
      const v = grid.nb[u * 6 + d];
      if (v >= 0 && !seen[v] && passable(terrain[v]) && (!mask || mask[v])) { seen[v] = 1; q.push(v); }
    }
  }
  return targets.every((t) => seen[t] === 1);
}

/** Connected-component label of every passable tile (inside `mask` when given); -1 elsewhere. */
function components(grid: HexGrid, terrain: Uint8Array, mask?: Uint8Array): Int32Array {
  const lab = new Int32Array(grid.n).fill(-1);
  const q: number[] = [];
  let next = 0;
  for (let s = 0; s < grid.n; s++) {
    if (lab[s] >= 0 || !passable(terrain[s]) || (mask && !mask[s])) continue;
    lab[s] = next; q.length = 0; q.push(s);
    while (q.length) {
      const u = q.pop()!;
      for (let d = 0; d < 6; d++) {
        const v = grid.nb[u * 6 + d];
        if (v >= 0 && lab[v] < 0 && passable(terrain[v]) && (!mask || mask[v])) { lab[v] = next; q.push(v); }
      }
    }
    next++;
  }
  return lab;
}

const MINE_NAMES = ['Ashfall Pit', 'Cobalt Seam', 'Gantry Mine', 'Ironreach', 'Slagfield', 'Hollow Vein', 'Redstack', 'Quarry Nine', 'Deepcut', 'Talon Pit', 'Ore Terrace', 'Black Lode', 'Rustvale', 'Cinder Shaft', 'Graywell', 'Lodestar'];
const REFINERY_NAMES = ['Reactor Kel', 'Reactor Ivo', 'Reactor Sum', 'Reactor Tor', 'Reactor Ash', 'Reactor Nev', 'Reactor Oro', 'Reactor Pyl'];
const RELAY_NAMES = ['Relay 03', 'Relay 05', 'Relay 07', 'Relay 09', 'Relay 11', 'Relay 12', 'Relay 14', 'Relay 16'];
const HUB_NAMES = ['Hub Meridian', 'Hub Lattice', 'Hub Foundry', 'Hub Gate'];
// Frontier pools never repeat an inner name; overflow gets a numeric suffix so every site name stays unique.
const FRONTIER_MINES = ['Coldiron', 'Brimstone', 'Saltmarch', 'Copperhead', 'Whitecap', 'Sunder', 'Hollowell', 'Kettle', 'Ridgeback', 'Marrow', 'Flintlock', 'Gravelpit', 'Ironhook', 'Tinmoor', 'Ashgrave', 'Blackwater', 'Stonejaw', 'Rimefall', 'Dunmore', 'Cragmouth', 'Hearthstone', 'Grimsel', 'Oxbow', 'Pikeholm', 'Scarp', 'Thornvein', 'Umberlode', 'Vantage', 'Wolfram', 'Yardley', 'Zincpoint', 'Anchorite', 'Bellrock', 'Chalkface', 'Dross', 'Emberlode', 'Fathom', 'Glint', 'Hobnail', 'Irongate'].map((s) => `${s} Mine`);
const FRONTIER_REACTORS = ['Ada', 'Bex', 'Cyr', 'Dov', 'Eon', 'Fen', 'Gal', 'Hax', 'Ilo', 'Jun', 'Kai', 'Lux', 'Mir', 'Nyx', 'Ost', 'Pax', 'Quo', 'Rho', 'Syl', 'Tal', 'Uma', 'Vex', 'Wyn', 'Xan', 'Yor', 'Zed', 'Arc', 'Bel', 'Cor', 'Dax', 'Elm', 'Fyr'].map((s) => `Reactor ${s}`);
const FRONTIER_HUBS = ['Bastille', 'Causeway', 'Dynamo', 'Escarp', 'Fulcrum', 'Girder', 'Halcyon', 'Isthmus', 'Junction', 'Keystone', 'Lodestone', 'Monolith'].map((s) => `Hub ${s}`);

function poolName(pool: string[], i: number): string { return i < pool.length ? pool[i] : `${pool[i % pool.length]} ${Math.floor(i / pool.length) + 1}`; }

/** Generate the 128 x 128 four-faction world with the central 64 x 64 laid out for the opening. */
export function generateWorldMap(seed: number, w: number, h: number): MapData {
  const rng = new Rng(seed ^ 0x5eed1234);
  for (let attempt = 1; attempt <= 12; attempt++) {
    const m = tryWorld(rng, seed >>> 0, w, h, attempt);
    if (m) { m.attempts = attempt; return m; }
  }
  throw new Error('map generation failed validation 12 times');
}

function tryWorld(rng: Rng, seed: number, w: number, h: number, attempt: number): MapData | null {
  const grid = new HexGrid(w, h);
  const n = grid.n;
  const terrain = new Uint8Array(n);
  const elev = new Uint8Array(n);
  const variant = new Uint8Array(n);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const center = grid.idx(Math.round(cx), Math.round(cy));
  const rp = riverParams(seed, w, h);
  // Base field and rivers exactly as the renderer samples them outside the theatre; the central plateau stays dry.
  for (let i = 0; i < n; i++) {
    const c = grid.col(i), r = grid.row(i);
    const b = sampleBaseTerrain(seed, c, r);
    terrain[i] = b.terrain; elev[i] = b.elev; variant[i] = b.variant;
    if (isRiver(rp, c, r) && grid.dist(i, center) > 3) { terrain[i] = T.RIVER; elev[i] = 0; }
  }
  // Marshy banks from a stable hash, kept off the outer band so the edge matches the endless scenery.
  const edgeDist = (t: number) => Math.min(grid.col(t), grid.row(t), w - 1 - grid.col(t), h - 1 - grid.row(t));
  for (let t = 0; t < n; t++) {
    if (terrain[t] !== T.RIVER) continue;
    for (let d = 0; d < 6; d++) {
      const v = grid.nb[t * 6 + d];
      if (v < 0 || terrain[v] === T.RIVER || terrain[v] === T.RIDGE || terrain[v] === T.MARSH || edgeDist(v) < 4) continue;
      if (hash2((seed ^ 0xba2c) >>> 0, grid.col(v), grid.row(v)) < 0.3) { terrain[v] = T.MARSH; elev[v] = 0; }
    }
  }
  // central plateau
  for (const t of grid.within(center, 3)) {
    terrain[t] = grid.dist(t, center) === 3 && rng.pct(45) ? T.RUIN : T.PLAINS;
    elev[t] = 2;
  }

  // Chunk geometry: the initially open square is chunks initialMin..initialMax on both axes.
  const cw = Math.floor(w / CHUNK);
  const chunkOf = (t: number) => Math.floor(grid.row(t) / CHUNK) * cw + Math.floor(grid.col(t) / CHUNK);
  const plan = frontierPlan(seed, w, h);
  const initialChunk = new Set(plan.initial);
  const innerMask = new Uint8Array(n);
  for (let t = 0; t < n; t++) if (initialChunk.has(chunkOf(t))) innerMask[t] = 1;

  // Crossings every 14 tiles along each river arm, measured from the map centre: the first two of each arm lie in
  // the initial square, the rest in frontier chunks. Retries jitter the positions.
  const bridges: BridgeSpec[] = [];
  const frontierBridges: Record<number, BridgeSpec[]> = {};
  const arms: { name: string; horizontal: boolean; sign: number }[] = [
    { name: 'N', horizontal: false, sign: -1 }, { name: 'S', horizontal: false, sign: 1 },
    { name: 'W', horizontal: true, sign: -1 }, { name: 'E', horizontal: true, sign: 1 },
  ];
  const SPACING = [10, 24, 38, 52];
  let innerBridges = 0, allBridges = 0;
  const armInner = [0, 0, 0, 0];
  arms.forEach((arm, ai) => {
    SPACING.forEach((d0, k) => {
      const d = d0 + (attempt > 1 ? rng.range(-3, 3) : 0);
      const along = (arm.horizontal ? cx : cy) + arm.sign * d;
      if (along < 2 || along > (arm.horizontal ? w : h) - 3) return;
      let best = -1, bestScore = Infinity;
      const lo = Math.max(0, Math.floor(along - 5)), hi = Math.min((arm.horizontal ? w : h) - 1, Math.ceil(along + 5));
      for (let a = lo; a <= hi; a++) {
        for (let b = 0; b < (arm.horizontal ? h : w); b++) {
          const t = arm.horizontal ? grid.idx(a, b) : grid.idx(b, a);
          if (terrain[t] !== T.RIVER) continue;
          const c = grid.col(t), r = grid.row(t);
          // stay on this arm's river: near its centre-line band, away from the other river's band
          if (arm.horizontal ? Math.abs(r - cy) > 8 || Math.abs(c - cx) < 8 : Math.abs(c - cx) > 8 || Math.abs(r - cy) < 8) continue;
          const score = Math.abs((arm.horizontal ? c : r) - along);
          if (score > 5) continue;
          // a clean crossing has land on both banks
          const nb = (dd: number) => grid.nb[t * 6 + dd];
          const land = (v: number) => v >= 0 && terrain[v] !== T.RIVER;
          const ok = arm.horizontal
            ? (land(nb(1)) || land(nb(2))) && (land(nb(4)) || land(nb(5)))
            : land(nb(0)) && land(nb(3));
          if (!ok) continue;
          // avoid double-thick river at the crossing
          let riverNbrs = 0;
          for (let dd = 0; dd < 6; dd++) { const v = nb(dd); if (v >= 0 && terrain[v] === T.RIVER) riverNbrs++; }
          if (riverNbrs > 2) continue;
          if (score < bestScore || (score === bestScore && t < best)) { best = t; bestScore = score; }
        }
      }
      if (best < 0) return;
      terrain[best] = T.CROSSING; elev[best] = 0;
      const spec = { tile: best, name: `Crossing ${arm.name}-${k + 1}` };
      allBridges++;
      if (innerMask[best]) { bridges.push(spec); innerBridges++; armInner[ai]++; }
      else (frontierBridges[chunkOf(best)] ??= []).push(spec);
    });
  });
  if (innerBridges < 6 || armInner.some((k) => k === 0) || allBridges < 12) return null;

  // Rivers are the only impassable terrain and are final now, so components decide where things may be placed.
  const compInner = components(grid, terrain, innerMask);
  const compAll = components(grid, terrain);
  const mainInner = compInner[center], mainAll = compAll[center];
  if (mainInner < 0 || mainAll < 0) return null;
  const innerOk = (t: number) => compInner[t] === mainInner;

  // Faction starts: four quadrants of the initial square, two command cores each, mirrored offsets.
  const IW = (FRONTIER.initialMax - FRONTIER.initialMin + 1) * CHUNK;
  const ih = (IW - 1) / 2;
  const quad = QUADS.map((q, f) => ({ f, sx: q.sx, sy: q.sy }));
  const taken = new Set<number>();
  const cores: CoreSpec[] = [];
  const sites: SiteSpec[] = [];
  const reserveEntry: number[] = [];
  const qp = (q: { sx: number; sy: number }, u: number, v: number): [number, number] => [cx + q.sx * (ih - u * IW), cy + q.sy * (ih - v * IW)];
  // clearings stay off the outer band (same rule as the marsh banks) so the edge keeps matching the endless scenery
  const clearAround = (t: number, rad: number) => {
    for (const v of grid.within(t, rad)) {
      if (terrain[v] === T.RIVER || terrain[v] === T.CROSSING || terrain[v] === T.ROAD || edgeDist(v) < 4) continue;
      terrain[v] = T.PLAINS; elev[v] = 1;
    }
  };
  for (const q of quad) {
    const [bx, by] = qp(q, 0.22, 0.24);
    const offs: [number, number][] = [[-4, 4], [5, -3]];
    for (let slot = 0; slot < offs.length; slot++) {
      const [ox, oy] = offs[slot];
      // mirrored: east factions flip the x offset, south factions flip the y offset
      const cc = bx + ox * (q.sx < 0 ? 1 : -1), rr = by + oy * (q.sy < 0 ? 1 : -1);
      const t = nearestLand(grid, terrain, taken, cc, rr, undefined, innerOk);
      if (t < 0) return null;
      clearAround(t, 3);
      taken.add(t);
      cores.push({ faction: q.f, slot, tile: t });
    }
    const [ex, ey] = qp(q, 0.07, 0.07);
    const entry = nearestLand(grid, terrain, taken, ex, ey, undefined, innerOk);
    if (entry < 0) return null;
    clearAround(entry, 1);
    reserveEntry[q.f] = entry;
  }
  // Faction-start resources: one mine beside each core, one refinery between the pair.
  for (const core of cores) {
    const q = quad[core.faction];
    const c = grid.col(core.tile), r = grid.row(core.tile);
    const dx = core.slot === 0 ? -2 : 2;
    const t = nearestLand(grid, terrain, taken, c + dx * (q.sx < 0 ? 1 : -1), r + 2 * (q.sy < 0 ? -1 : 1), undefined, innerOk);
    if (t < 0) return null;
    taken.add(t);
    sites.push({ kind: S.MINE, tile: t, name: '', faction: core.faction });
  }
  for (const q of quad) {
    const [bx, by] = qp(q, 0.22, 0.24);
    const t = nearestLand(grid, terrain, taken, bx, by, undefined, innerOk);
    if (t < 0) return null;
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
      const t = nearestLand(grid, terrain, taken, c, r, s.prefer, innerOk);
      if (t < 0) return null;
      taken.add(t);
      if (s.kind === S.HUB) clearAround(t, 1);
      sites.push({ kind: s.kind, tile: t, name: '', faction: -1 });
    }
    // ruin clusters
    for (const [u, v] of [[0.3, 0.16], [0.16, 0.3], [0.38, 0.22]] as const) {
      const [c, r] = qp(q, u, v);
      const t = nearestLand(grid, terrain, taken, c, r, undefined, innerOk);
      if (t < 0) continue;
      for (const x of grid.within(t, 1 + rng.int(2))) {
        if (taken.has(x) || !innerMask[x] || terrain[x] === T.RIVER || terrain[x] === T.CROSSING) continue;
        if (rng.pct(70)) { terrain[x] = T.RUIN; elev[x] = 1; }
      }
    }
  }
  sites.push({ kind: S.CITADEL, tile: center, name: 'Citadel Prime', faction: -1 });
  taken.add(center);

  // Roads connect cores, hubs, inner crossings and the citadel, inside the initial square only.
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
    for (const t of roadPath(grid, terrain, a, b, innerMask)) {
      if (taken.has(t) || terrain[t] === T.CROSSING || terrain[t] === T.RIVER) continue;
      terrain[t] = T.ROAD;
      if (elev[t] > 2) elev[t] = 2;
      if (elev[t] === 0) elev[t] = 1;
    }
  }

  // Validation (initial square): every core, the citadel, every site and reserve entry reachable over open tiles;
  // balanced starts.
  const targets = [...cores.map((c) => c.tile), center, ...sites.map((s) => s.tile), ...reserveEntry];
  if (!connected(grid, terrain, cores[0].tile, targets, innerMask)) return null;
  for (const q of quad) {
    const mine = cores.filter((c) => c.faction === q.f);
    const res = sites.filter((s) => s.faction === -1 && (s.kind === S.MINE || s.kind === S.REFINERY) && Math.min(...mine.map((c) => grid.dist(c.tile, s.tile))) <= 18).length;
    if (res < 2) return null;
  }

  // Frontier sites: generated for the NW chunk of each opening group and mirrored to the other three quadrants. A
  // site exists in all four quadrants or in none, so expansion stays balanced. Sites keep 3 hexes apart.
  const crowd = new Uint8Array(n);
  const markCrowd = (t: number) => { for (const v of grid.within(t, 2)) crowd[v] = 1; };
  for (const s of sites) markCrowd(s.tile);
  const frontierSites: Record<number, SiteSpec[]> = {};
  const ridge = (t: number) => t === T.RIDGE;
  for (const group of plan.groups) {
    const roll = rng.int(100);
    const count = roll < 30 ? 1 : roll < 78 ? 2 : 3;
    // retry fresh offsets when a mirrored placement fails, so every frontier chunk gets its 1-3 sites
    for (let placed = 0, tries = 0; placed < count && tries < count + 8; tries++) {
      const kr = rng.int(100);
      const kind = kr < 38 ? S.MINE : kr < 68 ? S.REFINERY : kr < 92 ? S.RELAY : S.HUB;
      const u = 3 + rng.int(CHUNK - 6), v = 3 + rng.int(CHUNK - 6);
      const tiles: number[] = [];
      for (let qi = 0; qi < QUADS.length; qi++) {
        const q = QUADS[qi], ci = group[qi];
        const c = (ci % cw) * CHUNK + (q.sx < 0 ? u : CHUNK - 1 - u);
        const r = Math.floor(ci / cw) * CHUNK + (q.sy < 0 ? v : CHUNK - 1 - v);
        const t = nearestLand(grid, terrain, taken, c, r, kind === S.RELAY ? ridge : undefined, (x) => chunkOf(x) === ci && compAll[x] === mainAll && !crowd[x]);
        if (t < 0) break;
        tiles.push(t);
      }
      if (tiles.length < QUADS.length) continue;
      placed++;
      tiles.forEach((t, qi) => {
        taken.add(t);
        markCrowd(t);
        if (kind === S.HUB) clearAround(t, 1);
        (frontierSites[group[qi]] ??= []).push({ kind, tile: t, name: '', faction: -1 });
      });
    }
  }
  // Validation (whole map open): every frontier site and crossing joins the same network as the citadel.
  const frontierTargets: number[] = [];
  for (const list of Object.values(frontierSites)) for (const s of list) frontierTargets.push(s.tile);
  for (const list of Object.values(frontierBridges)) for (const b of list) frontierTargets.push(b.tile);
  if (!connected(grid, terrain, center, [...targets, ...frontierTargets])) return null;

  // Deterministic names: inner sites by tile order, frontier sites in opening order (so names read in sequence).
  const nameKinds: [number, string[]][] = [[S.MINE, MINE_NAMES], [S.REFINERY, REFINERY_NAMES], [S.RELAY, RELAY_NAMES], [S.HUB, HUB_NAMES]];
  for (const [kind, names] of nameKinds) {
    sites.filter((s) => s.kind === kind).sort((a, b) => a.tile - b.tile).forEach((s, i) => { s.name = names[i % names.length]; });
  }
  const counter = new Map<number, number>();
  const frontierName = (kind: number): string => {
    const i = counter.get(kind) ?? 0;
    counter.set(kind, i + 1);
    switch (kind) {
      case S.MINE: return poolName(FRONTIER_MINES, i);
      case S.REFINERY: return poolName(FRONTIER_REACTORS, i);
      case S.RELAY: return `Relay ${17 + i}`;
      default: return poolName(FRONTIER_HUBS, i);
    }
  };
  for (const group of plan.groups) for (const ci of group) for (const s of frontierSites[ci] ?? []) s.name = frontierName(s.kind);
  return { w, h, seed, terrain, elev, variant, sites, cores, reserveEntry, bridges, frontierSites, frontierBridges, attempts: 0 };
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
    reserveEntry: [a, b], bridges: [], frontierSites: {}, frontierBridges: {}, attempts: 1,
  };
}
