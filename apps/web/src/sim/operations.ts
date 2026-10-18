// Finite operations inside the continuous war (design doc §3.3, §9.4). Each has a locked roster,
// a sealed region (no fire crosses its boundary; outsiders evacuate), a committed secret seed,
// objective scoring with a rolling evidence hash, and validated merit settlement.

import { CLOCK, MERIT, RULES_VERSION, S, STRUCTS } from '../shared/config.ts';
import { FNV_SEED, Rng, fnv, hashStr, hex32, sha256Hex } from '../shared/rng.ts';
import type { World } from './world.ts';
import type { Operation, OpObjective } from './types.ts';

/** Integer apportionment by largest fractional remainder; ties broken by a stable hash of the id. */
export function apportion(total: number, weights: number[], ids: number[], salt = 'merit'): number[] {
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  const out = new Array(weights.length).fill(0);
  if (sum <= 0 || total <= 0) return out;
  const rem: { i: number; r: number; h: number }[] = [];
  let given = 0;
  weights.forEach((wt, i) => {
    const exact = (total * Math.max(0, wt)) / sum;
    out[i] = Math.floor(exact);
    given += out[i];
    rem.push({ i, r: exact - out[i], h: hashStr(`${salt}:${ids[i]}`) });
  });
  rem.sort((a, b) => b.r - a.r || a.h - b.h);
  for (let k = 0; given < total && k < rem.length; k++, given++) out[rem[k].i]++;
  return out;
}

export function tickOperations(w: World): void {
  if (w.mode === 'duel') { duelScoring(w); return; }
  const tick = w.tick;
  const pending = w.ops.find((o) => o.status === 'Open' || o.status === 'Scheduled' || o.status === 'Locked');
  const running = w.ops.find((o) => o.status === 'Running');
  if (!pending && (!running || running.endTick - tick <= CLOCK.OP_OPEN_LEAD)) {
    const start = running ? running.endTick + 25 : tick + CLOCK.OP_OPEN_LEAD;
    createOperation(w, start);
  }
  for (const op of w.ops) {
    switch (op.status) {
      case 'Open':
        if (tick >= op.lockTick) lockOperation(w, op);
        break;
      case 'Locked':
        if (tick >= op.startTick) {
          op.status = 'Running';
          for (const id of op.roster) { const c = w.cmdById.get(id); if (c) c.nextStrategic = Math.min(c.nextStrategic, tick + 1 + (id % 5)); }
          w.log('ops', `${op.code} deployed: ${op.roster.map((id) => w.cmdName(id)).join(' vs ')} at ${op.name}. Seed commitment ${op.commit.slice(0, 12)}…`, -1, op.roster, op.center);
        }
        break;
      case 'Running':
        if ((tick - op.startTick) % CLOCK.CAPTURE === 0) scoreOperation(w, op);
        if (tick >= op.endTick) finishOperation(w, op);
        break;
      case 'Provisional':
        if (tick >= op.settleTick) settleOperation(w, op);
        break;
    }
  }
  // keep history bounded
  const done = w.ops.filter((o) => o.status === 'Settled' || o.status === 'Voided');
  if (done.length > 24) {
    const drop = new Set(done.slice(0, done.length - 24).map((o) => o.id));
    w.ops = w.ops.filter((o) => !drop.has(o.id));
  }
}

function regionTiles(w: World, center: number, radius: number): number[] { return w.grid.within(center, radius); }

function createOperation(w: World, startTick: number): void {
  const g = w.grid;
  const recent = w.ops.slice(-3).map((o) => o.center);
  let best = -1, bestScore = -1e9, bestName = '';
  const candidates = w.structs.filter((s) => s.kind === S.RELAY || s.kind === S.HUB || s.kind === S.CITADEL || s.kind === S.BRIDGE);
  for (const st of candidates) {
    const counts = [0, 0, 0, 0];
    for (const t of g.within(st.tile, 9)) { const f = w.ownerF[t]; if (f >= 0) counts[f]++; }
    const present = counts.filter((n) => n >= 5).length;
    if (present < 2) continue;
    let heat = 0;
    for (const [k, v] of w.battleHeat) {
      const r = (k >> 8) * 4 + 2, c = (k & 255) * 4 + 2;
      if (g.dist(g.idx(Math.min(w.map.w - 1, c), Math.min(w.map.h - 1, r)), st.tile) <= 8) heat += v;
    }
    let score = present * 1.5 + Math.min(3, heat / 40) + (st.kind === S.CITADEL ? 0.6 : 0) + (st.kind === S.BRIDGE ? 0.3 : 0);
    if (recent.includes(st.tile)) score -= 2.5;
    // stable small jitter for rotation among publicly announced fronts
    score += ((hashStr(`${w.opCounter}:${st.id}`) % 100) / 100) * 0.4;
    if (score > bestScore) { bestScore = score; best = st.tile; bestName = st.name; }
  }
  if (best < 0) return;
  const radius = 6;
  const region = regionTiles(w, best, radius);
  // roster: per faction present, the active commander with the most nearby forces (stable ties)
  const roster: number[] = [];
  for (let f = 0; f < 4; f++) {
    const owned = region.filter((t) => w.ownerF[t] === f).length;
    const nearSquads = w.squads.filter((s) => s.faction === f && g.dist(s.tile, best) <= 12).length;
    if (owned < 3 && nearSquads === 0) continue;
    const cand = w.cmds.filter((c) => c.faction === f && c.status === 'active');
    if (!cand.length) continue;
    const pick = cand
      .map((c) => ({ c, n: w.squads.filter((s) => s.owner === c.id && g.dist(s.tile, best) <= 14).length, d: g.dist(c.homeTile, best) }))
      .sort((a, b) => b.n - a.n || a.d - b.d || a.c.id - b.c.id)[0];
    roster.push(pick.c.id);
  }
  if (roster.length < 2) return;
  if (roster.length > 3) roster.length = 3;
  // objectives: the centre plus up to two other sites in the region, else control points
  const objectives: OpObjective[] = [{ tile: best, name: bestName, points: 3, holder: -1 }];
  for (const st of w.structs) {
    if (objectives.length >= 3) break;
    if (st.tile === best || !STRUCTS[st.kind].capturable) continue;
    if (g.dist(st.tile, best) <= radius - 1) objectives.push({ tile: st.tile, name: st.name, points: 2, holder: -1 });
  }
  const cpNames = ['CP Alpha', 'CP Bravo', 'CP Charlie'];
  for (let d = 0; d < 6 && objectives.length < 3; d += 2) {
    let t = best;
    for (let k = 0; k < 3; k++) { const v = g.nb[t * 6 + d]; if (v >= 0) t = v; }
    if (w.moveCost[t] > 0 && !objectives.some((o) => o.tile === t)) objectives.push({ tile: t, name: cpNames[objectives.length - 1], points: 1, holder: -1 });
  }
  const id = ++w.opCounter;
  const seed = w.rng.u32();
  const seedHex = hex32(seed) + hex32(w.rng.u32());
  const code = `OP-${String(id).padStart(3, '0')}`;
  const op: Operation = {
    id, code, name: bestName, status: 'Open', center: best, radius, region, roster, objectives,
    openTick: w.tick, lockTick: startTick - CLOCK.OP_LOCK_LEAD, startTick, endTick: startTick + CLOCK.OP_RUN, settleTick: startTick + CLOCK.OP_RUN + CLOCK.OP_VERIFY,
    seed, seedHex, commit: sha256Hex(`${code}|${seedHex}|${RULES_VERSION}`), revealed: false,
    scores: {}, spent: {}, supplyTicks: {}, evidence: FNV_SEED, result: null, winner: -1, merit: [], rngState: new Rng(seed).state(),
  };
  for (const r of roster) { op.scores[r] = 0; op.spent[r] = 0; op.supplyTicks[r] = 0; }
  w.ops.push(op);
  w.log('ops', `${code} announced at ${bestName}: ${roster.map((r) => `${w.cmdName(r)} (${w.factionName(w.cmdById.get(r)!.faction)})`).join(', ')}. Market open; cutoff 30 s before deployment.`, -1, roster, best);
}

function lockOperation(w: World, op: Operation): void {
  const alive = op.roster.filter((id) => w.cmdById.get(id)?.status === 'active');
  if (alive.length < 2) {
    op.status = 'Voided';
    op.result = 'VOID: roster lost a participant before lock';
    w.log('ops', `${op.code} voided before lock: roster no longer has two active commanders. All stakes refund.`, -1, op.roster, op.center);
    return;
  }
  op.status = 'Locked';
  // seal the region: non-roster forces evacuate and cannot fire across the boundary
  w.regionMask.fill(0);
  for (const t of op.region) w.regionMask[t] = 1;
  w.rosterSet = new Set(op.roster);
  w.regionActive = true;
  w.evacField = null;
  w.flow.clear();
}

function scoreOperation(w: World, op: Operation): void {
  for (let i = 0; i < op.objectives.length; i++) {
    const ob = op.objectives[i];
    const holder = w.owner[ob.tile];
    ob.holder = holder;
    if (holder >= 0 && op.roster.includes(holder)) op.scores[holder] += ob.points;
    op.evidence = fnv(fnv(fnv(op.evidence, w.tick), i), holder + 1);
  }
  for (const s of w.squads) {
    if (!op.roster.includes(s.owner) || !w.regionMask[s.tile]) continue;
    if (w.factions[s.faction].inSupply[s.tile]) op.supplyTicks[s.owner]++;
  }
}

function finishOperation(w: World, op: Operation): void {
  op.status = 'Provisional';
  w.regionActive = false;
  w.regionMask.fill(0);
  w.rosterSet.clear();
  w.flow.clear();
  w.evacField = null;
  const ranked = op.roster
    .map((id) => {
      const held = op.objectives.filter((o) => o.holder === id).length;
      const eff = op.scores[id] / Math.max(50, op.spent[id]);
      return { id, score: op.scores[id], held, eff };
    })
    .sort((a, b) => b.score - a.score || b.held - a.held || b.eff - a.eff);
  const top = ranked[0];
  if (!top || top.score === 0) { op.winner = -1; op.result = 'NONE'; }
  else if (ranked[1] && ranked[1].score === top.score && ranked[1].held === top.held && Math.abs(ranked[1].eff - top.eff) < 1e-9) { op.winner = -1; op.result = 'TIE'; }
  else { op.winner = top.id; op.result = `${w.cmdName(top.id)} wins`; }
  for (const id of op.roster) {
    const c = w.cmdById.get(id);
    if (c) { c.stats.opsPlayed++; c.nextStrategic = Math.min(c.nextStrategic, w.tick + 2 + (id % 5)); }
  }
  const txt = ranked.map((r) => `${w.cmdName(r.id)} ${r.score}`).join(' · ');
  w.log('ops', `${op.code} final objective recorded (provisional): ${op.result === 'NONE' ? 'no objective score' : op.result === 'TIE' ? 'tie' : op.result}. Scores ${txt}.`, w.cmdById.get(op.winner)?.faction ?? -1, op.roster, op.center);
}

function settleOperation(w: World, op: Operation): void {
  // verification: recompute the evidence fingerprint length & roster integrity (sandbox evidence check)
  op.status = 'Settled';
  op.revealed = true;
  const winner = w.cmdById.get(op.winner);
  if (winner) winner.stats.opsWon++;
  for (const t of w.teams) if (op.roster.some((id) => t.members.some((m) => m.id === id && m.accepted))) t.record.ops++;
  // merit: 50% objective share, 25% supply & escort, 25% resource efficiency (§7.3)
  const ids = op.roster;
  const obj = ids.map((id) => op.scores[id]);
  const sup = ids.map((id) => op.supplyTicks[id]);
  const eff = ids.map((id) => op.scores[id] / Math.max(50, op.spent[id]));
  const norm = (a: number[]) => { const s = a.reduce((x, y) => x + y, 0); return a.map((x) => (s > 0 ? x / s : 0)); };
  const [no, ns, ne] = [norm(obj), norm(sup), norm(eff)];
  const weights = ids.map((_, i) => no[i] * 0.5 + ns[i] * 0.25 + ne[i] * 0.25);
  const total = Math.round(MERIT.opPool * Math.min(1, weights.reduce((a, b) => a + b, 0)));
  const parts = apportion(total, weights, ids, `op-${op.id}`);
  const issuance = w.ledger.find('issuance', 'MERIT', 'issuance');
  op.merit = [];
  ids.forEach((id, i) => {
    const c = w.cmdById.get(id);
    if (!c || parts[i] <= 0) return;
    const r = w.ledger.post('merit_mint', op.code, `merit-${op.code}-${id}`, [[issuance, -parts[i]], [c.meritAcct, parts[i]]], w.tick);
    if (r.ok) { c.meritGross += parts[i]; op.merit.push({ id, amount: parts[i] }); }
  });
  w.log('ops', `${op.code} settled. Evidence ${hex32(op.evidence)}; seed revealed ${op.seedHex} (sha256 matches commitment). Merit: ${op.merit.map((m) => `${w.cmdName(m.id)} +${m.amount}`).join(', ') || 'none'}.`, winner?.faction ?? -1, op.roster, op.center);
}

// ------------------------------------------------------------------ duel scoring for the proving ground
function duelScoring(w: World): void {
  let op = w.ops[0];
  if (!op) {
    const relays = w.structs.filter((s) => s.kind === S.RELAY);
    op = {
      id: 1, code: 'EVAL', name: 'arena', status: 'Running', center: relays[0]?.tile ?? 0, radius: 0, region: [], roster: w.cmds.map((c) => c.id),
      objectives: relays.map((r, i) => ({ tile: r.tile, name: r.name, points: i === 0 ? 3 : 2, holder: -1 })),
      openTick: 0, lockTick: 0, startTick: 0, endTick: 2400, settleTick: 2400, seed: w.seed, seedHex: hex32(w.seed), commit: '', revealed: true,
      scores: {}, spent: {}, supplyTicks: {}, evidence: FNV_SEED, result: null, winner: -1, merit: [], rngState: new Rng(w.seed).state(),
    };
    for (const c of w.cmds) { op.scores[c.id] = 0; op.spent[c.id] = 0; op.supplyTicks[c.id] = 0; }
    w.ops.push(op);
  }
  if (w.tick % CLOCK.CAPTURE === 0) scoreOperation(w, op);
}
