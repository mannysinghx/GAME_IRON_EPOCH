// Durable snapshots of the whole world in the browser's IndexedDB. The world regenerates its map from
// the seed (deterministic) and restores every dynamic field from the snapshot. A version mismatch
// starts a fresh world rather than guessing.

import { SAVE_VERSION } from '../shared/config.ts';
import { Rng } from '../shared/rng.ts';
import { Ledger } from './ledger.ts';
import { World } from './world.ts';
import type { FactionState } from './types.ts';

type Json = Record<string, unknown>;

export function serialize(w: World): string {
  const factions = w.factions.map((f) => ({
    ...f, lastSeen: Array.from(f.lastSeen), knownOwner: Array.from(f.knownOwner), visible: [], inSupply: [], supplyDist: [],
  }));
  const data = {
    v: SAVE_VERSION, seed: w.seed, tick: w.tick, nextId: w.nextId, nextCmdId: w.nextCmdId,
    rng: w.rng.state(), marketRng: w.marketRng.state(),
    owner: Array.from(w.owner), capCmd: Array.from(w.capCmd), capProg: Array.from(w.capProg), decay: Array.from(w.decay),
    squads: w.squads, structs: w.structs, cmds: w.cmds, factions, teams: w.teams, treaties: w.treaties, ops: w.ops, markets: w.markets,
    ledger: w.ledger.st, npcs: w.npcs, wallet: w.wallet, weather: w.weather, chronicle: w.chronicle, chronId: w.chronId, series: w.series,
    evals: w.evals, evalCounter: w.evalCounter, decisionCounter: w.decisionCounter, opCounter: w.opCounter, usedNames: w.usedNames,
    narrative: w.narrative, battleHeat: [...w.battleHeat.entries()], shells: w.shells, hashHist: w.hashHist,
  };
  return JSON.stringify(data);
}

export function deserialize(text: string): World | null {
  const d = JSON.parse(text) as Json;
  if (d.v !== SAVE_VERSION) return null;
  const w = new World('world', d.seed as number);
  const n = w.grid.n;
  w.tick = d.tick as number;
  w.nextId = d.nextId as number;
  w.nextCmdId = d.nextCmdId as number;
  w.rng = new Rng(d.rng as number[]);
  w.marketRng = new Rng(d.marketRng as number[]);
  w.owner = Int16Array.from(d.owner as number[]);
  w.capCmd = Int16Array.from(d.capCmd as number[]);
  w.capProg = Uint8Array.from(d.capProg as number[]);
  w.decay = Uint8Array.from(d.decay as number[]);
  w.squads = d.squads as World['squads'];
  w.structs = d.structs as World['structs'];
  w.cmds = d.cmds as World['cmds'];
  w.factions = (d.factions as Json[]).map((f) => ({
    ...(f as unknown as FactionState),
    lastSeen: Int32Array.from(f.lastSeen as number[]), knownOwner: Int8Array.from(f.knownOwner as number[]),
    visible: new Uint8Array(n), inSupply: new Uint8Array(n), supplyDist: new Int16Array(n).fill(99),
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
  // derived state
  w.ownerF = new Int8Array(n).fill(-1);
  w.cmdById.clear(); for (const c of w.cmds) w.cmdById.set(c.id, c);
  w.squadById.clear(); for (const s of w.squads) w.squadById.set(s.id, s);
  w.structById.clear(); for (const s of w.structs) w.structById.set(s.id, s);
  for (let t = 0; t < n; t++) { const o = w.owner[t]; w.ownerF[t] = o >= 0 ? (w.cmdById.get(o)?.faction ?? -1) : -1; }
  w.rebuildMoveCost();
  w.rebuildWar();
  w.regionMask.fill(0);
  w.regionActive = false;
  w.rosterSet = new Set();
  const op = w.ops.find((o) => o.status === 'Locked' || o.status === 'Running');
  if (op) { for (const t of op.region) w.regionMask[t] = 1; w.rosterSet = new Set(op.roster); w.regionActive = true; }
  w.fx.length = 0;
  w.territoryDirty = true;
  w.supplyDirty = true;
  w.updateVisibility();
  w.updateSupply();
  w.rebuildBuckets();
  w.log('chapter', `World resumed from durable snapshot at tick ${w.tick}. Countdowns were frozen while the host was away.`, -1, [], -1);
  return w;
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
