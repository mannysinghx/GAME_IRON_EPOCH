// Cached Dijkstra flow fields keyed by destination tile and passability variant.
// Squads sharing a destination share one field; the cache is bounded (design doc §14.1).

import type { HexGrid } from '../shared/hex.ts';

export const INF = 0x3fffffff;

export class FlowCache {
  private readonly grid: HexGrid;
  private readonly cost: Uint8Array;
  private readonly blockedB: Uint8Array;
  private cache = new Map<number, Int32Array>();
  private readonly cap: number;
  hits = 0;
  misses = 0;
  // heap scratch
  private heapT: Int32Array;
  private heapD: Int32Array;

  constructor(grid: HexGrid, cost: Uint8Array, regionBlock: Uint8Array, cap = 192) {
    this.grid = grid;
    this.cost = cost;
    this.blockedB = regionBlock;
    this.cap = cap;
    this.heapT = new Int32Array(grid.n * 6 + 8);
    this.heapD = new Int32Array(grid.n * 6 + 8);
  }

  get size(): number { return this.cache.size; }

  clear(): void { this.cache.clear(); }

  /** variant 0 = normal passability; 1 = sealed operation region treated as impassable */
  field(target: number, variant: number): Int32Array {
    const key = target * 2 + variant;
    const hit = this.cache.get(key);
    if (hit) {
      this.hits++;
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    this.misses++;
    const f = this.compute([target], variant);
    this.cache.set(key, f);
    if (this.cache.size > this.cap) {
      const first = this.cache.keys().next().value as number;
      this.cache.delete(first);
    }
    return f;
  }

  /** Multi-source field, not cached (used for evacuation and supply distance). */
  compute(sources: number[], variant: number): Int32Array {
    const g = this.grid;
    const dist = new Int32Array(g.n).fill(INF);
    const hT = this.heapT, hD = this.heapD;
    let size = 0;
    const push = (t: number, d: number) => {
      let i = size++;
      hT[i] = t; hD[i] = d;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hD[p] <= hD[i]) break;
        const tt = hT[p], td = hD[p]; hT[p] = hT[i]; hD[p] = hD[i]; hT[i] = tt; hD[i] = td;
        i = p;
      }
    };
    const pop = () => {
      const t = hT[0];
      size--;
      if (size > 0) {
        hT[0] = hT[size]; hD[0] = hD[size];
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < size && hD[l] < hD[m]) m = l;
          if (r < size && hD[r] < hD[m]) m = r;
          if (m === i) break;
          const tt = hT[m], td = hD[m]; hT[m] = hT[i]; hD[m] = hD[i]; hT[i] = tt; hD[i] = td;
          i = m;
        }
      }
      return t;
    };
    for (const s of sources) { dist[s] = 0; push(s, 0); }
    const cost = this.cost, block = this.blockedB, nb = g.nb;
    while (size > 0) {
      const d0 = hD[0];
      const u = pop();
      if (d0 > dist[u]) continue;
      // cost of entering u is paid when moving from v into u, so walk outward with cost[u]
      const cu = cost[u] || 10;
      for (let k = 0; k < 6; k++) {
        const v = nb[u * 6 + k];
        if (v < 0) continue;
        if (cost[v] === 0) continue;
        if (variant === 1 && block[v]) continue;
        const nd = d0 + cu;
        if (nd < dist[v]) { dist[v] = nd; push(v, nd); }
      }
    }
    return dist;
  }
}
