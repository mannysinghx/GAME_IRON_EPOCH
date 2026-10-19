// Durable snapshots of the whole world in the browser's IndexedDB. The world regenerates its map from
// the seed (deterministic) and restores every dynamic field from the snapshot. A version mismatch
// starts a fresh world rather than guessing.

import { FRONTIER, SAVE_VERSION } from '../shared/config.ts';
import { Rng } from '../shared/rng.ts';
import { Ledger } from './ledger.ts';
import { World } from './world.ts';
import { syncRegion } from './operations.ts';
import type { FactionState } from './types.ts';

type Json = Record<string, unknown>;

// Typed arrays travel as base64 of their bytes: a 128 x 128 world has ~20 per-tile arrays, and JSON number lists
// would be several times larger. Snapshots never leave this browser, so platform byte order is stable.
function enc(a: ArrayBufferView): string {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(bin);
}

function bytes(v: unknown): Uint8Array {
  const bin = atob(String(v));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const u8 = (v: unknown) => bytes(v);
const i8 = (v: unknown) => { const b = bytes(v); return new Int8Array(b.buffer, 0, b.length); };
const i16 = (v: unknown) => { const b = bytes(v); return new Int16Array(b.buffer, 0, b.length >> 1); };
const i32 = (v: unknown) => { const b = bytes(v); return new Int32Array(b.buffer, 0, b.length >> 2); };

export function serialize(w: World): string {
  const factions = w.factions.map((f) => ({
    ...f, lastSeen: enc(f.lastSeen), knownOwner: enc(f.knownOwner), visible: enc(f.visible), inSupply: enc(f.inSupply), supplyDist: enc(f.supplyDist),
  }));
  const data = {
    v: SAVE_VERSION, fairRatings: 1, seed: w.seed, tick: w.tick, nextId: w.nextId, nextCmdId: w.nextCmdId,
    rng: w.rng.state(), marketRng: w.marketRng.state(),
    owner: enc(w.owner), capCmd: enc(w.capCmd), capProg: enc(w.capProg), decay: enc(w.decay), occupancy: enc(w.occupancy),
    // frontier: which chunks are open; their structures are in `structs`, the remaining specs regenerate from the seed
    active: enc(w.active), chunksOpen: w.chunksOpen, chunkOpenTick: Array.from(w.chunkOpenTick), frontierVersion: w.frontierVersion, nextFrontierTick: w.nextFrontierTick,
    squads: w.squads, structs: w.structs, cmds: w.cmds, factions, teams: w.teams, treaties: w.treaties, ops: w.ops, markets: w.markets,
    ledger: w.ledger.st, npcs: w.npcs, wallet: w.wallet, weather: w.weather, chronicle: w.chronicle, chronId: w.chronId, series: w.series,
    evals: w.evals, evalCounter: w.evalCounter, decisionCounter: w.decisionCounter, opCounter: w.opCounter, usedNames: w.usedNames,
    narrative: w.narrative, battleHeat: [...w.battleHeat.entries()], shells: w.shells, hashHist: w.hashHist, deathsWindow: w.deathsWindow,
    story: w.story?.save() ?? null,
  };
  return JSON.stringify(data);
}

export function deserialize(text: string): World | null {
  const d = JSON.parse(text) as Json;
  if (d.v !== SAVE_VERSION) return null;
  const w = new World('world', d.seed as number);
  const n = w.grid.n;
  const owner = i16(d.owner), active = u8(d.active);
  if (owner.length !== n || active.length !== n) return null; // different theatre size: start fresh rather than guess
  w.tick = d.tick as number;
  w.nextId = d.nextId as number;
  w.nextCmdId = d.nextCmdId as number;
  w.rng = new Rng(d.rng as number[]);
  w.marketRng = new Rng(d.marketRng as number[]);
  w.owner = owner;
  w.capCmd = i16(d.capCmd);
  w.capProg = u8(d.capProg);
  w.decay = u8(d.decay);
  w.occupancy.set(u8(d.occupancy));
  // Frontier state. Never call openChunk here: opened chunks' sites and bridges are already in the saved structs.
  w.active.set(active);
  w.chunksOpen = (d.chunksOpen as number[]).slice();
  restoreOpenTicks(w, d.chunkOpenTick as number[] | undefined);
  w.frontierVersion = d.frontierVersion as number;
  w.nextFrontierTick = d.nextFrontierTick as number;
  w.squads = d.squads as World['squads'];
  w.structs = d.structs as World['structs'];
  w.cmds = d.cmds as World['cmds'];
  // Per-faction knowledge, visibility and supply are restored as saved (not recomputed), so the next tick sees
  // exactly what the uninterrupted world would have seen.
  w.factions = (d.factions as Json[]).map((f) => ({
    ...(f as unknown as FactionState),
    lastSeen: i32(f.lastSeen), knownOwner: i8(f.knownOwner),
    visible: u8(f.visible), inSupply: u8(f.inSupply), supplyDist: i16(f.supplyDist),
  }));
  w.teams = d.teams as World['teams'];
  w.treaties = d.treaties as World['treaties'];
  w.ops = d.ops as World['ops'];
  w.markets = d.markets as World['markets'];
  w.ledger = new Ledger(d.ledger as Ledger['st']);
  w.npcs = d.npcs as World['npcs'];
  w.wallet = d.wallet as World['wallet'];
  w.weather = d.weather as World['weather'];
  w.chronicle = d.chronicle as World['chronicle'];
  w.chronId = d.chronId as number;
  w.series = d.series as World['series'];
  w.evals = d.evals as World['evals'];
  w.evalCounter = d.evalCounter as number;
  w.decisionCounter = d.decisionCounter as number;
  w.opCounter = d.opCounter as number;
  w.usedNames = d.usedNames as string[];
  w.narrative = d.narrative as string[];
  w.battleHeat = new Map(d.battleHeat as [number, number][]);
  w.shells = d.shells as World['shells'];
  w.hashHist = d.hashHist as World['hashHist'];
  w.deathsWindow = (d.deathsWindow as number[] | undefined) ?? [];
  // presentation-only story records; snapshots from before the story layer resume with an empty one (no version bump:
  // the world itself is unchanged, so discarding it would destroy history for nothing)
  w.story?.load(d.story);
  // derived state
  w.ownerF = new Int8Array(n).fill(-1);
  w.cmdById.clear(); for (const c of w.cmds) w.cmdById.set(c.id, c);
  w.squadById.clear(); for (const s of w.squads) w.squadById.set(s.id, s);
  w.structById.clear(); for (const s of w.structs) w.structById.set(s.id, s);
  for (let t = 0; t < n; t++) { const o = w.owner[t]; w.ownerF[t] = o >= 0 ? (w.cmdById.get(o)?.faction ?? -1) : -1; }
  w.rebuildMoveCost();
  w.rebuildWar();
  w.regionOpId = -2; // force the sealed region to be rebuilt from the restored operations
  syncRegion(w);
  // storms are refreshed every 25 ticks; rebuild the set the live world last computed
  const t25 = Math.floor(w.tick / 25) * 25;
  w.storms = w.weather.filter((s) => t25 >= s.start && t25 < s.end).map((s) => ({ tile: s.tile, radius: s.radius }));
  w.fx.length = 0;
  w.territoryDirty = true;
  w.supplyDirty = true;
  w.rebuildBuckets();
  w.log('chapter', `World resumed from durable snapshot at tick ${w.tick}. Countdowns were frozen while the host was away.`, -1, [], -1);
  // snapshots from before the duel-timing fix carry skill ratings biased by commander id: start them over
  if (!d.fairRatings) {
    for (const c of w.cmds) { c.elo = 1200; c.evalGames = 0; c.evalWins = 0; c.evalDraws = 0; c.hist.elo = []; }
    w.evals = [];
    w.log('eval', 'Skill ratings reset: earlier proving-ground duels gave the lower-id commander a timing edge. All commanders restart at 1200 with no games (provisional).', -1, [], -1);
  }
  return w;
}

/** Opening ticks per chunk. Snapshots without them (earlier v6 builds) derive them from the fixed schedule. */
function restoreOpenTicks(w: World, saved: number[] | undefined): void {
  w.chunkOpenTick.fill(-1);
  if (saved && saved.length === w.chunkOpenTick.length) { w.chunkOpenTick.set(saved); return; }
  const init = w.frontier?.initial.length ?? 0;
  w.chunksOpen.forEach((ci, i) => {
    if (i >= init) w.chunkOpenTick[ci] = FRONTIER.firstAt + Math.floor((i - init) / FRONTIER.perEvent) * FRONTIER.interval;
  });
}

// ------------------------------------------------------------------ IndexedDB (available inside workers)
const DB = 'iron-epoch';
const STORE = 'saves';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSnapshot(text: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(text, 'current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadSnapshot(): Promise<string | null> {
  try {
    const db = await openDb();
    const v = await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('current');
      req.onsuccess = () => resolve((req.result as string) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return v;
  } catch {
    return null;
  }
}

export async function clearSnapshot(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('current');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch { /* storage may be unavailable (private mode); the world still runs */ }
}
