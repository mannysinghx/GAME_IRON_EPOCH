// Autonomous commanders (design doc §5). Decision hierarchy:
//   tactical (every tick, in world.ts) → operational (every 3 s) → strategic (60–120 s or event, quota-limited).
// The strategic layer is a utility baseline plus a per-agent online linear value learner: it predicts the
// realized reward of a plan from fog-filtered features and corrects the doctrine score. Learning changes
// future decisions; it never changes damage, resources, or rules. Labelled honestly as strategic game AI.

import {
  CLOCK, DECISION_LOG, DOCTRINE, FACTIONS, FEAT_COUNT, LEARN, MEMORY_CAP, PK, PLAN_COUNT, PLAN_NAMES, POP, PSI_DIM,
  S, STRUCTS, T, U, UNITS,
} from '../shared/config.ts';
import { hashStr, hex32, sha256Hex } from '../shared/rng.ts';
import type { World } from './world.ts';
import { TASK, type Candidate, type Commander, type MemoryFact, type Plan, type PlanBase, type Squad, type Struct } from './types.ts';

// ------------------------------------------------------------------ creation
export function makeCommander(
  w: World,
  spec: { faction: number; name?: string; doctrine: number[]; gen: number; parents: number[]; birthKind: string },
): Commander {
  const id = w.nextCmdId++;
  const fdef = FACTIONS[spec.faction] ?? FACTIONS[0];
  const name = spec.name ?? pickName(w, spec.faction);
  const c: Commander = {
    id, key: `a-${fdef.key}-${String(id).padStart(2, '0')}`, name, faction: spec.faction, status: 'reserve',
    gen: spec.gen, parents: spec.parents.slice(), children: [], born: w.tick, birthKind: spec.birthKind,
    doctrine: spec.doctrine.map((v) => clamp(Math.round(v), 0, 100)), mutation: [],
    policyMajor: 1, policyMinor: 0, policyHash: '', policyHistory: [],
    lw: new Array(PSI_DIM).fill(0), updates: 0, errEma: 0.5, rewardEma: 0.3, // baseline starts near the typical plan reward
    memory: [], res: { alloy: 0, energy: 0, supply: 0 }, coreId: -1, homeTile: -1, queue: [], plan: null,
    nextStrategic: 0, nextOperational: 0, lastReview: -9999,
    stats: { kills: 0, losses: 0, captures: 0, opsPlayed: 0, opsWon: 0, plans: 0, valueKilled: 0, valueLost: 0, built: 0, spent: 0, produced: 0 },
    meritAcct: w.ledger.open(`cmd:${id}`, 'MERIT', 'treasury'), meritGross: 0, meritSpent: 0,
    elo: 1200, evalGames: 0, evalWins: 0, evalDraws: 0,
    rel: { issued: 0, rejected: 0, fallbacks: 0, decisions: 0 },
    decisions: [], hist: { power: [], merit: [], elo: [], err: [] },
    team: -1, role: 'unassigned', reserveSince: -1, lastDescendant: -99999, underSupplied: false,
    campaignBase: { sites: 0, territory: 0 }, trust: {}, power: 0,
    lastIncome: { alloy: 0, energy: 0, supply: 0 }, lastUpkeep: 0, awaiting: false,
  };
  c.policyHash = policyHash(c);
  c.policyHistory.push({ tick: w.tick, version: policyLabel(c), note: `${spec.birthKind} policy` });
  w.cmds.push(c);
  w.cmdById.set(c.id, c);
  w.usedNames.push(name);
  return c;
}

function pickName(w: World, f: number): string {
  const pool = FACTIONS[f]?.names ?? ['Agent'];
  for (const n of pool) if (!w.usedNames.includes(n)) return n;
  const base = pool[w.usedNames.length % pool.length];
  let k = 2;
  while (w.usedNames.includes(`${base} ${roman(k)}`)) k++;
  return `${base} ${roman(k)}`;
}

export function roman(n: number): string {
  const t: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}

export function policyLabel(c: Commander): string { return `v${c.policyMajor}.${c.policyMinor}`; }

export function policyHash(c: Commander): string {
  const q = c.lw.map((x) => Math.round(x * 1000)).join(',');
  return sha256Hex(`${c.key}|${c.doctrine.join(',')}|${q}|v${c.policyMajor}.${c.policyMinor}`).slice(0, 16);
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ------------------------------------------------------------------ observation (fog-filtered)
interface EnemySeen { tile: number; cls: number; faction: number; age: number; hpf: number }

interface Obs {
  own: Squad[];
  combat: Squad[];
  engineers: Squad[];
  scouts: Squad[];
  enemies: EnemySeen[];
  centroid: number;
  strength: number;
  core: Struct | undefined;
  coreThreat: number;
  hash: string;
  size: number;
}

function observe(w: World, c: Commander): Obs {
  const fs = w.factions[c.faction];
  const own = w.squads.filter((s) => s.owner === c.id);
  const enemies: EnemySeen[] = [];
  for (const s of w.squads) {
    if (s.faction === c.faction || !fs.visible[s.tile]) continue;
    if (!w.atWar(c.faction, s.faction)) continue;
    enemies.push({ tile: s.tile, cls: s.cls, faction: s.faction, age: 0, hpf: s.hp / s.maxHp });
  }
  for (const g of fs.ghosts) {
    if (fs.visible[g.tile] || !w.atWar(c.faction, g.faction)) continue;
    enemies.push({ tile: g.tile, cls: g.cls, faction: g.faction, age: w.tick - g.tick, hpf: 1 });
  }
  if (enemies.length > 40) enemies.length = 40;
  const combat = own.filter((s) => s.cls !== U.ENGINEER && s.cls !== U.SCOUT);
  const core = w.structById.get(c.coreId);
  let cq = 0, cr = 0;
  const base = combat.length ? combat : own;
  for (const s of base) { cq += w.grid.col(s.tile); cr += w.grid.row(s.tile); }
  const centroid = base.length ? w.grid.idx(Math.round(cq / base.length), Math.round(cr / base.length)) : (core?.tile ?? c.homeTile);
  let strength = 0;
  for (const s of combat) strength += UNITS[s.cls].power * (s.hp / s.maxHp);
  const coreThreat = core ? threatAt(w, enemies, core.tile, 6) : 0;
  const hash = hex32(hashStr(`${w.tick}|${c.id}|${own.map((s) => s.tile).join('.')}|${enemies.map((e) => e.tile).join('.')}`));
  return {
    own, combat, engineers: own.filter((s) => s.cls === U.ENGINEER), scouts: own.filter((s) => s.cls === U.SCOUT),
    enemies, centroid: centroid >= 0 ? centroid : 0, strength, core, coreThreat, hash, size: own.length + enemies.length,
  };
}

function threatAt(w: World, enemies: EnemySeen[], tile: number, radius: number): number {
  let t = 0;
  for (const e of enemies) {
    const d = w.grid.dist(e.tile, tile);
    if (d > radius) continue;
    const decay = Math.max(0, 1 - e.age / 900);
    t += UNITS[e.cls].power * e.hpf * decay;
  }
  return t;
}

function structThreat(w: World, c: Commander, tile: number): number {
  let t = 0;
  for (const it of w.factions[c.faction].intel) {
    if (!w.atWar(c.faction, it.faction)) continue;
    const d = w.grid.dist(it.tile, tile);
    if (d > 4) continue;
    if (it.kind === S.CORE) t += 3; else if (it.kind === S.BUNKER) t += 1.5;
  }
  return t;
}

/** Own and same-faction strength already standing within `r` of a tile (a garrison absorbs threat). */
function garrisonAt(w: World, c: Commander, tile: number, r: number): number {
  let g = 0;
  w.forNear(tile, r, (s) => { if (s.faction === c.faction && s.cls !== U.ENGINEER) g += UNITS[s.cls].power * (s.hp / s.maxHp); });
  return g;
}

/** Enemy pressure on an owned site that its current garrison does not already answer. */
function unanswered(w: World, c: Commander, obs: Obs, tile: number): number {
  return Math.max(0, threatAt(w, obs.enemies, tile, 6) - 0.7 * garrisonAt(w, c, tile, 3));
}

// ------------------------------------------------------------------ candidates
const ATTACK_KINDS = new Set<number>([PK.ATTACK, PK.ASSAULT_CORE, PK.RAID, PK.SABOTAGE, PK.CAPTURE, PK.OPERATION]);
const BASE_U = [0.2, 0.2, -0.1, 0.05, 0.05, -0.05, 0.0, -0.05, -0.1, -0.1, 0.2, 0.05, -0.35];

function candidates(w: World, c: Commander, obs: Obs): Candidate[] {
  const g = w.grid;
  const f = c.faction;
  const fs = w.factions[f];
  const sealed = w.sealedFor(c.id);
  const out: { kind: number; tile: number; struct: number; name: string; quick: number }[] = [];
  const add = (kind: number, tile: number, struct: number, name: string, value: number) => {
    if (tile < 0 || !w.active[tile]) return; // closed frontier land is never a target
    if (sealed && w.regionMask[tile]) return;
    const d = reach(w, c, obs, kind, tile);
    out.push({ kind, tile, struct, name, quick: value * (1 - Math.min(1, d / 70)) });
  };
  const known = (tile: number) => (fs.visible[tile] || w.ownerF[tile] === f ? w.ownerF[tile] : fs.knownOwner[tile]);

  for (const st of w.structs) {
    const sd = STRUCTS[st.kind];
    if (!sd.capturable) continue;
    const kf = known(st.tile);
    if (kf === f) {
      // defend only against pressure the site's garrison does not already answer; a quiet or held site needs no plan
      const th = threatAt(w, obs.enemies, st.tile, 6);
      const open = unanswered(w, c, obs, st.tile);
      if (th > 0.8 && open > 0.6) add(PK.DEFEND, st.tile, st.id, st.name, sd.value + 0.2);
      else if (th > 0.2 && obs.engineers.length && !nearKind(w, st.tile, S.BUNKER, 2, f)) add(PK.FORTIFY, st.tile, st.id, st.name, sd.value * 0.6);
    } else if (kf < 0) add(PK.CAPTURE, st.tile, st.id, st.name, sd.value);
    else if (w.atWar(f, kf)) add(PK.ATTACK, st.tile, st.id, st.name, sd.value * 0.9);
  }
  for (const it of fs.intel) {
    if (!w.atWar(f, it.faction)) continue;
    if (it.kind === S.CORE) add(PK.ASSAULT_CORE, it.tile, it.id, `${w.cmdName(w.structById.get(it.id)?.owner ?? -1)} core`, 1.0);
    else if (it.kind === S.DEPOT || it.kind === S.TOWER || it.kind === S.BUNKER) add(PK.RAID, it.tile, it.id, `${STRUCTS[it.kind].name} ${w.siteName(it.tile)}`, 0.5);
  }
  if (obs.core && obs.coreThreat > 0.5) add(PK.DEFEND, obs.core.tile, obs.core.id, `${c.name} core`, 1.2);
  // bridges
  for (const st of w.structs) {
    if (st.kind !== S.BRIDGE) continue;
    const dHome = g.dist(st.tile, c.homeTile);
    if (dHome > 26) continue;
    if (st.broken) { if (obs.engineers.length) add(PK.REPAIR, st.tile, st.id, st.name, 0.45); continue; }
    // sabotage: far bank held by an enemy at war, near bank held by us
    let ownSide = 0, enemySide = 0;
    for (const t of g.within(st.tile, 2)) {
      const of = w.ownerF[t];
      if (of === f) ownSide++; else if (of >= 0 && w.atWar(f, of)) enemySide++;
    }
    if (ownSide >= 3 && enemySide >= 3 && c.doctrine[5] >= 45) add(PK.SABOTAGE, st.tile, st.id, st.name, 0.5);
  }
  // supply extension toward the most valuable unsupplied objective
  if (obs.engineers.length) {
    let bestT = -1, bestV = 0, bestName = '';
    for (const st of w.structs) {
      if (!STRUCTS[st.kind].capturable) continue;
      const sd = fs.supplyDist[st.tile];
      if (sd < 5 || sd > 16) continue;
      const v = STRUCTS[st.kind].value / (1 + g.dist(st.tile, obs.centroid) / 20);
      if (v > bestV) { bestV = v; bestT = st.tile; bestName = st.name; }
    }
    if (bestT >= 0) add(PK.SECURE_SUPPLY, bestT, -1, `supply line toward ${bestName}`, 0.5);
  }
  // reconnaissance: least-recently-seen sector within reach
  {
    let bestTile = -1, bestAge = -1;
    for (let r = 4; r < w.map.h; r += 8) {
      for (let col = 4; col < w.map.w; col += 8) {
        const t = g.idx(col, r);
        if (!w.active[t] || g.dist(t, c.homeTile) > 34 || w.moveCost[t] === 0) continue;
        const ls = fs.lastSeen[t];
        const age = ls < 0 ? 100000 : w.tick - ls;
        if (age > bestAge || (age === bestAge && t < bestTile)) { bestAge = age; bestTile = t; }
      }
    }
    if (bestTile >= 0 && bestAge > 600) add(PK.RECON, bestTile, -1, `recon ${w.siteName(bestTile)}`, 0.35);
  }
  // operation objectives for locked roster members
  const op = w.ops.find((o) => (o.status === 'Locked' || o.status === 'Running') && o.roster.includes(c.id));
  if (op) for (const ob of op.objectives) add(PK.OPERATION, ob.tile, -1, `${op.code} ${ob.name}`, 1.3);
  // team support
  const team = w.teams.find((t) => t.id === c.team);
  if (team && team.leader !== c.id) {
    const leader = w.cmdById.get(team.leader);
    if (leader?.plan && leader.status === 'active') add(PK.SUPPORT, leader.plan.tile, leader.plan.struct, `support ${leader.name}: ${leader.plan.name}`, 0.6);
  }
  out.sort((a, b) => b.quick - a.quick || a.tile - b.tile || a.kind - b.kind);
  const dedup: typeof out = [];
  for (const o of out) {
    if (dedup.some((d) => d.kind === o.kind && d.tile === o.tile)) continue;
    // keep at most two of a kind for diversity
    if (dedup.filter((d) => d.kind === o.kind).length >= 2) continue;
    dedup.push(o);
    if (dedup.length >= 7) break;
  }
  // One slot is reserved for the frontier (§3.4): frontier sites lie 15-25 hexes out, so front-line work nearer the
  // army always fills the cut and the new land would never even be considered. Utility still decides.
  if (w.frontier && !dedup.some((d) => w.isFrontierChunk(w.chunkOf(d.tile)))) {
    const fr = out.find((o) => o.kind === PK.CAPTURE && w.isFrontierChunk(w.chunkOf(o.tile)));
    if (fr) dedup.push(fr);
  }
  const home = obs.core?.tile ?? c.homeTile;
  dedup.push({ kind: PK.REGROUP, tile: home, struct: -1, name: 'regroup at command core', quick: 0 });
  return dedup.map((o) => ({ kind: o.kind, tile: o.tile, struct: o.struct, name: o.name, feats: [], U: 0, L: 0, score: 0 }));
}

/**
 * Planning distance to a target. Neutral captures are measured from the nearer of the army and the home core:
 * frontier chunks open beside each faction's home, far from the front where the army's centroid sits.
 */
function reach(w: World, c: Commander, obs: Obs, kind: number, tile: number): number {
  const d = w.grid.dist(obs.centroid, tile);
  return kind === PK.CAPTURE && c.homeTile >= 0 ? Math.min(d, w.grid.dist(c.homeTile, tile)) : d;
}

function nearKind(w: World, tile: number, kind: number, r: number, f: number): boolean {
  for (const st of w.structs) if (st.kind === kind && st.faction === f && w.grid.dist(st.tile, tile) <= r) return true;
  return false;
}

// ------------------------------------------------------------------ features & scoring
function features(w: World, c: Commander, obs: Obs, cd: Candidate): number[] {
  const g = w.grid;
  const fs = w.factions[c.faction];
  const f = new Array(FEAT_COUNT).fill(0);
  const st = cd.struct >= 0 ? w.structById.get(cd.struct) : undefined;
  let value = 0.3;
  switch (cd.kind) {
    case PK.CAPTURE: case PK.ATTACK: case PK.DEFEND: case PK.FORTIFY: value = st ? STRUCTS[st.kind].value : 0.4; break;
    case PK.ASSAULT_CORE: value = 1; break;
    case PK.RAID: value = 0.5; break;
    case PK.SABOTAGE: value = 0.5; break;
    case PK.REPAIR: value = 0.45; break;
    case PK.SECURE_SUPPLY: value = 0.5; break;
    case PK.RECON: value = 0.3; break;
    case PK.OPERATION: value = 0.9; break;
    case PK.SUPPORT: value = 0.55; break;
    case PK.REGROUP: value = 0.15; break;
  }
  if (cd.kind === PK.DEFEND && st?.kind === S.CORE) value = 1;
  f[0] = value;
  f[1] = 1 - Math.min(1, reach(w, c, obs, cd.kind, cd.tile) / 40);
  const th = threatAt(w, obs.enemies, cd.tile, 4) + structThreat(w, c, cd.tile);
  f[2] = th / (th + Math.max(0.5, obs.strength));
  f[3] = Math.min(1, fs.supplyDist[cd.tile] / 12);
  const ls = fs.lastSeen[cd.tile];
  f[4] = ls < 0 ? 1 : Math.min(1, (w.tick - ls) / 900);
  // New ground: an opening publicly announces its sites as neutral, and settling it means reaching past the supply
  // network by design, so recently opened frontier captures carry half the supply-risk and uncertainty penalties.
  if (cd.kind === PK.CAPTURE && w.recentFrontier(cd.tile)) { f[3] *= 0.5; f[4] *= 0.5; }
  let danger = 0;
  for (const m of c.memory) {
    if (m.kind !== 'DANGER' && m.kind !== 'LESSON') continue;
    const d = g.dist(m.tile, cd.tile);
    if (d <= 6) danger += m.conf * (1 - d / 7);
  }
  f[5] = Math.min(1, danger);
  if (cd.kind === PK.DEFEND || cd.kind === PK.FORTIFY) {
    // a core's exposure is its raw threat (losing it ends the commander); a site's is the pressure its garrison leaves
    const ex = st?.kind === S.CORE ? threatAt(w, obs.enemies, cd.tile, 6) : unanswered(w, c, obs, cd.tile);
    f[6] = ex / (ex + 2);
  }
  f[7] = cd.kind === PK.OPERATION ? 1 : 0;
  const team = w.teams.find((t) => t.id === c.team);
  const leader = team ? w.cmdById.get(team.leader) : undefined;
  if (cd.kind === PK.SUPPORT || (leader && leader.id !== c.id && leader.plan && g.dist(leader.plan.tile, cd.tile) <= 4)) f[8] = 1;
  if (st && (cd.kind === PK.CAPTURE || cd.kind === PK.ATTACK)) {
    if (st.kind === S.MINE) f[9] = 1 - Math.min(1, c.res.alloy / 500);
    else if (st.kind === S.REFINERY) f[9] = 1 - Math.min(1, c.res.energy / 400);
    else if (st.kind === S.HUB || st.kind === S.CITADEL) f[9] = 1 - Math.min(1, (c.res.alloy + c.res.supply) / 900);
  }
  return f;
}

function doctrineUtility(c: Commander, kind: number, f: number[], obs: Obs): number {
  const [ag, ca, lo, ex, loy, de] = c.doctrine.map((v) => v / 100);
  let u = BASE_U[kind];
  u += f[0] * (0.9 + (kind === PK.CAPTURE || kind === PK.ATTACK ? ex * 0.4 : 0));
  u += f[1] * 1.05;
  if (ATTACK_KINDS.has(kind)) u -= f[2] * (0.55 + ca * 0.8 - ag * 0.45);
  // opportunity: a weakly held enemy objective is worth more the less it is defended
  if (kind === PK.ATTACK || kind === PK.RAID || kind === PK.ASSAULT_CORE) u += (1 - f[2]) * (0.2 + ag * 0.35);
  if (kind === PK.DEFEND) u += f[6] * (0.45 + ca * 0.3 + loy * 0.2);
  if (kind === PK.FORTIFY) u += f[6] * (0.3 + ca * 0.5);
  u -= f[3] * (0.25 + lo * 0.6);
  if (kind === PK.RECON) u += f[4] * (0.5 + de * 0.4); else u -= f[4] * (ATTACK_KINDS.has(kind) ? 0.1 + ca * 0.25 : ca * 0.3);
  u -= f[5] * (0.25 + ca * 0.5);
  u += f[7] * 1.25;
  u += f[8] * (0.15 + loy * 0.45);
  u += f[9] * (0.25 + lo * 0.25);
  switch (kind) {
    case PK.ATTACK: case PK.ASSAULT_CORE: u += ag * 0.55; break;
    case PK.RAID: case PK.SABOTAGE: u += de * 0.5 + ag * 0.1; break;
    case PK.SECURE_SUPPLY: case PK.REPAIR: u += lo * 0.5; break;
    case PK.FORTIFY: u += ca * 0.45; break;
    case PK.CAPTURE: u += ex * 0.35; break;
    case PK.RECON: u += de * 0.25; break;
    case PK.REGROUP: u += ca * 0.15 + (obs.strength < 2 ? 0.6 : 0); break;
  }
  if (kind === PK.ASSAULT_CORE && obs.strength < 6) u -= 0.5;
  switch (c.role) {
    case 'quartermaster': if (kind === PK.SECURE_SUPPLY || kind === PK.REPAIR) u += 0.2; break;
    case 'defensive reserve': if (kind === PK.DEFEND || kind === PK.FORTIFY) u += 0.2; break;
    case 'scout': if (kind === PK.RECON) u += 0.2; break;
    case 'assault lead': if (kind === PK.ATTACK || kind === PK.OPERATION || kind === PK.ASSAULT_CORE) u += 0.15; break;
  }
  return u;
}

export function psiOf(kind: number, f: number[]): number[] {
  const psi = new Array(PSI_DIM).fill(0);
  for (let i = 0; i < FEAT_COUNT; i++) psi[i] = f[i];
  psi[FEAT_COUNT + kind] = 1;
  psi[PSI_DIM - 1] = 1;
  return psi;
}

function dot(a: number[], b: number[]): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

export function epsilon(c: Commander): number {
  return Math.max(LEARN.epsilonMin, LEARN.epsilon0 * Math.pow(0.96, c.updates)) * (0.7 + c.doctrine[5] / 170);
}

// ------------------------------------------------------------------ strategic review
export function runStrategic(w: World, c: Commander, trigger: string): void {
  if (c.plan) finishPlan(w, c);
  const obs = observe(w, c);
  const cands = candidates(w, c, obs);
  let bestU = -1;
  let bestUIdx = 0;
  for (let i = 0; i < cands.length; i++) {
    const cd = cands[i];
    cd.feats = features(w, c, obs, cd);
    cd.U = doctrineUtility(c, cd.kind, cd.feats, obs);
    // deconfliction: a same-faction commander already committed here (support plans excepted)
    if (cd.kind !== PK.SUPPORT && cd.kind !== PK.REGROUP) {
      for (const o of w.cmds) {
        if (o.id !== c.id && o.status === 'active' && o.faction === c.faction && o.plan && w.grid.dist(o.plan.tile, cd.tile) <= 3) { cd.U -= 0.3; break; }
      }
    }
    cd.L = dot(c.lw, psiOf(cd.kind, cd.feats));
    cd.score = cd.U + LEARN.lambda * cd.L;
    if (i === 0 || cd.U > bestU) { bestU = cd.U; bestUIdx = i; }
  }
  const order = cands.map((_, i) => i).sort((a, b) => cands[b].score - cands[a].score || a - b);
  let chosen = order[0];
  let explored = false;
  if (w.learning && order.length > 1 && w.rng.float() < epsilon(c)) {
    chosen = order[1 + w.rng.int(Math.min(3, order.length - 1))];
    explored = true;
  }
  const cd = cands[chosen];
  const fallback = cands.length === 1;
  const reason = reasonCode(cd, explored, chosen !== bestUIdx && !explored, fallback);
  const [ag, ca] = [c.doctrine[0] / 100, c.doctrine[1] / 100];
  const posture = ag - ca > 0.2 ? 'AGGRESSIVE' : ca - ag > 0.15 ? 'CAUTIOUS' : 'BALANCED';
  const exposure = obs.coreThreat / (obs.coreThreat + 2);
  const rv = ca * 0.35 + exposure * 0.5 - ag * 0.3;
  const reserve = cd.kind === PK.REGROUP || cd.kind === PK.DEFEND ? 0 : rv < 0.18 ? 0 : rv < 0.38 ? 25 : 50;
  const did = `d-${String(++w.decisionCounter).padStart(5, '0')}`;
  c.plan = {
    kind: cd.kind, tile: cd.tile, struct: cd.struct, name: cd.name, posture, reserve, reason, started: w.tick,
    psi: psiOf(cd.kind, cd.feats), score: cd.score, decisionId: did, explored, base: snapshot(w, c), group: [], done: false,
    pressure: cd.kind === PK.DEFEND ? cd.feats[6] : 1,
  };
  c.stats.plans++;
  c.rel.decisions++;
  if (fallback) c.rel.fallbacks++;
  c.decisions.unshift({
    id: did, tick: w.tick, obsHash: obs.hash, obsSize: obs.size, policy: policyLabel(c), chosen,
    candidates: cands, reason, posture, reserve, explored, fallback, reward: null,
  });
  if (c.decisions.length > DECISION_LOG) c.decisions.length = DECISION_LOG;
  w.story?.onDecision(w, c, cands, order, chosen);
  c.lastReview = w.tick;
  // the world staggers reviews by commander so the load spreads; duels give both sides the identical schedule so a
  // commander's id cannot tilt an equal-budget skill rating
  const span = CLOCK.STRATEGIC_MAX - CLOCK.STRATEGIC_MIN;
  const jitter = w.mode === 'duel' ? (c.stats.plans * 131) % span : (c.id * 97 + c.stats.plans * 31) % span;
  c.nextStrategic = w.tick + CLOCK.STRATEGIC_MIN + jitter;
  // memory maintenance per review
  for (const m of c.memory) m.conf = Math.max(0, m.conf - (m.kind === 'LESSON' ? 0.01 : 0.035));
  c.memory = c.memory.filter((m) => m.conf >= 0.1);
  void trigger;
  // assign squads immediately
  runOperational(w, c);
}

function reasonCode(cd: Candidate, explored: boolean, learned: boolean, fallback: boolean): string {
  if (fallback) return 'FALLBACK_BASELINE';
  if (explored) return 'EXPLORATION';
  const f = cd.feats;
  let base: string;
  switch (cd.kind) {
    case PK.OPERATION: base = 'OPERATION_OBJECTIVE'; break;
    case PK.DEFEND: base = f[0] >= 1 ? 'CORE_THREAT' : 'HOLD_ASSET'; break;
    case PK.SECURE_SUPPLY: base = 'SUPPLY_THREAT'; break;
    case PK.REPAIR: base = 'RESTORE_ROUTE'; break;
    case PK.SABOTAGE: case PK.RAID: base = 'CUT_SUPPLY'; break;
    case PK.RECON: base = 'EXPLORE'; break;
    case PK.SUPPORT: base = 'TEAM_SUPPORT'; break;
    case PK.REGROUP: base = 'REGROUP_LOSSES'; break;
    case PK.FORTIFY: base = 'FORTIFY_FRONT'; break;
    case PK.ASSAULT_CORE: base = 'DECAPITATION'; break;
    default: base = f[2] < 0.3 ? 'WEAK_DEFENSE' : f[9] > 0.5 ? 'RESOURCE_NEED' : f[0] >= 0.8 ? 'HIGH_VALUE' : 'EXPANSION';
  }
  return learned ? `LEARNED_PREFERENCE:${base}` : base;
}

function snapshot(w: World, c: Commander): PlanBase {
  let sites = 0, territory = 0, hp = 0, supplied = 0;
  for (const st of w.structs) if (st.owner === c.id && STRUCTS[st.kind].capturable) sites++;
  for (let t = 0; t < w.grid.n; t++) if (w.owner[t] === c.id) territory++;
  for (const s of w.squads) if (s.owner === c.id) { hp += s.hp / s.maxHp; if (w.factions[c.faction].inSupply[s.tile]) supplied++; }
  const op = w.ops.find((o) => o.roster.includes(c.id) && (o.status === 'Running' || o.status === 'Provisional'));
  return { sites, territory, valueKilled: c.stats.valueKilled, valueLost: c.stats.valueLost, opScore: op ? op.scores[c.id] ?? 0 : 0, hp, supplied, power: c.power };
}

function goalAchieved(w: World, c: Commander, p: Plan): boolean {
  const f = c.faction;
  switch (p.kind) {
    case PK.CAPTURE: case PK.ATTACK: case PK.OPERATION: case PK.DEFEND: case PK.SUPPORT:
      return w.ownerF[p.tile] === f;
    case PK.ASSAULT_CORE: case PK.RAID: {
      const st = w.structById.get(p.struct);
      return !st || st.hp <= 0;
    }
    case PK.SABOTAGE: case PK.REPAIR: {
      const st = w.structById.get(p.struct);
      return p.kind === PK.SABOTAGE ? !!st?.broken : !!st && !st.broken;
    }
    case PK.SECURE_SUPPLY: return w.factions[f].supplyDist[p.tile] <= 3;
    case PK.FORTIFY: return nearKind(w, p.tile, S.BUNKER, 2, f);
    case PK.RECON: return w.factions[f].lastSeen[p.tile] >= p.started;
    case PK.REGROUP: {
      const mine = w.squads.filter((s) => s.owner === c.id);
      return mine.length > 0 && mine.reduce((a, s) => a + s.hp / s.maxHp, 0) / mine.length > 0.75;
    }
  }
  return false;
}

/** Close the active plan: compute realized reward, update the learned value head, write memory. */
function finishPlan(w: World, c: Commander): void {
  const p = c.plan!;
  const cur = snapshot(w, c);
  const b = p.base;
  const achieved = goalAchieved(w, c, p);
  // gains are measured per 90 s of plan time so long plans are not credited for merely lasting longer
  const dur = Math.max(0.6, (w.tick - p.started) / 450);
  const gains =
    (cur.sites - b.sites) * 0.45 +
    (cur.territory - b.territory) / 35 +
    ((cur.valueKilled - b.valueKilled) - (cur.valueLost - b.valueLost)) / 450 +
    (cur.opScore - b.opScore) / 150 +
    // the commander's own world power, so the learner optimises what actually decides the war
    (c.power - (b.power ?? c.power)) / 80;
  // holding a site that was never under real pressure is not an achievement
  const bonus = achieved ? 0.5 * (p.kind === PK.DEFEND ? Math.min(1, (p.pressure ?? 1) * 1.6) : 1) : -0.1;
  const reward = Math.tanh(gains / dur + bonus);
  const rec = c.decisions.find((d) => d.id === p.decisionId);
  if (rec) rec.reward = Math.round(reward * 1000) / 1000;
  w.story?.onPlanClosed(w, c, p, achieved, reward);
  if (w.learning) {
    const adv = reward - c.rewardEma;
    const err = learnStep(c, p.psi, adv, 1);
    // shared experience: every active commander of the faction replays the update at a fraction of the rate against
    // its own baseline (accepted teammates at the full share), so a faction learns from all of its plans
    const team = w.teams.find((t) => t.id === c.team);
    for (const mate of w.cmds) {
      if (mate.id === c.id || mate.status !== 'active' || mate.faction !== c.faction) continue;
      const mateTeam = !!team && team.members.some((m) => m.accepted && m.id === mate.id);
      learnStep(mate, p.psi, reward - mate.rewardEma, LEARN.teamShare * (mateTeam ? 1 : 0.6));
    }
    c.errEma = c.errEma * 0.92 + Math.abs(err) * 0.08;
    c.rewardEma = c.rewardEma * (1 - LEARN.baselineRate) + reward * LEARN.baselineRate;
    c.updates++;
    if (c.updates % LEARN.versionEvery === 0) {
      const prev = policyLabel(c);
      c.policyMinor++;
      c.policyHash = policyHash(c);
      const top = topWeights(c);
      const note = `${LEARN.versionEvery} online updates; strongest learned terms: ${top}`;
      c.policyHistory.push({ tick: w.tick, version: policyLabel(c), note });
      if (c.policyHistory.length > 30) c.policyHistory.shift();
      w.log('policy', `${c.name} policy ${prev} → ${policyLabel(c)} (${note}).`, c.faction, [c.id], -1);
    }
  }
  remember(w, c, { kind: 'PLAN_OUTCOME', tile: p.tile, subject: p.kind, value: Math.round(reward * 100) / 100, conf: 0.6, tick: w.tick, src: p.decisionId });
  if (reward < -0.25 && p.kind !== PK.REGROUP) {
    remember(w, c, { kind: 'DANGER', tile: p.tile, subject: p.kind, value: Math.round(reward * 100) / 100, conf: Math.min(1, 0.4 + Math.abs(reward)), tick: w.tick, src: `${p.decisionId} failed` });
  }
  c.plan = null;
}

/** One LMS step of the value head toward an observed advantage; returns the prediction error. */
function learnStep(c: Commander, psi: number[], adv: number, scale: number): number {
  const err = adv - dot(c.lw, psi);
  for (let i = 0; i < PSI_DIM; i++) {
    const rate = (i < FEAT_COUNT ? LEARN.rate : LEARN.rateKind) * scale;
    c.lw[i] = clamp(c.lw[i] + rate * err * psi[i], -LEARN.clamp, LEARN.clamp);
  }
  return err;
}

function topWeights(c: Commander): string {
  const names = [...FEAT_NAMES_SHORT, ...PLAN_NAMES.map((n) => n.toLowerCase()), 'bias'];
  return c.lw
    .map((v, i) => [v, i] as const)
    .filter(([, i]) => i < PSI_DIM - 1)
    .sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))
    .slice(0, 2)
    .map(([v, i]) => `${names[i]} ${v >= 0 ? '+' : ''}${v.toFixed(2)}`)
    .join(', ');
}
const FEAT_NAMES_SHORT = ['value', 'proximity', 'threat', 'supply risk', 'uncertainty', 'danger', 'exposure', 'operation', 'team', 'econ need'];

export function remember(w: World, c: Commander, fact: MemoryFact): void {
  if (fact.kind === 'DANGER' || fact.kind === 'OPP_TENDENCY') {
    const ex = c.memory.find((m) => m.kind === fact.kind && (fact.kind === 'OPP_TENDENCY' ? m.subject === fact.subject : w.grid.dist(m.tile, fact.tile) <= 2));
    if (ex) {
      ex.conf = Math.min(1, ex.conf + fact.conf * 0.5);
      ex.value = fact.kind === 'OPP_TENDENCY' ? ex.value + 1 : Math.min(ex.value, fact.value);
      ex.tick = fact.tick;
      ex.src = fact.src;
      return;
    }
  }
  if (fact.kind === 'PLAN_OUTCOME') {
    const outcomes = c.memory.filter((m) => m.kind === 'PLAN_OUTCOME');
    if (outcomes.length >= 8) c.memory.splice(c.memory.indexOf(outcomes[outcomes.length - 1]), 1);
  }
  c.memory.unshift(fact);
  if (c.memory.length > MEMORY_CAP) {
    // drop the lowest-confidence non-lesson fact
    let worst = -1;
    for (let i = 0; i < c.memory.length; i++) if (c.memory[i].kind !== 'LESSON' && (worst < 0 || c.memory[i].conf < c.memory[worst].conf)) worst = i;
    c.memory.splice(worst < 0 ? c.memory.length - 1 : worst, 1);
  }
}

/** Squad destroyed: route-failure memory plus opponent tendency. */
export function noteLoss(w: World, c: Commander, tile: number, killerFaction: number): void {
  remember(w, c, { kind: 'DANGER', tile, subject: -1, value: -0.5, conf: 0.3, tick: w.tick, src: `squad lost ${w.siteName(tile)}` });
  if (killerFaction >= 0) remember(w, c, { kind: 'OPP_TENDENCY', tile, subject: killerFaction, value: 1, conf: 0.2, tick: w.tick, src: `${w.factionName(killerFaction)} aggression` });
  // repeated losses during a plan trigger an early review, subject to quota
  if (c.plan && w.tick - c.lastReview > CLOCK.REVIEW_QUOTA) {
    const lost = c.stats.valueLost - c.plan.base.valueLost;
    if (lost > 450) c.nextStrategic = Math.min(c.nextStrategic, w.tick + 5);
  }
}

// ------------------------------------------------------------------ operational layer
const ORDER_TASKS_STRUCT = new Set<number>([PK.ASSAULT_CORE, PK.RAID, PK.SABOTAGE]);

function order(w: World, c: Commander, s: Squad, task: number, tile: number, struct = -1, buildKind = -1): boolean {
  if (s.task === task && s.tgt === tile && s.tgtStruct === struct && (buildKind < 0 || s.buildKind === buildKind)) return true;
  c.rel.issued++;
  // validator: ownership, bounds, passability or adjacency, sealed operation regions
  if (s.owner !== c.id || tile < 0 || tile >= w.grid.n || !w.active[tile]) { c.rel.rejected++; return false; }
  if (w.moveCost[tile] === 0) {
    let adj = false;
    for (let k = 0; k < 6; k++) { const v = w.grid.nb[tile * 6 + k]; if (v >= 0 && w.moveCost[v] > 0) adj = true; }
    if (!adj || (task !== TASK.REPAIR && task !== TASK.ATTACK_STRUCT)) { c.rel.rejected++; return false; }
  }
  if (w.sealedFor(c.id) && w.regionMask[tile]) { c.rel.rejected++; return false; }
  if (struct >= 0 && task === TASK.ATTACK_STRUCT) {
    const st = w.structById.get(struct);
    if (!st || (st.kind !== S.BRIDGE && !w.atWar(c.faction, st.faction))) { c.rel.rejected++; return false; }
  }
  s.task = task; s.tgt = tile; s.tgtStruct = struct; s.buildKind = buildKind;
  return true;
}

export function buildCost(w: World, c: Commander, kind: number): { alloy: number; energy: number } {
  const def = STRUCTS[kind];
  const mod = 100 + w.mods(c.faction).buildCost;
  return { alloy: Math.floor((def.alloy * mod) / 100), energy: Math.floor((def.energy * mod) / 100) };
}

function canAfford(w: World, c: Commander, kind: number): boolean {
  const k = buildCost(w, c, kind);
  return c.res.alloy >= k.alloy && c.res.energy >= k.energy;
}

function buildOrder(w: World, c: Commander, s: Squad, kind: number, tile: number): boolean {
  if (!canAfford(w, c, kind)) return false; // planner checks its own budget before requesting
  const { alloy, energy } = buildCost(w, c, kind);
  c.rel.issued++;
  if (!w.active[tile] || w.ownerF[tile] !== c.faction || w.moveCost[tile] === 0 || w.terrain[tile] === T.CROSSING || w.structAt(tile) || c.res.alloy < alloy || c.res.energy < energy) {
    c.rel.rejected++;
    return false;
  }
  if (w.sealedFor(c.id) && w.regionMask[tile]) { c.rel.rejected++; return false; }
  c.res.alloy -= alloy; c.res.energy -= energy; c.stats.spent += alloy + energy;
  trackOpSpend(w, c, alloy + energy);
  s.task = TASK.BUILD; s.tgt = tile; s.tgtStruct = -1; s.buildKind = kind; s.group = 4;
  return true;
}

function trackOpSpend(w: World, c: Commander, amount: number): void {
  const op = w.ops.find((o) => o.status === 'Running' && o.roster.includes(c.id));
  if (op) op.spent[c.id] = (op.spent[c.id] ?? 0) + amount;
}

export function runOperational(w: World, c: Commander): void {
  c.nextOperational = w.tick + CLOCK.OPERATIONAL;
  const mine = w.squads.filter((s) => s.owner === c.id);
  produce(w, c, mine);
  const p = c.plan;
  if (!p) return;
  const g = w.grid;
  const sealed = w.sealedFor(c.id);
  const coreTile = w.structById.get(c.coreId)?.tile ?? c.homeTile;
  const free: Squad[] = [];
  for (const s of mine) {
    if (s.retreat) continue;
    if (sealed && w.regionMask[s.tile]) { order(w, c, s, TASK.EVACUATE, exitTile(w, s.tile)); s.group = 0; continue; }
    if (s.task === TASK.EVACUATE) s.task = TASK.IDLE;
    free.push(s);
  }
  // early completion → request review (event-driven, quota-limited)
  if (!p.done && w.tick - p.started > 50 && goalAchieved(w, c, p) && p.kind !== PK.DEFEND && p.kind !== PK.REGROUP) {
    p.done = true;
    if (w.tick - c.lastReview > CLOCK.REVIEW_QUOTA) c.nextStrategic = Math.min(c.nextStrategic, w.tick + 40);
  }
  // core defence override
  const fs = w.factions[c.faction];
  let coreThreat = 0;
  for (const e of w.squads) if (w.atWar(c.faction, e.faction) && fs.visible[e.tile] && g.dist(e.tile, coreTile) <= 5) coreThreat += UNITS[e.cls].power;
  if (coreThreat > 0.8 && p.kind !== PK.DEFEND && w.tick - c.lastReview > CLOCK.REVIEW_QUOTA) c.nextStrategic = Math.min(c.nextStrategic, w.tick + 2);

  const combat = free.filter((s) => s.cls === U.RIFLE || s.cls === U.WALKER);
  const arty = free.filter((s) => s.cls === U.ARTILLERY);
  const scouts = free.filter((s) => s.cls === U.SCOUT);
  const engs = free.filter((s) => s.cls === U.ENGINEER);
  const byDist = (t: number) => (a: Squad, b: Squad) => g.dist(a.tile, t) - g.dist(b.tile, t) || a.id - b.id;
  const legal = (t: number) => (sealed && w.regionMask[t] ? outsideRegion(w, t, coreTile) : t);

  // defenders against an immediate core threat
  const defenders = new Set<number>();
  if (coreThreat > 0.8) {
    let power = 0;
    for (const s of combat.slice().sort(byDist(coreTile))) {
      if (power > coreThreat * 1.3) break;
      defenders.add(s.id);
      power += UNITS[s.cls].power;
      order(w, c, s, TASK.ATTACK_MOVE, legal(coreTile));
      s.group = 2;
    }
  }
  const avail = combat.filter((s) => !defenders.has(s.id));
  const targetTile = sealed && w.regionMask[p.tile] ? outsideRegion(w, p.tile, coreTile) : p.tile;
  if (sealed && w.regionMask[p.tile] && w.tick - c.lastReview > CLOCK.REVIEW_QUOTA) c.nextStrategic = Math.min(c.nextStrategic, w.tick + 3);
  const reserveN = p.kind === PK.REGROUP ? 0 : Math.round((avail.length * p.reserve) / 100);
  const sortedToCore = avail.slice().sort(byDist(coreTile));
  const reserve = new Set(sortedToCore.slice(0, reserveN).map((s) => s.id));
  const group: number[] = [];
  // a destroyed target leaves the plan until the next review; hold its ground instead of ordering a dead struct
  const structTask = ORDER_TASKS_STRUCT.has(p.kind) && p.struct >= 0 && w.structById.has(p.struct);
  const holdTile = p.kind === PK.RECON ? frontierTile(w, c, coreTile, targetTile) : targetTile;
  for (const s of avail) {
    if (reserve.has(s.id)) {
      order(w, c, s, TASK.HOLD, legal(reservePost(w, c, coreTile, targetTile)));
      s.group = 2;
      continue;
    }
    s.group = 1;
    group.push(s.id);
    if (p.kind === PK.REGROUP) order(w, c, s, TASK.MOVE, coreTile);
    else if (structTask && p.struct >= 0 && !(sealed && w.regionMask[p.tile])) order(w, c, s, TASK.ATTACK_STRUCT, legal(approachTile(w, targetTile, s.tile)), p.struct);
    // an impassable objective (a destroyed bridge named as an operation objective) is held from its bank
    else order(w, c, s, TASK.ATTACK_MOVE, legal(approachTile(w, holdTile, s.tile)));
  }
  // artillery trails the assault group, inside range of the objective
  for (const s of arty) {
    s.group = 5;
    const line = g.line(targetTile, coreTile);
    const stand = line[Math.min(line.length - 1, 4)] ?? coreTile;
    if (p.kind === PK.REGROUP) order(w, c, s, TASK.MOVE, coreTile);
    else {
      const st2 = legal(w.moveCost[stand] > 0 ? stand : coreTile);
      const useStruct = structTask && !(sealed && w.regionMask[p.tile]);
      order(w, c, s, useStruct ? TASK.ATTACK_STRUCT : TASK.ATTACK_MOVE, st2, useStruct ? p.struct : -1);
    }
  }
  // scouts: reconnaissance around the objective, toward stale tiles
  scouts.forEach((s, i) => {
    s.group = 3;
    if (p.kind === PK.RECON || i > 0 || s.task !== TASK.SCOUT || g.dist(s.tile, s.tgt) <= 1) {
      const center = i === 0 ? targetTile : coreTile;
      const t = staleTile(w, c, center, 9, s.id);
      order(w, c, s, TASK.SCOUT, legal(t));
    }
  });
  p.group = group;
  // engineers
  for (const s of engs) {
    s.group = 4;
    if (s.task === TASK.BUILD || s.task === TASK.REPAIR) {
      if (s.task === TASK.REPAIR && w.structById.get(s.tgtStruct)?.broken === false) s.task = TASK.IDLE;
      else continue;
    }
    if (p.kind === PK.REPAIR && p.struct >= 0) {
      const br = w.structById.get(p.struct);
      if (br?.broken) { order(w, c, s, TASK.REPAIR, br.tile, br.id); continue; }
    }
    // extend supply toward the objective with a depot at the territorial edge
    if (fs.supplyDist[targetTile] > 5 && p.kind !== PK.REGROUP && p.kind !== PK.RECON) {
      const site = depotSite(w, c, targetTile);
      if (site >= 0 && buildOrder(w, c, s, S.DEPOT, site)) continue;
    }
    if (p.kind === PK.FORTIFY || (p.kind === PK.DEFEND && c.doctrine[1] > 55)) {
      const site = bunkerSite(w, c, targetTile);
      if (site >= 0 && buildOrder(w, c, s, S.BUNKER, site)) continue;
    }
    if (c.res.alloy > 420 && c.doctrine[2] > 50 && !nearKind(w, targetTile, S.TOWER, 6, c.faction)) {
      const site = depotSite(w, c, targetTile);
      if (site >= 0 && buildOrder(w, c, s, S.TOWER, site)) continue;
    }
    // otherwise follow the assault group at a safe distance
    const line = g.line(targetTile, coreTile);
    const stand = line[Math.min(line.length - 1, 5)] ?? coreTile;
    order(w, c, s, TASK.MOVE, legal(w.moveCost[stand] > 0 ? stand : coreTile));
  }
}

/** Nearest passable tile outside the sealed operation region. */
function exitTile(w: World, from: number): number {
  let best = from, bd = 999;
  for (const t of w.grid.within(from, 9)) {
    if (!w.active[t] || w.regionMask[t] || w.moveCost[t] === 0) continue;
    const d = w.grid.dist(t, from);
    if (d < bd || (d === bd && t < best)) { bd = d; best = t; }
  }
  return best;
}

/** Walk from a sealed tile back toward `toward` until leaving the region. */
function outsideRegion(w: World, tile: number, toward: number): number {
  const line = w.grid.line(tile, toward);
  for (const t of line) if (w.active[t] && !w.regionMask[t] && w.moveCost[t] > 0) return t;
  return toward;
}

function approachTile(w: World, target: number, from: number): number {
  if (w.moveCost[target] > 0) return target;
  let best = target, bd = 999;
  for (let k = 0; k < 6; k++) {
    const v = w.grid.nb[target * 6 + k];
    if (v < 0 || !w.active[v] || w.moveCost[v] === 0) continue;
    const d = w.grid.dist(v, from);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

function reservePost(w: World, c: Commander, core: number, target: number): number {
  // between the core and the objective, a third of the way out
  const line = w.grid.line(core, target);
  const t = line[Math.min(line.length - 1, Math.max(2, Math.floor(line.length / 3)))] ?? core;
  if (w.active[t] && w.moveCost[t] > 0 && !(w.sealedFor(c.id) && w.regionMask[t])) return t;
  return core;
}

function frontierTile(w: World, c: Commander, core: number, target: number): number {
  const line = w.grid.line(core, target);
  for (let i = line.length - 1; i >= 0; i--) if (w.active[line[i]] && w.ownerF[line[i]] === c.faction && w.moveCost[line[i]] > 0) return line[i];
  return core;
}

function staleTile(w: World, c: Commander, center: number, radius: number, salt: number): number {
  const fs = w.factions[c.faction];
  let best = center, bestAge = -1;
  const tiles = w.grid.within(center, radius);
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[(i + salt * 7) % tiles.length];
    if (!w.active[t] || w.moveCost[t] === 0 || (w.sealedFor(c.id) && w.regionMask[t])) continue;
    const ls = fs.lastSeen[t];
    const age = ls < 0 ? 1e6 : w.tick - ls;
    if (age > bestAge) { bestAge = age; best = t; }
  }
  return best;
}

function depotSite(w: World, c: Commander, target: number): number {
  const fs = w.factions[c.faction];
  const sealed = w.sealedFor(c.id);
  let best = -1, bd = 999;
  for (let t = 0; t < w.grid.n; t++) {
    if (w.ownerF[t] !== c.faction || !w.active[t] || !fs.inSupply[t] || w.moveCost[t] === 0 || w.terrain[t] === T.CROSSING) continue;
    if (sealed && w.regionMask[t]) continue;
    const d = w.grid.dist(t, target);
    if (d >= bd) continue;
    if (w.structAt(t)) continue;
    let near = false;
    for (const st of w.structs) {
      if (st.faction === c.faction && (st.kind === S.DEPOT || st.kind === S.CORE) && w.grid.dist(st.tile, t) < 5) { near = true; break; }
    }
    if (near) continue;
    bd = d; best = t;
  }
  return best;
}

function bunkerSite(w: World, c: Commander, target: number): number {
  const sealed = w.sealedFor(c.id);
  for (const t of w.grid.within(target, 2)) {
    if (sealed && w.regionMask[t]) continue;
    if (w.active[t] && w.ownerF[t] === c.faction && w.moveCost[t] > 0 && w.terrain[t] !== T.CROSSING && !w.structAt(t)) return t;
  }
  return -1;
}

// ------------------------------------------------------------------ production
function produce(w: World, c: Commander, mine: Squad[]): void {
  if (c.queue.length >= 3) return;
  if (mine.length + c.queue.length >= POP.SQUADS_PER_CMD) return;
  const starved = c.underSupplied || c.res.supply < 15;
  const [ag, ca, lo, , , de] = c.doctrine.map((v) => v / 100);
  const counts = [0, 0, 0, 0, 0];
  for (const s of mine) counts[s.cls]++;
  for (const q of c.queue) counts[q.cls]++;
  const plan = c.plan?.kind ?? -1;
  const want = [
    1 + de * 2,
    5 + (plan === PK.DEFEND ? 2 : 0),
    0.6 + ag * 3 + (plan === PK.ASSAULT_CORE ? 1 : 0),
    1 + lo * 1.4,
    ca * 2 + (plan === PK.ASSAULT_CORE || plan === PK.ATTACK ? 0.8 : 0),
  ];
  // a supply-starved commander only builds low-upkeep units, favouring engineers who can raise depots
  if (starved) { want[2] = 0.01; want[4] = 0.01; want[3] += 1; }
  let best = -1, bestNeed = -1e9;
  for (let cls = 0; cls < 5; cls++) {
    const d = UNITS[cls];
    if (c.res.alloy < d.alloy || c.res.energy < d.energy) continue;
    if (starved && d.upkeep > 1) continue;
    const need = (want[cls] - counts[cls]) / want[cls];
    if (need > bestNeed) { bestNeed = need; best = cls; }
  }
  if (best < 0 || bestNeed <= -0.5) return;
  const d = UNITS[best];
  c.res.alloy -= d.alloy; c.res.energy -= d.energy;
  c.stats.spent += d.alloy + d.energy;
  trackOpSpend(w, c, d.alloy + d.energy);
  c.queue.push({ cls: best, left: Math.ceil((d.build * (100 + w.mods(c.faction).prodTime)) / 100) });
}

export const DOCTRINE_NAMES = DOCTRINE;
export { PLAN_COUNT };
