// The authoritative world: fixed 5 Hz ticks, integer combat and economy, stable id ordering,
// seeded randomness. Spectator views are derived from this state; nothing here reads UI input
// except spectator ledger commands, which never touch battle state.

import {
  CHUNK, CLOCK, DMG_MATRIX, FACTIONS, FRONTIER, MAP_H, MAP_W, NEUTRAL_MODS, POP, RULES_VERSION, S, STRUCTS, T, TERRAIN, U, UNITS,
  type FactionMods,
} from '../shared/config.ts';
import { HexGrid } from '../shared/hex.ts';
import { FNV_SEED, Rng, fnv, hex32 } from '../shared/rng.ts';
import { FX, STRUCT_ID_BASE } from '../shared/protocol.ts';
import type { PolicySnapshot } from '../shared/protocol.ts';
import { frontierPlan, generateDuelMap, generateWorldMap, type FrontierPlan, type MapData } from './mapgen.ts';
import { FlowCache, INF } from './pathing.ts';
import {
  TASK, type ChronEntry, type Commander, type EvalRecord, type FactionState, type LedgerState, type Market, type Npc,
  type Operation, type Series, type Squad, type Struct, type Team, type Treaty, type Wallet, type Weather,
} from './types.ts';
import { runOperational, runStrategic, noteLoss, makeCommander } from './agents.ts';
import { foundingMuster, clockEvents, onCoreDestroyed, emergencyCheck, frontierMuster } from './society.ts';
import { tickOperations } from './operations.ts';
import { tickMarkets, initMarkets } from './market.ts';
import { Ledger } from './ledger.ts';

export type Mode = 'world' | 'duel';

interface Shell { impact: number; tile: number; dmg: number; owner: number; faction: number; primary: number }

const BUCKET = 8; // spatial bucket edge for squad proximity queries (unrelated to frontier chunks)

export class World {
  readonly mode: Mode;
  readonly grid: HexGrid;
  readonly map: MapData;
  readonly worldId: string;
  readonly seed: number;
  terrain: Uint8Array;
  elev: Uint8Array;
  moveCost: Uint8Array;
  owner: Int16Array;
  ownerF: Int8Array;
  capCmd: Int16Array;
  capProg: Uint8Array;
  decay: Uint8Array;
  regionMask: Uint8Array;
  occupancy: Uint8Array;
  nearMask: Uint8Array;
  /** 1 = tile lies in an open chunk. Closed tiles are visible land but impassable, unownable and never targeted. */
  active: Uint8Array;
  chunksOpen: number[] = [];
  /** Tick each chunk opened (-1 = initial or still closed); commanders treat recently opened land as new ground. */
  chunkOpenTick: Int32Array;
  frontierVersion = 0;
  nextFrontierTick = -1;
  /** Opening schedule regenerated from the seed (world mode only). */
  readonly frontier: FrontierPlan | null;

  tick = 0;
  nextId = 1;
  nextCmdId = 1;
  learning = true;
  rng: Rng;
  marketRng: Rng;
  squads: Squad[] = [];
  structs: Struct[] = [];
  cmds: Commander[] = [];
  factions: FactionState[] = [];
  teams: Team[] = [];
  treaties: Treaty[] = [];
  ops: Operation[] = [];
  markets: Market[] = [];
  ledger: Ledger;
  npcs: Npc[] = [];
  wallet!: Wallet;
  weather: Weather[] = [];
  chronicle: ChronEntry[] = [];
  chronId = 1;
  series: Series;
  evals: EvalRecord[] = [];
  evalCounter = 0;
  decisionCounter = 0;
  opCounter = 0;
  usedNames: string[] = [];
  generation = 0;
  narrative: string[] = [];
  battleHeat: Map<number, number> = new Map();

  // transient (rebuilt on load)
  flow: FlowCache;
  squadById = new Map<number, Squad>();
  structById = new Map<number, Struct>();
  cmdById = new Map<number, Commander>();
  bucketHead: Int32Array;
  bucketNext: Int32Array = new Int32Array(0);
  war: Uint8Array = new Uint8Array(16);
  rosterSet = new Set<number>();
  regionActive = false;
  regionOpId = -1; // operation whose region is sealed (derived from ops; see operations.ts syncRegion)
  fx: number[] = [];
  recordFx = true;
  territoryDirty = true;
  supplyDirty = true;
  bridgeVersion = 0;
  shells: Shell[] = [];
  stateHash = 0;
  hashHist: { tick: number; hash: string }[] = [];
  perf = { visMs: 0, agentMs: 0 };
  storms: { tile: number; radius: number }[] = [];
  jam: Uint8Array;
  deathsWindow: number[] = [];

  constructor(mode: Mode, seed: number, duel?: { a: PolicySnapshot; b: PolicySnapshot }) {
    this.mode = mode;
    this.seed = seed >>> 0;
    this.map = mode === 'world' ? generateWorldMap(this.seed, MAP_W, MAP_H) : generateDuelMap(this.seed);
    this.worldId = mode === 'world' ? `world-${hex32(this.seed).slice(0, 6)}` : `duel-${hex32(this.seed)}`;
    this.grid = new HexGrid(this.map.w, this.map.h);
    const n = this.grid.n;
    this.terrain = this.map.terrain.slice();
    this.elev = this.map.elev.slice();
    this.moveCost = new Uint8Array(n);
    this.owner = new Int16Array(n).fill(-1);
    this.ownerF = new Int8Array(n).fill(-1);
    this.capCmd = new Int16Array(n).fill(-1);
    this.capProg = new Uint8Array(n);
    this.decay = new Uint8Array(n);
    this.regionMask = new Uint8Array(n);
    this.occupancy = new Uint8Array(n);
    this.nearMask = new Uint8Array(n);
    this.jam = new Uint8Array(n);
    this.capF = new Int8Array(n); this.capC = new Int16Array(n); this.capR = new Uint8Array(n); this.capX = new Uint8Array(n);
    this.active = new Uint8Array(n);
    this.chunkOpenTick = new Int32Array(Math.ceil(this.map.w / CHUNK) * Math.ceil(this.map.h / CHUNK)).fill(-1);
    if (mode === 'world') {
      this.frontier = frontierPlan(this.seed, this.map.w, this.map.h);
      for (const ci of this.frontier.initial) this.markChunk(ci);
      this.chunksOpen = this.frontier.initial.slice();
      this.nextFrontierTick = FRONTIER.firstAt;
    } else {
      this.frontier = null;
      this.active.fill(1);
    }
    this.bucketHead = new Int32Array(Math.ceil(this.map.w / BUCKET) * Math.ceil(this.map.h / BUCKET));
    this.rng = new Rng(this.seed);
    this.marketRng = new Rng(this.seed ^ 0x6d61726b);
    this.ledger = new Ledger();
    this.flow = new FlowCache(this.grid, this.moveCost, this.regionMask);
    this.series = { version: 0, ticks: [], territory: [[], [], [], []], power: [[], [], [], []], squads: [[], [], [], []], kills: [[], [], [], []], learnErr: [], reward: [] };
    this.recordFx = mode === 'world';

    const nf = mode === 'world' ? 4 : 2;
    for (let f = 0; f < nf; f++) {
      this.factions.push({
        id: f, lastSeen: new Int32Array(n).fill(-1), knownOwner: new Int8Array(n).fill(-1), visible: new Uint8Array(n),
        inSupply: new Uint8Array(n), supplyDist: new Int16Array(n).fill(99), ghosts: [], intel: [], hostility: [0, 0, 0, 0], trust: [50, 50, 50, 50],
        capBonus: 0, citadel: false, kills: 0, losses: 0, reserveEntry: this.map.reserveEntry[f], powerHist: [],
      });
    }
    // sites & bridges
    for (const s of this.map.sites) {
      const st = this.addStruct(s.kind, s.tile, -1, s.name || STRUCTS[s.kind].name, true);
      void st;
    }
    for (const b of this.map.bridges) this.addStruct(S.BRIDGE, b.tile, -1, b.name, true);
    this.rebuildMoveCost();
    this.rebuildWar();

    if (mode === 'world') {
      this.wallet = { name: 'You', acct: -1, grantLastCampaign: -1, bets: 0, wins: 0, losses: 0, refunds: 0, net: 0, receipts: [], netHist: [] };
      foundingMuster(this);
      initMarkets(this);
      this.log('chapter', `Chapter I opens. ${this.cmds.length} founding commanders muster across four factions on ${this.worldId}.`, -1, [], -1);
    } else if (duel) {
      this.wallet = { name: 'eval', acct: -1, grantLastCampaign: -1, bets: 0, wins: 0, losses: 0, refunds: 0, net: 0, receipts: [], netHist: [] };
      const sides = [duel.a, duel.b];
      this.map.cores.forEach((core, i) => {
        const p = sides[i];
        const c = makeCommander(this, { faction: i, name: p.name, doctrine: p.doctrine.slice(), gen: 1, parents: [], birthKind: 'evaluation' });
        c.lw = p.weights.slice();
        c.id = p.id; // keep identity for results
        this.cmdById.clear();
        this.cmds.forEach((x) => this.cmdById.set(x.id, x));
        this.deployCommander(c, core.tile, 'duel');
      });
      // sites start neutral; starting mines belong to each side
      for (const st of this.structs) {
        const site = this.map.sites.find((s) => s.tile === st.tile);
        if (site && site.faction >= 0) {
          const c = this.cmds[site.faction];
          this.setOwner(st.tile, c.id);
          st.owner = c.id; st.faction = c.faction;
        }
      }
    }
    this.updateVisibility();
    this.updateSupply();
  }

  // ------------------------------------------------------------------ helpers
  id(): number { return this.nextId++; }

  mods(f: number): FactionMods { return this.mode === 'world' && f >= 0 && f < 4 ? FACTIONS[f].mods : NEUTRAL_MODS; }

  log(cat: string, text: string, f: number, a: number[], tile: number): void {
    if (this.mode !== 'world') return;
    this.chronicle.push({ id: this.chronId++, tick: this.tick, cat, text, f, a, tile });
    if (this.chronicle.length > 1600) this.chronicle.splice(0, this.chronicle.length - 1600);
    if (cat !== 'market' && cat !== 'policy' && cat !== 'eval') {
      this.narrative.push(text);
      if (this.narrative.length > 12) this.narrative.shift();
    }
  }

  emit(kind: number, a: number, b: number, f: number, p1 = 0, p2 = 0): void {
    if (!this.recordFx) return;
    if (this.fx.length > 6 * 1200) return;
    this.fx.push(kind, a, b, f, p1, p2);
  }

  cmdName(id: number): string {
    const c = this.cmdById.get(id);
    return c ? c.name : 'unknown';
  }

  siteName(tile: number): string {
    let best: Struct | null = null, bd = 99;
    for (const s of this.structs) {
      if (!s.name || s.kind === S.DEPOT || s.kind === S.TOWER || s.kind === S.BUNKER) continue;
      const d = this.grid.dist(s.tile, tile);
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) return `hex ${this.grid.col(tile)},${this.grid.row(tile)}`;
    return bd === 0 ? best.name : `near ${best.name}`;
  }

  rebuildMoveCost(): void {
    const n = this.grid.n;
    // closed frontier tiles cost 0 (impassable), so every passability check also excludes them
    for (let i = 0; i < n; i++) this.moveCost[i] = this.active[i] ? TERRAIN[this.terrain[i]].cost : 0;
    for (const s of this.structs) if (s.kind === S.BRIDGE && s.broken) this.moveCost[s.tile] = 0;
    this.flow.clear();
    // the evacuation field depends on move costs; dropping it keeps it a pure function of state (save/restore)
    this.evacField = null;
    this.bridgeVersion++;
  }

  // ------------------------------------------------------------------ frontier (design doc §3.4)
  chunkCount(): number { return this.frontier ? this.frontier.cw * this.frontier.ch : 0; }

  chunkOf(t: number): number {
    const cw = Math.ceil(this.map.w / CHUNK);
    return Math.floor(this.grid.row(t) / CHUNK) * cw + Math.floor(this.grid.col(t) / CHUNK);
  }

  private markChunk(ci: number): void {
    const cw = Math.ceil(this.map.w / CHUNK);
    const c0 = (ci % cw) * CHUNK, r0 = Math.floor(ci / cw) * CHUNK;
    const c1 = Math.min(this.map.w, c0 + CHUNK), r1 = Math.min(this.map.h, r0 + CHUNK);
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) this.active[r * this.map.w + c] = 1;
  }

  /** True for a chunk outside the initially open square. */
  isFrontierChunk(ci: number): boolean { return !!this.frontier && !this.frontier.initial.includes(ci); }

  /** Tile in a frontier chunk opened within the last two expansion intervals (new ground for planning). */
  recentFrontier(t: number): boolean {
    if (!this.frontier) return false;
    const at = this.chunkOpenTick[this.chunkOf(t)];
    return at >= 0 && this.tick - at < 2 * FRONTIER.interval;
  }

  /** Chunks opened by the most recent frontier event (empty before the first). */
  lastOpenedChunks(): number[] {
    if (!this.frontier) return [];
    const extra = this.chunksOpen.length - this.frontier.initial.length;
    return extra > 0 ? this.chunksOpen.slice(-Math.min(extra, Math.max(4, FRONTIER.perEvent))) : [];
  }

  chunkName(ci: number): string { return this.frontier?.names[ci] ?? `chunk ${ci}`; }

  /** Population limits grow with open land (initial 16 chunks → launch target of 24 active at 64 chunks). */
  activeCap(): number {
    if (!this.frontier) return POP.ACTIVE_CAP;
    const extra = Math.max(0, this.chunksOpen.length - this.frontier.initial.length);
    return Math.min(POP.ACTIVE_MAX, POP.ACTIVE_CAP + Math.floor(extra / 4));
  }

  factionCapBase(): number {
    if (!this.frontier) return POP.FACTION_CAP;
    const extra = Math.max(0, this.chunksOpen.length - this.frontier.initial.length);
    return Math.min(POP.FACTION_MAX, POP.FACTION_CAP + Math.floor(extra / 12));
  }

  factionCap(f: number): number { return this.factionCapBase() + (this.factions[f]?.capBonus ?? 0); }

  /** Open one chunk: tiles become playable, its sites and crossings become structures. Idempotent. */
  openChunk(ci: number): void {
    if (!this.frontier || this.chunksOpen.includes(ci) || ci < 0 || ci >= this.chunkCount()) return;
    this.markChunk(ci);
    this.chunksOpen.push(ci);
    this.chunkOpenTick[ci] = this.tick;
    const sites: string[] = [], crossings: string[] = [];
    for (const s of this.map.frontierSites[ci] ?? []) { this.addStruct(s.kind, s.tile, -1, s.name || STRUCTS[s.kind].name, true); sites.push(s.name); }
    for (const b of this.map.frontierBridges[ci] ?? []) { this.addStruct(S.BRIDGE, b.tile, -1, b.name, true); crossings.push(b.name); }
    this.rebuildMoveCost();
    this.territoryDirty = true;
    this.supplyDirty = true;
    this.frontierVersion++;
    const cw = this.frontier.cw;
    const centre = this.grid.idx((ci % cw) * CHUNK + (CHUNK >> 1), Math.floor(ci / cw) * CHUNK + (CHUNK >> 1));
    const what = [sites.length ? `new sites: ${sites.join(', ')}` : 'open ground, no sites', crossings.length ? `crossings: ${crossings.join(', ')}` : ''].filter(Boolean).join('; ');
    this.log('frontier', `Frontier opened: ${this.chunkName(ci)} — ${what} (${this.chunksOpen.length}/${this.chunkCount()} chunks open).`, -1, [], centre);
  }

  /** Scheduled expansion: FRONTIER.perEvent chunks, one per quadrant at mirrored positions, nearest ring first. */
  frontierStep(): void {
    const plan = this.frontier;
    if (!plan || this.chunksOpen.length >= this.chunkCount()) { this.nextFrontierTick = -1; return; } // budget notice is logged once
    const groups = Math.max(1, Math.round(FRONTIER.perEvent / 4));
    let opened = 0;
    for (const g of plan.groups) {
      if (opened >= groups) break;
      if (g.every((ci) => this.chunksOpen.includes(ci))) continue;
      for (const ci of g) this.openChunk(ci);
      opened++;
    }
    if (this.chunksOpen.length >= this.chunkCount()) {
      this.nextFrontierTick = -1;
      this.log('frontier', `All ${this.chunkCount()} chunks are open: the ${this.map.w} x ${this.map.h} launch budget for the active world is reached. Further growth would need frontier archiving — retiring settled chunks once their units evacuate and contracts settle (design §3.4).`, -1, [], -1);
    } else {
      this.nextFrontierTick += FRONTIER.interval;
    }
    if (!opened) return;
    // new land: commanders reconsider soon (event review, quota-limited), and eligible reserves muster onto it
    for (const c of this.cmds) {
      if (c.status === 'active' && this.tick - c.lastReview > CLOCK.REVIEW_QUOTA) c.nextStrategic = Math.min(c.nextStrategic, this.tick + 10 + (c.id % 30));
    }
    frontierMuster(this);
  }

  rebuildWar(): void {
    this.war.fill(0);
    const nf = this.factions.length;
    for (let a = 0; a < nf; a++) for (let b = 0; b < nf; b++) if (a !== b) this.war[a * 4 + b] = 1;
    for (const t of this.treaties) {
      if (t.status === 'ended') continue;
      this.war[t.a * 4 + t.b] = 0; this.war[t.b * 4 + t.a] = 0;
    }
  }

  atWar(fa: number, fb: number): boolean { return fa >= 0 && fb >= 0 && fa !== fb && this.war[fa * 4 + fb] === 1; }

  sealedFor(cmdId: number): boolean { return this.regionActive && !this.rosterSet.has(cmdId); }

  setOwner(t: number, cmdId: number): void {
    if (cmdId >= 0 && !this.active[t]) return; // closed frontier land cannot be owned
    const prevF = this.ownerF[t];
    this.owner[t] = cmdId;
    const f = cmdId >= 0 ? (this.cmdById.get(cmdId)?.faction ?? -1) : -1;
    this.ownerF[t] = f;
    this.decay[t] = 0;
    if (prevF !== f) this.territoryDirty = true;
  }

  addStruct(kind: number, tile: number, ownerId: number, name: string, complete: boolean): Struct {
    const def = STRUCTS[kind];
    const f = ownerId >= 0 ? (this.cmdById.get(ownerId)?.faction ?? -1) : -1;
    const hpMod = f >= 0 ? 100 + this.mods(f).structHp : 100;
    const maxHp = Math.max(0, Math.floor((def.hp * hpMod) / 100));
    const st: Struct = {
      id: this.id(), kind, tile, owner: ownerId, faction: f, hp: complete ? maxHp : Math.max(1, maxHp >> 4), maxHp,
      built: complete ? def.build : 0, need: def.build, name, cd: 0, broken: false, hitBy: -1,
    };
    this.structs.push(st);
    this.structById.set(st.id, st);
    return st;
  }

  structAt(tile: number, kind?: number): Struct | undefined {
    for (const s of this.structs) if (s.tile === tile && (kind === undefined || s.kind === kind)) return s;
    return undefined;
  }

  isBuilt(s: Struct): boolean { return s.built >= s.need; }

  spawnSquad(c: Commander, cls: number, tile: number): Squad | null {
    let at = tile;
    if (this.moveCost[at] === 0 || this.occupancy[at] >= 3) {
      for (const t of this.grid.within(tile, 2)) {
        if (this.moveCost[t] > 0 && this.occupancy[t] < 2) { at = t; break; }
      }
    }
    const def = UNITS[cls];
    const sq: Squad = {
      id: this.id(), cls, owner: c.id, faction: c.faction, tile: at, next: -1, prog: 0,
      hp: def.hp, maxHp: def.hp, supply: 100, morale: 100, supp: 0, cd: 0, task: TASK.IDLE, tgt: at, tgtStruct: -1, buildKind: -1,
      retreat: false, combatT: -999, kills: 0, born: this.tick, lastTarget: -1, setup: 0, stuck: 0, group: 0, hitBy: -1, engageT: -999,
    };
    this.squads.push(sq);
    this.squadById.set(sq.id, sq);
    this.occupancy[at]++;
    this.emit(FX.SPAWN, at, cls, c.faction);
    return sq;
  }

  /** Place a commander's command core and starter forces. */
  deployCommander(c: Commander, tile: number, kind: string): void {
    const core = this.addStruct(S.CORE, tile, c.id, `${c.name} Core`, true);
    core.faction = c.faction;
    c.coreId = core.id;
    c.homeTile = tile;
    c.status = 'active';
    for (const t of this.grid.within(tile, kind === 'reconstruction' ? 2 : 4)) {
      const of = this.ownerF[t];
      if (this.moveCost[t] === 0) continue;
      if (of === -1 || of === c.faction) {
        const st = this.structAt(t);
        if (st && STRUCTS[st.kind].capturable && st.owner >= 0) continue;
        this.setOwner(t, c.id);
        // sites inside the starting footprint belong to the commander (home mines, refinery)
        if (st && STRUCTS[st.kind].capturable && st.kind !== S.CITADEL) { st.owner = c.id; st.faction = c.faction; }
      }
    }
    const starter = kind === 'duel'
      ? [U.RIFLE, U.RIFLE, U.RIFLE, U.SCOUT, U.WALKER, U.ENGINEER, U.ARTILLERY]
      : kind === 'founding' ? [U.RIFLE, U.RIFLE, U.RIFLE, U.SCOUT, U.ENGINEER, U.WALKER] : [U.RIFLE, U.RIFLE, U.RIFLE, U.SCOUT, U.ENGINEER];
    for (const cls of starter) this.spawnSquad(c, cls, tile);
    c.res = kind === 'duel' ? { alloy: 400, energy: 200, supply: 200 } : { alloy: 300, energy: 160, supply: 160 };
    c.nextStrategic = this.tick + 5 + (c.id % 7);
    c.nextOperational = this.tick + 2 + (c.id % 5);
    this.territoryDirty = true;
  }

  // ------------------------------------------------------------------ the tick
  step(): void {
    this.tick++;
    const tick = this.tick;
    if (tick % CLOCK.VIS === 0) {
      const t0 = now();
      this.updateVisibility();
      this.perf.visMs = this.perf.visMs * 0.9 + (now() - t0) * 0.1;
    }
    if (tick % CLOCK.SUPPLY === 0) this.updateSupply();

    const ta = now();
    for (const c of this.cmds) {
      if (c.status !== 'active') continue;
      if (tick >= c.nextStrategic) runStrategic(this, c, 'scheduled');
      if (tick >= c.nextOperational) runOperational(this, c);
    }
    this.perf.agentMs = this.perf.agentMs * 0.95 + (now() - ta) * 0.05;

    this.production();
    this.movement();
    this.rebuildBuckets();
    this.combat();
    this.resolveDeaths();
    this.rebuildBuckets();
    if (tick % CLOCK.CAPTURE === 0) { this.capture(); this.squadUpkeepTick(); }
    if (tick % CLOCK.DECAY === 0) this.territoryDecay();
    if (tick % CLOCK.ECON === 0) this.economy();

    if (this.mode === 'world') {
      if (this.nextFrontierTick > 0 && tick >= this.nextFrontierTick) this.frontierStep();
      tickOperations(this);
      tickMarkets(this);
      clockEvents(this);
      if (tick % 25 === 0) emergencyCheck(this);
      if (tick % CLOCK.SAMPLE === 0) this.sample();
    } else {
      tickOperations(this);
    }
    if (tick % 25 === 0) this.hashState();
  }

  // ------------------------------------------------------------------ visibility & knowledge
  updateVisibility(): void {
    const g = this.grid;
    const elev = this.elev, terrain = this.terrain;
    // jam field from Veil-owned relays
    this.jam.fill(0);
    for (const s of this.structs) {
      if (s.kind === S.RELAY && s.faction >= 0 && this.mods(s.faction).jam > 0) {
        for (const t of g.within(s.tile, 4)) this.jam[t] |= 1 << s.faction;
      }
    }
    const tmp: number[] = [];
    for (const fs of this.factions) {
      const vis = fs.visible;
      vis.fill(0);
      const f = fs.id;
      const mark = (tile: number, sight: number) => {
        const obsElev = elev[tile];
        const blocks = (t: number) => elev[t] > obsElev || (TERRAIN[terrain[t]].blocks && elev[t] >= obsElev);
        tmp.length = 0;
        g.within(tile, sight, tmp);
        for (const t of tmp) {
          if (vis[t]) continue;
          if (g.dist(tile, t) <= 1 || g.los(tile, t, blocks)) vis[t] = 1;
        }
      };
      for (const s of this.squads) {
        if (s.faction !== f) continue;
        let sight = UNITS[s.cls].sight + this.mods(f).sight + TERRAIN[terrain[s.tile]].sight + (elev[s.tile] >= 2 ? 1 : 0);
        if (this.inStorm(s.tile)) sight -= 2;
        if (this.jam[s.tile] & ~(1 << f)) sight -= 2;
        mark(s.tile, Math.max(1, Math.min(10, sight)));
      }
      for (const st of this.structs) {
        if (st.faction !== f || !this.isBuilt(st) || st.broken) continue;
        const sight = STRUCTS[st.kind].sight;
        if (sight > 0) mark(st.tile, sight);
      }
      // knowledge update
      const tick = this.tick;
      for (let t = 0; t < g.n; t++) {
        if (vis[t]) { fs.lastSeen[t] = tick; fs.knownOwner[t] = this.ownerF[t]; }
      }
      // ghosts: remembered enemy squads
      const ghosts = fs.ghosts;
      for (let i = ghosts.length - 1; i >= 0; i--) {
        const gh = ghosts[i];
        const live = this.squadById.get(gh.id);
        if (tick - gh.tick > 900 || (vis[gh.tile] && (!live || live.tile !== gh.tile))) ghosts.splice(i, 1);
      }
      for (const s of this.squads) {
        if (s.faction === f || !vis[s.tile]) continue;
        const gh = ghosts.find((x) => x.id === s.id);
        if (gh) { gh.tile = s.tile; gh.tick = tick; gh.cls = s.cls; }
        else if (ghosts.length < 64) ghosts.push({ id: s.id, tile: s.tile, cls: s.cls, faction: s.faction, tick });
      }
      // structure intel: enemy cores, depots, bunkers seen at least once
      const intel = fs.intel;
      for (let i = intel.length - 1; i >= 0; i--) {
        const it = intel[i];
        if (!vis[it.tile]) continue;
        const st = this.structById.get(it.id);
        if (!st || st.hp <= 0 || st.faction !== it.faction) intel.splice(i, 1);
      }
      for (const st of this.structs) {
        if (st.faction < 0 || st.faction === f || !vis[st.tile] || STRUCTS[st.kind].capturable || st.kind === S.BRIDGE) continue;
        const it = intel.find((x) => x.id === st.id);
        if (it) it.tick = tick;
        else if (intel.length < 48) intel.push({ id: st.id, kind: st.kind, tile: st.tile, faction: st.faction, tick });
      }
    }
  }

  inStorm(tile: number): boolean {
    for (const s of this.storms) if (this.grid.dist(s.tile, tile) <= s.radius) return true;
    return false;
  }

  // ------------------------------------------------------------------ supply network
  updateSupply(): void {
    const g = this.grid;
    const n = g.n;
    // contested tiles: hostile squads present
    const hostileAt = new Uint8Array(n);
    for (const s of this.squads) hostileAt[s.tile] |= 1 << s.faction;
    const budget = new Int16Array(n);
    const buckets: number[][] = Array.from({ length: 16 }, () => []);
    for (const fs of this.factions) {
      const f = fs.id;
      const hm = this.hostileMask(f);
      const sup = fs.inSupply;
      sup.fill(0);
      budget.fill(-1);
      for (const b of buckets) b.length = 0;
      for (const st of this.structs) {
        if (st.faction !== f || st.broken || !this.isBuilt(st)) continue;
        const r = Math.min(15, STRUCTS[st.kind].supplyRadius);
        if (r > 0 && r > budget[st.tile]) { budget[st.tile] = r; buckets[r].push(st.tile); }
      }
      // bucket queue: highest remaining budget first; supply flows only through own, uncontested territory
      for (let b = 15; b >= 0; b--) {
        const list = buckets[b];
        for (let i = 0; i < list.length; i++) {
          const u = list[i];
          if (budget[u] !== b) continue;
          sup[u] = 1;
          if (b === 0) continue;
          for (let k = 0; k < 6; k++) {
            const v = g.nb[u * 6 + k];
            if (v < 0 || this.moveCost[v] === 0 || this.ownerF[v] !== f) continue;
            if (hostileAt[v] & hm) continue;
            const tt = this.terrain[v];
            const nbud = b - (tt === T.FOREST || tt === T.MARSH ? 2 : tt === T.RIDGE ? 3 : 1);
            if (nbud >= 0 && nbud > budget[v]) { budget[v] = nbud; buckets[nbud].push(v); }
          }
        }
      }
      // distance to the supply network for planning (BFS over passable tiles, capped)
      const sd = fs.supplyDist;
      sd.fill(99);
      const q2: number[] = [];
      for (let t = 0; t < n; t++) if (sup[t]) { sd[t] = 0; q2.push(t); }
      for (let qi = 0; qi < q2.length; qi++) {
        const u = q2[qi];
        if (sd[u] >= 30) continue;
        for (let k = 0; k < 6; k++) {
          const v = g.nb[u * 6 + k];
          if (v < 0 || this.moveCost[v] === 0 || sd[v] <= sd[u] + 1) continue;
          sd[v] = sd[u] + 1; q2.push(v);
        }
      }
    }
    this.supplyDirty = true;
  }

  hostileMask(f: number): number {
    let m = 0;
    for (let o = 0; o < this.factions.length; o++) if (this.atWar(f, o)) m |= 1 << o;
    return m;
  }

  // ------------------------------------------------------------------ production & construction
  production(): void {
    for (const c of this.cmds) {
      if (c.status !== 'active' || c.queue.length === 0) continue;
      const head = c.queue[0];
      head.left--;
      if (head.left <= 0) {
        c.queue.shift();
        const core = this.structById.get(c.coreId);
        if (!core) continue;
        let at = core.tile;
        // forward production at an owned, supplied fabrication hub closer to the plan target
        if (c.plan) {
          for (const s of this.structs) {
            if (s.kind !== S.HUB || s.owner !== c.id || !this.factions[c.faction].inSupply[s.tile]) continue;
            if (this.grid.dist(s.tile, c.plan.tile) + 4 < this.grid.dist(at, c.plan.tile)) at = s.tile;
          }
        }
        if (this.squads.filter((s) => s.owner === c.id).length < POP.SQUADS_PER_CMD) {
          this.spawnSquad(c, head.cls, at);
          c.stats.produced++;
        }
      }
    }
    // construction & repair by engineers
    for (const s of this.squads) {
      if (s.task !== TASK.BUILD && s.task !== TASK.REPAIR) continue;
      if (this.grid.dist(s.tile, s.tgt) > 1 || s.next >= 0) continue;
      if (this.tick - s.combatT < 6) continue;
      if (s.task === TASK.BUILD) {
        let st = s.tgtStruct >= 0 ? this.structById.get(s.tgtStruct) : undefined;
        if (!st) {
          if (this.structAt(s.tgt)) { s.task = TASK.IDLE; continue; }
          const c = this.cmdById.get(s.owner)!;
          st = this.addStruct(s.buildKind, s.tgt, c.id, '', false);
          st.faction = c.faction;
          s.tgtStruct = st.id;
        }
        st.built += 1;
        st.hp = Math.min(st.maxHp, st.hp + Math.ceil(st.maxHp / st.need));
        if (st.built >= st.need) {
          st.hp = st.maxHp;
          s.task = TASK.IDLE; s.tgtStruct = -1;
          const c = this.cmdById.get(s.owner);
          if (c) c.stats.built++;
          this.emit(FX.BUILT, st.tile, st.kind, st.faction);
          if (st.kind === S.DEPOT || st.kind === S.BUNKER) {
            this.log('build', `${this.cmdName(s.owner)} completed a ${STRUCTS[st.kind].name.toLowerCase()} ${this.siteName(st.tile)}.`, st.faction, [s.owner], st.tile);
          }
          this.supplyDirty = true;
        }
      } else {
        const br = this.structById.get(s.tgtStruct);
        if (!br || !br.broken) { s.task = TASK.IDLE; s.tgtStruct = -1; continue; }
        br.built += 1;
        if (br.built >= br.need) {
          br.broken = false; br.hp = br.maxHp;
          s.task = TASK.IDLE; s.tgtStruct = -1;
          this.rebuildMoveCost();
          this.emit(FX.BUILT, br.tile, br.kind, s.faction);
          this.log('build', `${this.cmdName(s.owner)} restored ${br.name}; the crossing is open again.`, s.faction, [s.owner], br.tile);
        }
      }
    }
  }

  // ------------------------------------------------------------------ spatial buckets
  rebuildBuckets(): void {
    const head = this.bucketHead;
    head.fill(-1);
    if (this.bucketNext.length < this.squads.length) this.bucketNext = new Int32Array(this.squads.length * 2 + 16);
    const bw = Math.ceil(this.map.w / BUCKET);
    for (let i = 0; i < this.squads.length; i++) {
      const s = this.squads[i];
      const b = ((this.grid.row(s.tile) / BUCKET) | 0) * bw + ((this.grid.col(s.tile) / BUCKET) | 0);
      this.bucketNext[i] = head[b];
      head[b] = i;
    }
  }

  /** Visit squad indices whose tile is within `range` of tile (coarse chunk filter + exact distance). */
  forNear(tile: number, range: number, fn: (s: Squad, d: number) => void): void {
    const c = this.grid.col(tile), r = this.grid.row(tile);
    const bw = Math.ceil(this.map.w / BUCKET), bh = Math.ceil(this.map.h / BUCKET);
    const c0 = Math.max(0, ((c - range - 1) / BUCKET) | 0), c1 = Math.min(bw - 1, ((c + range + 1) / BUCKET) | 0);
    const r0 = Math.max(0, ((r - range) / BUCKET) | 0), r1 = Math.min(bh - 1, ((r + range) / BUCKET) | 0);
    for (let br = r0; br <= r1; br++) {
      for (let bc = c0; bc <= c1; bc++) {
        for (let i = this.bucketHead[br * bw + bc]; i >= 0; i = this.bucketNext[i]) {
          const s = this.squads[i];
          if (!s || s.hp <= 0) continue;
          const d = this.grid.dist(tile, s.tile);
          if (d <= range) fn(s, d);
        }
      }
    }
  }

  // ------------------------------------------------------------------ movement
  movement(): void {
    const g = this.grid;
    this.occupancy.fill(0);
    for (const s of this.squads) this.occupancy[s.tile]++;
    for (const s of this.squads) {
      if (s.hp <= 0) continue;
      const def = UNITS[s.cls];
      // stop to fight when an enemy is in range (attack-move semantics); scouts, retreats and evacuations keep moving
      const fighting = this.tick - s.engageT <= 1 && s.task !== TASK.RETREAT && s.task !== TASK.EVACUATE && s.task !== TASK.SCOUT && s.task !== TASK.MOVE && s.cls !== U.ENGINEER;
      if (s.next < 0) {
        if (fighting || s.tile === s.tgt) { if (s.cls === U.ARTILLERY) s.setup = Math.min(10, s.setup + 1); continue; }
        const nextTile = this.chooseStep(s);
        if (nextTile < 0) { s.stuck++; if (s.cls === U.ARTILLERY) s.setup = Math.min(10, s.setup + 1); continue; }
        s.next = nextTile;
        s.prog = 0;
        s.setup = 0;
      }
      const need = (this.moveCost[s.next] || 10) * 10;
      let spd = def.speed * (100 + this.mods(s.faction).speed);
      if (s.supply < 25) spd = (spd * 70) / 100;
      spd = (spd * (100 - Math.min(50, s.supp >> 1))) / 100;
      if (s.retreat) spd = (spd * 110) / 100;
      s.prog += Math.max(1, Math.floor(spd / 100));
      if (this.moveCost[s.next] === 0) { s.next = -1; s.prog = 0; continue; }
      if (s.prog >= need) {
        if (this.sealedFor(s.owner) && this.regionMask[s.next] && !this.regionMask[s.tile]) { s.next = -1; s.prog = 0; continue; }
        this.occupancy[s.tile]--;
        s.tile = s.next;
        this.occupancy[s.tile]++;
        s.next = -1;
        s.prog = 0;
        s.stuck = 0;
      }
    }
    void g;
  }

  chooseStep(s: Squad): number {
    const g = this.grid;
    const sealed = this.sealedFor(s.owner);
    let field: Int32Array;
    if (s.task === TASK.EVACUATE && sealed && this.regionMask[s.tile]) {
      field = this.evacField ??= this.flow.compute(this.regionExits(), 0);
    } else {
      field = this.flow.field(s.tgt, sealed ? 1 : 0, s.tile); // exact at s.tile, which is all a step reads
    }
    const here = field[s.tile];
    // near the destination and crowded: hold position on the ring instead of stacking
    if (g.dist(s.tile, s.tgt) <= 2 && s.task !== TASK.BUILD && s.task !== TASK.REPAIR && s.task !== TASK.RETREAT) {
      if (this.occupancy[s.tile] <= 2) {
        let blocked = true;
        for (let k = 0; k < 6; k++) {
          const v = g.nb[s.tile * 6 + k];
          if (v >= 0 && field[v] < here && this.occupancy[v] < 2) { blocked = false; break; }
        }
        if (blocked) return -1;
      }
    }
    if ((s.task === TASK.REPAIR || s.task === TASK.BUILD) && g.dist(s.tile, s.tgt) <= 1 && this.moveCost[s.tgt] === 0) return -1;
    let best = -1, bestD = here >= INF ? INF : here;
    for (let k = 0; k < 6; k++) {
      const v = g.nb[s.tile * 6 + k];
      if (v < 0 || this.moveCost[v] === 0) continue;
      if (sealed && this.regionMask[v] && !this.regionMask[s.tile]) continue;
      let d = field[v];
      if (d >= INF) continue;
      if (this.occupancy[v] >= 3) d += 25;
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  evacField: Int32Array | null = null;

  regionExits(): number[] {
    const out: number[] = [];
    for (let t = 0; t < this.grid.n; t++) {
      if (this.regionMask[t] || this.moveCost[t] === 0) continue;
      for (let k = 0; k < 6; k++) {
        const v = this.grid.nb[t * 6 + k];
        if (v >= 0 && this.regionMask[v]) { out.push(t); break; }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ combat
  combat(): void {
    const g = this.grid;
    const intents: { att: number; tgt: Squad | null; st: Struct | null; dmg: number; owner: number; f: number }[] = [];
    const region = this.regionActive ? this.regionMask : null;
    const opRunning = this.ops.find((o) => o.status === 'Running');
    const opRng = opRunning ? new Rng(opRunning.rngState) : null;

    for (const s of this.squads) {
      if (s.hp <= 0) continue;
      const def = UNITS[s.cls];
      if (s.task === TASK.EVACUATE) { if (s.cd > 0) s.cd--; continue; }
      const vis = this.factions[s.faction].visible;
      let best: Squad | null = null, bestScore = -1e9;
      const obsElev = this.elev[s.tile];
      const blocks = (t: number) => this.elev[t] > obsElev || (TERRAIN[this.terrain[t]].blocks && this.elev[t] >= obsElev);
      this.forNear(s.tile, def.range, (e, d) => {
        if (!this.atWar(s.faction, e.faction)) return;
        if (d < def.minRange) return;
        if (region && region[s.tile] !== region[e.tile]) return; // sealed operation boundary
        if (this.sealedFor(e.owner) && region && region[e.tile]) return;
        if (s.cls === U.ARTILLERY) { if (!vis[e.tile]) return; }
        else if (d > 1 && !g.los(s.tile, e.tile, blocks)) return;
        const score = DMG_MATRIX[s.cls][e.cls] + (100 - (e.hp * 100) / e.maxHp) * 0.6 - d * 4 + (e.id === s.lastTarget ? 15 : 0);
        if (score > bestScore || (score === bestScore && best && e.id < best.id)) { bestScore = score; best = e; }
      });
      const tgt = best as Squad | null;
      let st: Struct | null = null;
      if (!tgt) st = this.findStructTarget(s, def.range);
      if (!tgt && !st) { if (s.cd > 0) s.cd--; continue; }
      s.engageT = this.tick;
      if (s.cd > 0) { s.cd--; continue; }
      if (s.cls === U.ARTILLERY && (s.next >= 0 || s.setup < 5)) continue;
      const rng = opRng && region && region[s.tile] ? opRng : this.rng;
      const dmg = this.damage(s, tgt, st, rng);
      s.cd = def.cd;
      s.combatT = this.tick;
      if (tgt) {
        s.lastTarget = tgt.id;
        if (s.cls === U.ARTILLERY) {
          const flight = 3 + (g.dist(s.tile, tgt.tile) >> 1);
          this.shells.push({ impact: this.tick + flight, tile: tgt.tile, dmg, owner: s.owner, faction: s.faction, primary: tgt.id });
          this.emit(FX.SHELL, s.id, tgt.tile, s.faction, flight, dmg);
        } else {
          intents.push({ att: s.id, tgt, st: null, dmg, owner: s.owner, f: s.faction });
          this.emit(FX.SHOT, s.id, tgt.id, s.faction, s.cls, dmg);
        }
      } else if (st) {
        s.lastTarget = STRUCT_ID_BASE + st.id;
        if (s.cls === U.ARTILLERY) {
          const flight = 3 + (g.dist(s.tile, st.tile) >> 1);
          this.shells.push({ impact: this.tick + flight, tile: st.tile, dmg, owner: s.owner, faction: s.faction, primary: -st.id });
          this.emit(FX.SHELL, s.id, st.tile, s.faction, flight, dmg);
        } else {
          intents.push({ att: s.id, tgt: null, st, dmg, owner: s.owner, f: s.faction });
          this.emit(FX.SHOT, s.id, STRUCT_ID_BASE + st.id, s.faction, s.cls, dmg);
        }
      }
    }
    // defensive structures (cores, bunkers)
    for (const st of this.structs) {
      const sd = STRUCTS[st.kind];
      if (sd.atk <= 0 || st.faction < 0 || !this.isBuilt(st) || st.broken) continue;
      if (st.cd > 0) { st.cd--; continue; }
      let best: Squad | null = null, bd = 99;
      this.forNear(st.tile, sd.range, (e, d) => {
        if (!this.atWar(st.faction, e.faction)) return;
        if (region && region[st.tile] !== region[e.tile]) return;
        if (d < bd || (d === bd && best && e.id < best.id)) { bd = d; best = e; }
      });
      if (!best) continue;
      const b = best as Squad;
      let dmg = sd.atk * DMG_MATRIX[1][b.cls];
      dmg = Math.floor((dmg * (90 + this.rng.int(21))) / 100);
      dmg = Math.max(1, Math.floor((Math.floor(dmg / 100) * (100 - UNITS[b.cls].armor * 6)) / 100));
      st.cd = sd.cd;
      intents.push({ att: -st.id, tgt: b, st: null, dmg, owner: st.owner, f: st.faction });
      this.emit(FX.SHOT, STRUCT_ID_BASE + st.id, b.id, st.faction, 10 + st.kind, dmg);
    }
    // shells landing this tick
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i];
      if (sh.impact > this.tick) continue;
      this.shells.splice(i, 1);
      this.emit(FX.IMPACT, sh.tile, 0, sh.faction, 2);
      for (const e of this.squads) {
        if (e.tile !== sh.tile || !this.atWar(sh.faction, e.faction)) continue;
        intents.push({ att: 0, tgt: e, st: null, dmg: e.id === sh.primary ? sh.dmg : sh.dmg >> 1, owner: sh.owner, f: sh.faction });
      }
      if (sh.primary < 0) {
        const st = this.structById.get(-sh.primary);
        if (st && st.tile === sh.tile) intents.push({ att: 0, tgt: null, st, dmg: sh.dmg, owner: sh.owner, f: sh.faction });
      }
    }
    if (opRunning && opRng) opRunning.rngState = opRng.state();
    // apply simultaneously
    for (const it of intents) {
      if (it.tgt) {
        const e = it.tgt;
        e.hp -= it.dmg;
        e.supp = Math.min(100, e.supp + it.dmg * 2);
        e.morale = Math.max(0, e.morale - Math.ceil((it.dmg * 55) / e.maxHp));
        e.combatT = this.tick;
        e.hitBy = it.owner;
        this.heat(e.tile, 1);
      } else if (it.st) {
        const st = it.st;
        st.hp -= it.dmg;
        st.hitBy = it.owner;
        this.heat(st.tile, 1);
      }
    }
  }

  heat(tile: number, v: number): void {
    const key = ((this.grid.row(tile) >> 2) << 8) | (this.grid.col(tile) >> 2);
    this.battleHeat.set(key, (this.battleHeat.get(key) ?? 0) + v);
  }

  findStructTarget(s: Squad, range: number): Struct | null {
    let best: Struct | null = null, bd = 99;
    const region = this.regionActive ? this.regionMask : null;
    for (const st of this.structs) {
      const sd = STRUCTS[st.kind];
      if (!sd.destructible || st.broken) continue;
      const d = this.grid.dist(s.tile, st.tile);
      if (d > range || d < UNITS[s.cls].minRange) continue;
      if (region && region[s.tile] !== region[st.tile]) continue;
      if (st.kind === S.BRIDGE) { if (s.tgtStruct !== st.id) continue; }
      else if (!this.atWar(s.faction, st.faction)) continue;
      if (s.cls === U.ARTILLERY && !this.factions[s.faction].visible[st.tile]) continue;
      const pri = s.tgtStruct === st.id ? -10 : 0;
      if (d + pri < bd) { bd = d + pri; best = st; }
    }
    return best;
  }

  damage(a: Squad, e: Squad | null, st: Struct | null, rng: Rng): number {
    const def = UNITS[a.cls];
    let d = def.atk * 100;
    d = Math.floor((d * (50 + Math.floor((50 * a.hp) / a.maxHp))) / 100);
    const defIdx = e ? e.cls : 5;
    d = Math.floor((d * DMG_MATRIX[a.cls][defIdx]) / 100);
    const tile = e ? e.tile : st!.tile;
    if (this.elev[a.tile] > this.elev[tile]) d = Math.floor((d * 115) / 100);
    if (e) {
      let cover = TERRAIN[this.terrain[tile]].def;
      const bunker = this.structAt(tile, S.BUNKER);
      if (bunker && bunker.faction === e.faction && this.isBuilt(bunker)) cover += 40;
      d = Math.floor((d * (100 - Math.min(70, cover))) / 100);
      d = Math.floor((d * (100 + this.mods(e.faction).dmgIn)) / 100);
    }
    if (a.supply < 25) d = Math.floor((d * 60) / 100);
    if (a.morale < 40) d = Math.floor((d * 80) / 100);
    d = Math.floor((d * (100 - Math.min(50, a.supp >> 1))) / 100);
    d = Math.floor((d * (100 + this.mods(a.faction).dmgOut)) / 100);
    d = Math.floor((d * (90 + rng.int(21))) / 100);
    const armor = e ? UNITS[e.cls].armor : STRUCTS[st!.kind].armor;
    d = Math.floor((Math.floor(d / 100) * (100 - armor * 6)) / 100);
    return Math.max(1, d);
  }

  resolveDeaths(): void {
    let removed = false;
    for (const s of this.squads) {
      if (s.hp > 0) continue;
      removed = true;
      const owner = this.cmdById.get(s.owner);
      const killerId = s.hitBy;
      const killer = this.cmdById.get(killerId);
      const value = UNITS[s.cls].alloy + UNITS[s.cls].energy;
      if (owner) { owner.stats.losses++; owner.stats.valueLost += value; noteLoss(this, owner, s.tile, killer?.faction ?? -1); }
      if (killer) { killer.stats.kills++; killer.stats.valueKilled += value; this.factions[killer.faction].kills++; }
      this.factions[s.faction].losses++;
      if (killer && killer.faction !== s.faction) {
        const fs = this.factions[s.faction];
        fs.hostility[killer.faction] = Math.min(100, fs.hostility[killer.faction] + (s.cls === U.WALKER ? 6 : 2));
      }
      this.emit(FX.DEATH, s.tile, s.cls, s.faction, s.id);
      this.deathsWindow.push(this.tick, s.tile);
      if (s.cls === U.WALKER && killer) {
        this.log('battle', `${killer.name} (${FACTIONS[killer.faction]?.name ?? 'side'}) destroyed an assault walker of ${owner?.name ?? 'unknown'} ${this.siteName(s.tile)}.`, killer.faction, [killer.id, s.owner], s.tile);
      }
      this.squadById.delete(s.id);
    }
    if (removed) this.squads = this.squads.filter((s) => s.hp > 0);

    for (const st of this.structs) {
      if (!STRUCTS[st.kind].destructible || st.broken || st.hp > 0) continue;
      const killerId = st.hitBy;
      if (st.kind === S.BRIDGE) {
        st.broken = true; st.hp = 0; st.built = 0;
        this.rebuildMoveCost();
        for (const s of this.squads) {
          if (s.tile === st.tile || s.next === st.tile) {
            s.next = -1; s.prog = 0;
            for (let k = 0; k < 6; k++) { const v = this.grid.nb[s.tile * 6 + k]; if (v >= 0 && this.moveCost[v] > 0) { s.tile = v; break; } }
          }
        }
        this.emit(FX.DESTROYED, st.tile, st.kind, -1);
        this.log('territory', `${st.name} was destroyed by ${this.cmdName(killerId)}. Supply routes across the river are cut until engineers repair it.`, this.cmdById.get(killerId)?.faction ?? -1, [killerId], st.tile);
        continue;
      }
      st.hp = 0;
      if (st.kind === S.CORE) {
        const c = this.cmdById.get(st.owner);
        this.emit(FX.CORE_FALL, st.tile, 0, st.faction);
        if (c) onCoreDestroyed(this, c, killerId);
      } else {
        this.emit(FX.DESTROYED, st.tile, st.kind, st.faction);
        if (st.kind === S.DEPOT) this.log('battle', `${this.cmdName(killerId)} destroyed a supply depot of ${this.cmdName(st.owner)} ${this.siteName(st.tile)}.`, this.cmdById.get(killerId)?.faction ?? -1, [killerId, st.owner], st.tile);
      }
      const killer = this.cmdById.get(killerId);
      if (killer) killer.stats.valueKilled += 100;
    }
    const before = this.structs.length;
    this.structs = this.structs.filter((st) => !(STRUCTS[st.kind].destructible && st.kind !== S.BRIDGE && st.hp <= 0));
    if (this.structs.length !== before) {
      this.structById.clear();
      for (const st of this.structs) this.structById.set(st.id, st);
      this.supplyDirty = true;
    }
  }

  // ------------------------------------------------------------------ capture & territory
  // capture scratch, reused every capture tick (allocation-free at 128 x 128)
  private capF: Int8Array; private capC: Int16Array; private capR: Uint8Array; private capX: Uint8Array;

  capture(): void {
    const g = this.grid;
    const n = g.n;
    const presF = this.capF.fill(-1);
    const presCmd = this.capC.fill(-1);
    const presRate = this.capR.fill(0);
    const contested = this.capX.fill(0);
    const tiles: number[] = [];
    for (const s of this.squads) {
      const cap = UNITS[s.cls].capture;
      // only squads holding ground capture; columns passing through leave no territory trail
      if (cap <= 0 || s.retreat || s.task === TASK.EVACUATE || s.next >= 0) continue;
      const sealed = this.sealedFor(s.owner);
      tiles.length = 0;
      tiles.push(s.tile);
      if (s.cls === U.RIFLE || s.cls === U.WALKER) for (let k = 0; k < 6; k++) { const v = g.nb[s.tile * 6 + k]; if (v >= 0) tiles.push(v); }
      const inCombat = this.tick - s.combatT < 10;
      for (const t of tiles) {
        if (sealed && this.regionMask[t]) continue;
        if (presF[t] === -1) { presF[t] = s.faction; presCmd[t] = s.owner; presRate[t] = inCombat ? 0 : cap; }
        else if (presF[t] !== s.faction) contested[t] = 1;
        else if (!inCombat) presRate[t] = Math.min(12, presRate[t] + cap);
      }
    }
    for (let t = 0; t < n; t++) {
      const f = presF[t];
      if (f < 0 || contested[t] || presRate[t] === 0) continue;
      if (this.moveCost[t] === 0) continue;
      const curF = this.ownerF[t];
      if (curF === f) continue;
      if (curF >= 0 && !this.atWar(f, curF)) continue; // treaty partner territory
      const st = this.structAt(t);
      if (st && STRUCTS[st.kind].destructible && st.kind !== S.BRIDGE && st.faction >= 0 && st.faction !== f) continue;
      if (this.capCmd[t] !== presCmd[t]) { this.capCmd[t] = presCmd[t]; this.capProg[t] = 0; }
      const mods = this.mods(f);
      const rate = Math.max(1, Math.floor((presRate[t] * (100 + mods.capture)) / 100));
      const site = st && STRUCTS[st.kind].capturable;
      const threshold = site ? (st!.kind === S.CITADEL ? 60 : 30) : 6;
      this.capProg[t] = Math.min(255, this.capProg[t] + rate);
      if (this.capProg[t] >= threshold) {
        const capturer = this.cmdById.get(presCmd[t]);
        if (!capturer || capturer.status !== 'active') continue;
        const prevOwner = this.owner[t];
        this.setOwner(t, capturer.id);
        this.capProg[t] = 0;
        if (site && st) {
          const prevF = st.faction;
          st.owner = capturer.id; st.faction = capturer.faction;
          capturer.stats.captures++;
          this.emit(FX.CAPTURE, t, st.kind, capturer.faction);
          const from = prevOwner >= 0 ? ` from ${this.cmdName(prevOwner)}` : '';
          this.log('territory', `${capturer.name} (${this.factionName(capturer.faction)}) captured ${st.name}${from}.`, capturer.faction, prevOwner >= 0 ? [capturer.id, prevOwner] : [capturer.id], t);
          if (prevF >= 0 && prevF !== capturer.faction) {
            const fs = this.factions[prevF];
            fs.hostility[capturer.faction] = Math.min(100, fs.hostility[capturer.faction] + 8);
          }
          if (st.kind === S.CITADEL) this.onCitadel(capturer);
          for (const tm of this.teams) if (tm.members.some((m) => m.id === capturer.id)) tm.record.captures++;
        } else if (this.recordFx && (t & 3) === 0) {
          this.emit(FX.CAPTURE, t, -1, capturer.faction);
        }
      }
    }
  }

  factionName(f: number): string { return this.mode === 'world' ? (FACTIONS[f]?.name ?? 'Neutral') : `Side ${f === 0 ? 'A' : 'B'}`; }

  onCitadel(c: Commander): void {
    if (this.mode !== 'world') return;
    const fs = this.factions[c.faction];
    if (fs.citadel) return;
    if (this.factions.some((x) => x.citadel)) return;
    fs.citadel = true;
    fs.capBonus += 1;
    this.log('lineage', `Citadel awakening: ${this.factionName(c.faction)} took Citadel Prime first and gains a specialist recruitment slot (not a free army).`, c.faction, [c.id], this.map.sites.find((s) => s.kind === S.CITADEL)?.tile ?? -1);
  }

  territoryDecay(): void {
    const g = this.grid;
    this.nearMask.fill(0);
    const tmp: number[] = [];
    for (const s of this.squads) {
      tmp.length = 0;
      g.within(s.tile, 2, tmp);
      for (const t of tmp) this.nearMask[t] |= 1 << s.faction;
    }
    for (let t = 0; t < g.n; t++) {
      const f = this.ownerF[t];
      if (f < 0) continue;
      if (this.factions[f].inSupply[t] || (this.nearMask[t] & (1 << f))) { this.decay[t] = 0; continue; }
      const st = this.structAt(t);
      if (st && STRUCTS[st.kind].capturable) continue;
      if (st && st.faction === f) continue;
      this.decay[t]++;
      if (this.decay[t] >= 3) this.setOwner(t, -1);
    }
  }

  // ------------------------------------------------------------------ per-squad supply, morale, healing
  squadUpkeepTick(): void {
    for (const s of this.squads) {
      const fs = this.factions[s.faction];
      const supplied = fs.inSupply[s.tile] === 1;
      const owner = this.cmdById.get(s.owner);
      const moving = s.next >= 0 || this.tick - s.combatT < 10;
      if (supplied && !(owner?.underSupplied)) {
        s.supply = Math.min(100, s.supply + 5);
        if (this.tick - s.combatT > 15) {
          s.morale = Math.min(100, s.morale + 3);
          // healing near a core or depot
          let heal = 0;
          for (const st of this.structs) {
            if (st.faction !== s.faction || (st.kind !== S.CORE && st.kind !== S.DEPOT) || !this.isBuilt(st)) continue;
            if (this.grid.dist(st.tile, s.tile) <= 3) { heal = 3; break; }
          }
          if (heal) s.hp = Math.min(s.maxHp, s.hp + Math.ceil((heal * s.maxHp * (100 + this.mods(s.faction).heal)) / 10000));
        }
      } else {
        const drain = (moving ? 2 : 1) * (100 + this.mods(s.faction).supplyDrain);
        s.supply = Math.max(0, s.supply - Math.ceil(drain / (owner?.underSupplied ? 50 : 100)));
        if (s.supply === 0) { s.hp -= 2; s.morale = Math.max(0, s.morale - 2); }
      }
      s.supp = Math.max(0, s.supp - 12);
      // retreat logic: cut-off or broken squads fall back
      if (!s.retreat && (s.morale < 30 || s.hp * 100 < s.maxHp * 34)) {
        s.retreat = true;
        s.task = TASK.RETREAT;
        s.tgt = this.nearestSupplySource(s);
        s.next = -1;
      } else if (s.retreat && s.morale > 60 && s.hp * 100 > s.maxHp * 70) {
        s.retreat = false;
        s.task = TASK.IDLE;
      }
    }
  }

  nearestSupplySource(s: Squad): number {
    let best = -1, bd = 999;
    for (const st of this.structs) {
      if (st.faction !== s.faction || (st.kind !== S.CORE && st.kind !== S.DEPOT) || !this.isBuilt(st)) continue;
      const d = this.grid.dist(st.tile, s.tile);
      if (d < bd) { bd = d; best = st.tile; }
    }
    return best >= 0 ? best : s.tile;
  }

  // ------------------------------------------------------------------ economy
  economy(): void {
    const tick = this.tick;
    // one pass over the map for every commander's territory, supplied tiles and ruins (no per-commander map loops).
    // Sized by the largest id, not nextCmdId: duel sides carry their world ids (c.id = p.id), which can exceed it.
    let ids = this.nextCmdId;
    for (const c of this.cmds) if (c.id >= ids) ids = c.id + 1;
    const terr = new Int32Array(ids), supT = new Int32Array(ids), ruinT = new Int32Array(ids);
    for (let t = 0; t < this.grid.n; t++) {
      const o = this.owner[t];
      if (o < 0 || o >= ids) continue;
      terr[o]++;
      const of = this.ownerF[t];
      if (of < 0 || !this.factions[of].inSupply[t]) continue;
      supT[o]++;
      if (this.terrain[t] === T.RUIN) ruinT[o]++;
    }
    for (const c of this.cmds) {
      if (c.status !== 'active') continue;
      const f = c.faction;
      const fs = this.factions[f];
      const inc = { alloy: 0, energy: 0, supply: 0 };
      const core = this.structById.get(c.coreId);
      if (core && core.hp > 0) { inc.alloy += 5; inc.energy += 3; inc.supply += 8; }
      for (const st of this.structs) {
        if (st.owner !== c.id) continue;
        const sup = fs.inSupply[st.tile] === 1;
        switch (st.kind) {
          case S.MINE: if (sup) inc.alloy += 4; break;
          case S.REFINERY: if (sup) inc.energy += 4; break;
          case S.RELAY: if (sup) { inc.energy += 2; inc.alloy += 1; inc.supply += 1; } break;
          case S.HUB: if (sup) { inc.alloy += 2; inc.energy += 1; inc.supply += 3; } break;
          case S.CITADEL: if (sup) { inc.alloy += 6; inc.energy += 6; inc.supply += 5; } break;
          case S.DEPOT: if (this.isBuilt(st)) inc.supply += 4; break;
        }
      }
      const tiles = supT[c.id], ruins = Math.min(4, ruinT[c.id]);
      inc.alloy += Math.floor(tiles / 20) + ruins;
      inc.supply += Math.floor(tiles / 12);
      const im = 100 + this.mods(f).income;
      inc.alloy = Math.floor((inc.alloy * im) / 100);
      inc.energy = Math.floor((inc.energy * im) / 100);
      inc.supply = Math.floor((inc.supply * im) / 100);
      // superlinear upkeep: large armies cost more than remote territory returns (§3.5)
      const mine = this.squads.filter((s) => s.owner === c.id);
      let up = 0;
      for (const s of mine) up += UNITS[s.cls].upkeep;
      const upkeep = Math.floor((up * (100 + mine.length * 4)) / 200);
      c.res.alloy = Math.min(2000, c.res.alloy + inc.alloy);
      c.res.energy = Math.min(2000, c.res.energy + inc.energy);
      c.res.supply = c.res.supply + inc.supply - upkeep;
      if (c.res.supply < 0) { c.res.supply = 0; c.underSupplied = true; } else c.underSupplied = false;
      c.res.supply = Math.min(2000, c.res.supply);
      c.lastIncome = inc;
      c.lastUpkeep = upkeep;
      c.power = this.computePower(c, mine.length ? mine : [], tiles, terr[c.id]);
    }
    void tick;
  }

  computePower(c: Commander, mine: Squad[], suppliedTiles?: number, ownedTiles?: number): number {
    let territory = ownedTiles ?? 0;
    if (ownedTiles === undefined) for (let t = 0; t < this.grid.n; t++) if (this.owner[t] === c.id) territory++;
    let p = territory + (suppliedTiles ?? 0) * 0.25;
    for (const st of this.structs) {
      if (st.owner !== c.id) continue;
      p += STRUCTS[st.kind].capturable ? 12 : st.kind === S.CORE ? 30 : 5;
    }
    for (const s of mine) p += (s.hp / s.maxHp) * UNITS[s.cls].power * 10;
    p += (c.res.alloy + c.res.energy + c.res.supply) / 60;
    return Math.round(p);
  }

  // ------------------------------------------------------------------ analytics
  sample(): void {
    const sr = this.series;
    sr.ticks.push(this.tick);
    const terr = [0, 0, 0, 0];
    for (let t = 0; t < this.grid.n; t++) { const f = this.ownerF[t]; if (f >= 0) terr[f]++; }
    for (let f = 0; f < 4; f++) {
      sr.territory[f].push(terr[f]);
      const p = this.cmds.filter((c) => c.faction === f && c.status === 'active').reduce((a, c) => a + c.power, 0);
      sr.power[f].push(p);
      sr.squads[f].push(this.squads.filter((s) => s.faction === f).length);
      sr.kills[f].push(this.factions[f].kills);
      this.factions[f].powerHist.push(p);
      if (this.factions[f].powerHist.length > 60) this.factions[f].powerHist.shift();
    }
    const act = this.cmds.filter((c) => c.status === 'active' && c.updates > 0);
    sr.learnErr.push(act.length ? act.reduce((a, c) => a + c.errEma, 0) / act.length : 0);
    sr.reward.push(act.length ? act.reduce((a, c) => a + c.rewardEma, 0) / act.length : 0);
    const cap = 240;
    if (sr.ticks.length > cap) {
      sr.ticks.shift();
      for (const arr of [sr.territory, sr.power, sr.squads, sr.kills]) for (const a of arr) a.shift();
      sr.learnErr.shift(); sr.reward.shift();
    }
    sr.version++;
    for (const c of this.cmds) {
      if (c.status === 'retired') continue;
      c.hist.power.push(c.power);
      c.hist.merit.push(this.ledger.balance(c.meritAcct));
      c.hist.elo.push(Math.round(c.elo));
      c.hist.err.push(Math.round(c.errEma * 1000) / 1000);
      for (const k of ['power', 'merit', 'elo', 'err'] as const) if (c.hist[k].length > 120) c.hist[k].shift();
    }
    // decay battle heat
    for (const [k, v] of this.battleHeat) { const nv = Math.floor(v * 0.5); if (nv <= 0) this.battleHeat.delete(k); else this.battleHeat.set(k, nv); }
    // battle summaries
    const cutoff = this.tick - CLOCK.SAMPLE;
    const recent: number[] = [];
    for (let i = 0; i < this.deathsWindow.length; i += 2) if (this.deathsWindow[i] > cutoff) recent.push(this.deathsWindow[i + 1]);
    this.deathsWindow = [];
    if (recent.length >= 3) {
      const tile = recent[Math.floor(recent.length / 2)];
      this.log('battle', `Heavy fighting ${this.siteName(tile)}: ${recent.length} squads lost in the last 30 seconds.`, -1, [], tile);
    }
  }

  hashState(): void {
    let h = FNV_SEED;
    h = fnv(h, this.tick);
    h = fnv(h, this.chunksOpen.length);
    for (const s of this.squads) { h = fnv(h, s.id); h = fnv(h, s.tile); h = fnv(h, s.hp); h = fnv(h, s.supply); }
    for (const st of this.structs) { h = fnv(h, st.id); h = fnv(h, st.hp); h = fnv(h, st.owner + 1); }
    for (const c of this.cmds) { h = fnv(h, c.res.alloy); h = fnv(h, c.res.energy); h = fnv(h, c.res.supply); }
    for (let t = 0; t < this.grid.n; t += 1) h = fnv(h, this.owner[t] + 1);
    this.stateHash = h;
    if (this.tick % 250 === 0) {
      this.hashHist.push({ tick: this.tick, hash: hex32(h) });
      if (this.hashHist.length > 12) this.hashHist.shift();
    }
  }

  rulesVersion(): string { return RULES_VERSION; }
}

function now(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
