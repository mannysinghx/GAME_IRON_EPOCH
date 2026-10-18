// Builds spectator views from committed world state. Views are read-only projections: frames for the
// renderer, a UI snapshot for the side panels, and an agent dossier for the selected commander.

import { CLOCK, DOCTRINE, FACTIONS, FEATURES, PLAN_NAMES, POP, STRUCTS, UNITS, U } from '../shared/config.ts';
import { hex32 } from '../shared/rng.ts';
import {
  FX_STRIDE, SF, STRUCT_STRIDE, UF, UNIT_STRIDE,
  type CommanderView, type Dossier, type FactionView, type FrameMsg, type MapStatic, type MarketView, type OperationView,
  type PerfView, type PlanView, type TeamView, type UiSnapshot,
} from '../shared/protocol.ts';
import type { World } from './world.ts';
import { TASK, TASK_NAMES, type Commander, type Operation, type Team } from './types.ts';
import { epsilon, policyLabel } from './agents.ts';
import { reliability } from './society.ts';
import { totals, userEscrow } from './market.ts';

export interface ViewState {
  lastChronId: number;
  seriesVersion: number;
  viewFaction: number;
  lastTerritory: number;
  lastSupplyTick: number;
  opRegionKey: string;
  selected: number;
}

export function newViewState(): ViewState {
  return { lastChronId: 0, seriesVersion: -1, viewFaction: -1, lastTerritory: -1, lastSupplyTick: -1, opRegionKey: '', selected: -1 };
}

export function buildStatic(w: World): MapStatic {
  return {
    w: w.map.w, h: w.map.h, seed: w.seed, worldId: w.worldId, rulesVersion: w.rulesVersion(),
    terrain: w.terrain.slice(), elev: w.elev.slice(), variant: w.map.variant.slice(),
    sites: w.structs.filter((s) => STRUCTS[s.kind].capturable || s.kind === 4).map((s) => ({ id: s.id, kind: s.kind, tile: s.tile, name: s.name })),
  };
}

export function buildFrame(w: World, vs: ViewState): { msg: FrameMsg; transfer: ArrayBuffer[] } {
  const units = new Float32Array(w.squads.length * UNIT_STRIDE);
  let k = 0;
  for (const s of w.squads) {
    const need = s.next >= 0 ? (w.moveCost[s.next] || 10) * 10 : 1;
    let flags = 0;
    if (s.retreat) flags |= UF.RETREAT;
    if (w.tick - s.combatT < 10) flags |= UF.COMBAT;
    if ((s.task === TASK.BUILD || s.task === TASK.REPAIR) && w.grid.dist(s.tile, s.tgt) <= 1) flags |= UF.BUILDING;
    if (w.factions[s.faction].inSupply[s.tile]) flags |= UF.SUPPLIED;
    if (s.cls === U.ARTILLERY && s.setup >= 5) flags |= UF.SETUP;
    if (s.kills >= 5) flags |= UF.VETERAN;
    if (s.task === TASK.EVACUATE) flags |= UF.EVAC;
    units[k++] = s.id; units[k++] = s.cls; units[k++] = s.faction; units[k++] = s.owner;
    units[k++] = s.tile; units[k++] = s.next; units[k++] = s.next >= 0 ? Math.min(1, s.prog / need) : 0;
    units[k++] = Math.max(0, s.hp / s.maxHp); units[k++] = s.supply / 100; units[k++] = s.morale / 100;
    units[k++] = flags; units[k++] = s.lastTarget;
  }
  const op = w.ops.find((o) => o.status === 'Locked' || o.status === 'Running');
  const objTiles = new Set(op ? op.objectives.map((o) => o.tile) : []);
  const structs = new Float32Array(w.structs.length * STRUCT_STRIDE);
  k = 0;
  for (const st of w.structs) {
    let flags = 0;
    if (st.broken) flags |= SF.BROKEN;
    if (st.built < st.need) flags |= SF.CONSTRUCTING;
    if (objTiles.has(st.tile)) flags |= SF.OBJECTIVE;
    structs[k++] = st.id; structs[k++] = st.kind; structs[k++] = st.tile; structs[k++] = st.faction; structs[k++] = st.owner;
    structs[k++] = st.maxHp > 0 ? Math.max(0, st.hp / st.maxHp) : 1;
    structs[k++] = st.need > 0 ? Math.min(1, st.built / st.need) : 1;
    structs[k++] = flags;
  }
  const fx = Float32Array.from(w.fx);
  w.fx.length = 0;
  const msg: FrameMsg = { type: 'frame', tick: w.tick, units, structs, fx };
  const transfer: ArrayBuffer[] = [units.buffer as ArrayBuffer, structs.buffer as ArrayBuffer, fx.buffer as ArrayBuffer];
  if (w.territoryDirty) {
    w.territoryDirty = false;
    msg.territory = w.ownerF.slice();
    msg.owner = w.owner.slice();
    transfer.push(msg.territory.buffer as ArrayBuffer, msg.owner.buffer as ArrayBuffer);
  }
  if (w.supplyDirty) {
    w.supplyDirty = false;
    const sup = new Uint8Array(w.grid.n);
    for (const fs of w.factions) for (let t = 0; t < w.grid.n; t++) if (fs.inSupply[t]) sup[t] |= 1 << fs.id;
    msg.supply = sup;
    transfer.push(sup.buffer as ArrayBuffer);
  }
  if (vs.viewFaction >= 0 && vs.viewFaction < w.factions.length) {
    const fs = w.factions[vs.viewFaction];
    const fog = new Uint8Array(w.grid.n);
    for (let t = 0; t < w.grid.n; t++) fog[t] = fs.visible[t] ? 2 : fs.lastSeen[t] >= 0 ? 1 : 0;
    msg.fog = fog;
    const gh = new Float32Array(fs.ghosts.length * 4);
    fs.ghosts.forEach((g, i) => { gh[i * 4] = g.tile; gh[i * 4 + 1] = g.cls; gh[i * 4 + 2] = g.faction; gh[i * 4 + 3] = w.tick - g.tick; });
    msg.ghosts = gh;
    transfer.push(fog.buffer as ArrayBuffer, gh.buffer as ArrayBuffer);
  }
  const key = op ? `${op.id}:${op.status === 'Locked' || op.status === 'Running'}` : 'none';
  if (key !== vs.opRegionKey) {
    vs.opRegionKey = key;
    msg.opRegion = op ? Int32Array.from(op.region) : null;
    if (msg.opRegion) transfer.push(msg.opRegion.buffer as ArrayBuffer);
  }
  msg.storms = w.storms;
  return { msg, transfer };
}

// ------------------------------------------------------------------ UI snapshot
function wilson(wins: number, n: number): [number, number, number] {
  if (n === 0) return [0.5, 0, 1];
  const z = 1.96, p = wins / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [p, Math.max(0, c - h), Math.min(1, c + h)];
}

function planView(w: World, c: Commander): PlanView | null {
  const p = c.plan;
  if (!p) return null;
  return { kind: PLAN_NAMES[p.kind], target: p.name, targetTile: p.tile, posture: p.posture, reserve: p.reserve, reason: p.reason, started: p.started, score: Math.round(p.score * 1000) / 1000, explored: p.explored };
}

export function commanderView(w: World, c: Commander, mineCount: number, territory: number, sites: number): CommanderView {
  const games = c.evalGames;
  const [wr, lo, hi] = wilson(c.evalWins + c.evalDraws * 0.5, games);
  return {
    id: c.id, key: c.key, name: c.name, faction: c.faction, status: c.awaiting ? 'awaiting' : c.status, gen: c.gen,
    power: c.status === 'active' ? c.power : 0, territory, squads: mineCount, sites,
    elo: Math.round(c.elo), eloCi: Math.round(games ? 400 / Math.sqrt(games) : 400), evalGames: games, provisional: games < 10,
    winRate: wr, winLo: lo, winHi: hi,
    merit: w.ledger.balance(c.meritAcct), meritGross: c.meritGross, meritSpent: c.meritSpent,
    kills: c.stats.kills, losses: c.stats.losses, reliability: reliability(c), fallbackRate: c.rel.decisions ? c.rel.fallbacks / c.rel.decisions : 0,
    opsPlayed: c.stats.opsPlayed, opsWon: c.stats.opsWon, plans: c.stats.plans, policy: policyLabel(c), plan: planView(w, c),
    team: c.team, role: c.role, res: { ...c.res }, errEma: c.errEma, updates: c.updates, parents: c.parents.slice(), children: c.children.slice(),
    powerHist: c.hist.power.slice(-40),
  };
}

function teamView(t: Team): TeamView { return { ...t, members: t.members.map((m) => ({ ...m })), record: { ...t.record } }; }

export function opView(w: World, op: Operation): OperationView {
  return {
    id: op.id, code: op.code, name: op.name, status: op.status, regionCenter: op.center, radius: op.radius, roster: op.roster.slice(),
    scores: op.roster.map((id) => ({ id, score: op.scores[id] ?? 0, efficiency: Math.round(((op.scores[id] ?? 0) / Math.max(50, op.spent[id] ?? 0)) * 100) / 100, supply: op.supplyTicks[id] ?? 0 })),
    objectives: op.objectives.map((o) => ({ ...o, holder: w.owner[o.tile] })),
    openTick: op.openTick, lockTick: op.lockTick, startTick: op.startTick, endTick: op.endTick, settleTick: op.settleTick,
    seedCommit: op.commit, seedReveal: op.revealed ? op.seedHex : null, result: op.result, winner: op.winner, merit: op.merit.slice(),
  };
}

export function buildUi(w: World, vs: ViewState, speed: number, paused: boolean, perf: PerfView, proving: { running: boolean }): UiSnapshot {
  const g = w.grid;
  const n = g.n;
  const terrF = [0, 0, 0, 0];
  const terrC = new Map<number, number>();
  let passable = 0;
  const suppliedF = [0, 0, 0, 0];
  for (let t = 0; t < n; t++) {
    if (w.moveCost[t] > 0) passable++;
    const f = w.ownerF[t];
    if (f >= 0) { terrF[f]++; if (w.factions[f].inSupply[t]) suppliedF[f]++; }
    const o = w.owner[t];
    if (o >= 0) terrC.set(o, (terrC.get(o) ?? 0) + 1);
  }
  const sitesC = new Map<number, number>();
  const sitesF = [0, 0, 0, 0];
  const structF = [0, 0, 0, 0];
  for (const st of w.structs) {
    if (st.faction < 0) continue;
    if (STRUCTS[st.kind].capturable) { sitesF[st.faction]++; sitesC.set(st.owner, (sitesC.get(st.owner) ?? 0) + 1); }
    else structF[st.faction]++;
  }
  const squadsC = new Map<number, number>();
  const byClassF = [0, 1, 2, 3].map(() => [0, 0, 0, 0, 0]);
  for (const s of w.squads) { squadsC.set(s.owner, (squadsC.get(s.owner) ?? 0) + 1); byClassF[s.faction][s.cls]++; }
  const factions: FactionView[] = FACTIONS.map((fd, f) => {
    const cs = w.cmds.filter((c) => c.faction === f);
    const act = cs.filter((c) => c.status === 'active');
    const sum = (k: 'alloy' | 'energy' | 'supply') => act.reduce((a, c) => a + c.res[k], 0);
    const inc = (k: 'alloy' | 'energy' | 'supply') => act.reduce((a, c) => a + c.lastIncome[k], 0) * 12;
    return {
      id: f, name: fd.name, css: fd.css, territory: terrF[f], territoryPct: passable ? terrF[f] / passable : 0, sites: sitesF[f],
      squads: byClassF[f].reduce((a, b) => a + b, 0), byClass: byClassF[f], power: act.reduce((a, c) => a + c.power, 0),
      stock: { alloy: sum('alloy'), energy: sum('energy'), supply: sum('supply') }, income: { alloy: inc('alloy'), energy: inc('energy'), supply: inc('supply') },
      upkeep: act.reduce((a, c) => a + c.lastUpkeep, 0) * 12, kills: w.factions[f].kills, losses: w.factions[f].losses,
      active: act.length, reserve: cs.filter((c) => c.status === 'reserve').length, structures: structF[f],
      powerHist: w.factions[f].powerHist.slice(-40), inSupplyPct: terrF[f] ? suppliedF[f] / terrF[f] : 0, capBonus: w.factions[f].capBonus,
    };
  });
  const relations = [0, 1, 2, 3].map((a) => [0, 1, 2, 3].map((b) => {
    if (a === b) return -1;
    const t = w.treaties.find((x) => x.status !== 'ended' && ((x.a === a && x.b === b) || (x.a === b && x.b === a)));
    return t ? (t.status === 'notice' ? 2 : 1) : 0;
  }));
  const commanders = w.cmds.filter((c) => c.status !== 'retired' || w.tick - c.reserveSince < CLOCK.CAMPAIGN)
    .map((c) => commanderView(w, c, squadsC.get(c.id) ?? 0, terrC.get(c.id) ?? 0, sitesC.get(c.id) ?? 0));
  const live = w.ops.find((o) => o.status === 'Running' || o.status === 'Locked' || o.status === 'Provisional');
  const next = w.ops.find((o) => o.status === 'Open' || o.status === 'Scheduled');
  const recentOps = w.ops.filter((o) => o.status === 'Settled' || o.status === 'Voided').slice(-6).reverse().map((o) => opView(w, o));
  const avail = w.ledger.balance(w.wallet.acct);
  const markets: MarketView[] = w.markets.slice(-8).reverse().map((m) => {
    const t = totals(m);
    const mineBets = m.bets.filter((b) => b.account === w.wallet.acct);
    const myStake = mineBets.reduce((a, b) => a + b.stake, 0);
    const cap = m.caps[w.wallet.acct] ?? Math.max(1, Math.min(100, Math.floor(avail / 10)));
    return {
      id: m.id, opId: m.opId, question: m.question, kind: m.kind, status: m.status,
      outcomes: m.outcomes.map((o) => ({
        id: o.id, label: o.label, css: o.faction >= 0 ? FACTIONS[o.faction].css : '#8a93a2', pool: t[o.id] ?? 0,
        bettors: new Set(m.bets.filter((b) => b.outcome === o.id).map((b) => b.account)).size,
        mine: mineBets.filter((b) => b.outcome === o.id).reduce((a, b) => a + b.stake, 0),
      })),
      total: Object.values(t).reduce((a, b) => a + b, 0), cutoffTick: m.cutoffTick, endTick: m.endTick, specHash: m.specHash,
      myOutcome: m.positions[w.wallet.acct] ?? null, myStake, myCap: cap, result: m.result,
      resultLabel: m.result ? m.outcomes.find((o) => o.id === m.result)?.label ?? m.result : null, note: m.note,
    };
  });
  const ci = Math.floor(w.tick / CLOCK.CAMPAIGN);
  const chron = w.chronicle.filter((e) => e.id > vs.lastChronId).slice(-400);
  if (chron.length) vs.lastChronId = chron[chron.length - 1].id;
  let series = null;
  if (w.series.version !== vs.seriesVersion) {
    vs.seriesVersion = w.series.version;
    const elo: Record<number, number[]> = {};
    for (const c of w.cmds) if (c.status !== 'retired') elo[c.id] = c.hist.elo.slice();
    series = { ...w.series, territory: w.series.territory.map((a) => a.slice()), power: w.series.power.map((a) => a.slice()), squads: w.series.squads.map((a) => a.slice()), kills: w.series.kills.map((a) => a.slice()), ticks: w.series.ticks.slice(), learnErr: w.series.learnErr.slice(), reward: w.series.reward.slice(), elo };
  }
  const L = w.ledger;
  const accName = (a: number) => L.st.accounts[a]?.owner ?? `#${a}`;
  const battles = [...w.battleHeat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => ({
    tile: g.idx(Math.min(w.map.w - 1, (k & 255) * 4 + 2), Math.min(w.map.h - 1, (k >> 8) * 4 + 2)), intensity: v,
  }));
  return {
    clock: {
      tick: w.tick, simSeconds: w.tick / 5, chapter: Math.floor(w.tick / CLOCK.CHAPTER) + 1, campaign: ci + 1, opIndex: w.opCounter,
      campaignProgress: (w.tick % CLOCK.CAMPAIGN) / CLOCK.CAMPAIGN, chapterProgress: (w.tick % CLOCK.CHAPTER) / CLOCK.CHAPTER,
      nextCampaignTick: (ci + 1) * CLOCK.CAMPAIGN, nextChapterTick: (Math.floor(w.tick / CLOCK.CHAPTER) + 1) * CLOCK.CHAPTER,
    },
    speed, paused,
    world: { id: w.worldId, seed: w.seed, rules: w.rulesVersion(), squads: w.squads.length, structures: w.structs.length, events: w.chronId - 1, generation: Math.max(...w.cmds.map((c) => c.gen)) },
    factions, relations, commanders,
    teams: w.teams.map(teamView),
    treaties: w.treaties.slice(-8).map((t) => ({ id: t.id, a: t.a, b: t.b, kind: t.kind, status: t.status, effective: t.effective, expires: t.expires, noticeAt: t.noticeAt })),
    operation: live ? opView(w, live) : null,
    nextOperation: next ? opView(w, next) : null,
    recentOps, markets,
    wallet: {
      name: w.wallet.name, available: avail, escrow: userEscrow(w), bets: w.wallet.bets, wins: w.wallet.wins, losses: w.wallet.losses, refunds: w.wallet.refunds,
      net: w.wallet.net, grantReady: ci > w.wallet.grantLastCampaign, nextGrantTick: (w.wallet.grantLastCampaign + 1) * CLOCK.CAMPAIGN,
      receipts: w.wallet.receipts.slice(0, 16), netHist: w.wallet.netHist.slice(-60),
    },
    ledger: {
      txCount: L.st.nextTx - 1, balanced: L.balanced(), minted: L.st.totals.minted, escrow: L.totalOf('escrow', 'SIG'), paid: L.st.totals.paid,
      refunded: L.st.totals.refunded, retired: L.st.totals.retired, meritMinted: L.st.totals.meritMinted, meritSpent: L.st.totals.meritSpent,
      recent: L.st.txs.slice(-14).reverse().map((t) => ({ id: t.id, type: t.type, ref: t.ref, tick: t.tick, postings: t.postings.map(([a, v]) => [accName(a), v] as [string, number]) })),
    },
    chronicle: chron,
    perf: { ...perf, memoryFacts: w.cmds.reduce((a, c) => a + c.memory.length, 0), decisions: w.decisionCounter, flowFields: w.flow.size, flowHits: w.flow.hits, flowMisses: w.flow.misses, visMs: w.perf.visMs, agentMs: w.perf.agentMs, stateHash: hex32(w.stateHash), hashHist: w.hashHist.slice(), entities: w.squads.length + w.structs.length },
    series,
    weather: w.weather.map((s) => ({ ...s, active: w.tick >= s.start && w.tick < s.end })),
    proving: { matches: w.evalCounter, running: proving.running, recent: w.evals.slice(-12).reverse() },
    battles,
    narrative: w.narrative.slice(-6),
  };
}

// ------------------------------------------------------------------ dossier
export function buildDossier(w: World, id: number): Dossier | null {
  const c = w.cmdById.get(id);
  if (!c) return null;
  const ancestors: Dossier['lineage']['ancestors'] = [];
  let cur: Commander | undefined = c;
  const seen = new Set<number>();
  while (cur && cur.parents.length && ancestors.length < 6) {
    const p = w.cmdById.get(cur.parents[0]);
    if (!p || seen.has(p.id)) break;
    seen.add(p.id);
    ancestors.push({ id: p.id, name: p.name, gen: p.gen, status: p.status });
    cur = p;
  }
  const team = w.teams.find((t) => t.id === c.team);
  const mine = w.squads.filter((s) => s.owner === c.id);
  return {
    id: c.id, key: c.key, name: c.name, faction: c.faction, status: c.awaiting ? 'awaiting' : c.status, gen: c.gen, born: c.born, birthKind: c.birthKind,
    doctrine: c.doctrine.slice(), mutation: c.mutation.slice(),
    policy: policyLabel(c), policyHash: c.policyHash, policyHistory: c.policyHistory.slice(-10).reverse(),
    weights: c.lw.slice(), featureNames: [...FEATURES], planNames: PLAN_NAMES,
    updates: c.updates, errEma: c.errEma, rewardEma: c.rewardEma, epsilon: epsilon(c),
    memory: c.memory.map((m) => ({ kind: m.kind, tile: m.tile, place: m.tile >= 0 ? w.siteName(m.tile) : '', value: m.value, conf: m.conf, age: w.tick - m.tick, src: m.src })),
    decisions: c.decisions.slice(0, 8).map((d) => ({
      id: d.id, tick: d.tick, obsHash: d.obsHash, obsSize: d.obsSize, policy: d.policy, chosen: PLAN_NAMES[d.candidates[d.chosen].kind], target: d.candidates[d.chosen].name,
      reason: d.reason, posture: d.posture, reserve: d.reserve, explored: d.explored, fallback: d.fallback, reward: d.reward,
      candidates: d.candidates.map((cd, i) => ({ kind: PLAN_NAMES[cd.kind], target: cd.name, tile: cd.tile, U: round3(cd.U), L: round3(cd.L), score: round3(cd.score), feats: cd.feats.map(round3), chosen: i === d.chosen })),
    })),
    plan: c.plan ? { ...planView(w, c)!, group: c.plan.group.slice() } : null,
    lineage: { ancestors, children: c.children.map((k) => w.cmdById.get(k)).filter(Boolean).map((x) => ({ id: x!.id, name: x!.name, gen: x!.gen, status: x!.awaiting ? 'awaiting' : x!.status })) },
    hist: { power: c.hist.power.slice(), merit: c.hist.merit.slice(), elo: c.hist.elo.slice(), err: c.hist.err.slice() },
    squads: mine.map((s) => ({ id: s.id, cls: s.cls, hp: s.hp / s.maxHp, task: TASK_NAMES[s.task] })),
    stats: {
      kills: c.stats.kills, losses: c.stats.losses, captures: c.stats.captures, opsPlayed: c.stats.opsPlayed, opsWon: c.stats.opsWon,
      plans: c.stats.plans, built: c.stats.built, produced: c.stats.produced, spent: c.stats.spent,
      ordersIssued: c.rel.issued, ordersRejected: c.rel.rejected, fallbacks: c.rel.fallbacks,
      valueKilled: c.stats.valueKilled, valueLost: c.stats.valueLost, power: c.power, elo: Math.round(c.elo), evalGames: c.evalGames,
      evalWins: c.evalWins, evalDraws: c.evalDraws, merit: w.ledger.balance(c.meritAcct), meritGross: c.meritGross, meritSpent: c.meritSpent,
      reliability: Math.round(reliability(c) * 1000) / 10, squadCap: POP.SQUADS_PER_CMD,
    },
    team: team ? teamView(team) : null,
    res: { ...c.res }, queue: c.queue.map((q) => ({ cls: q.cls, left: q.left })),
    dangerTiles: c.memory.filter((m) => m.kind === 'DANGER' || m.kind === 'LESSON').map((m) => ({ tile: m.tile, conf: m.conf })),
  };
}

function round3(v: number): number { return Math.round(v * 1000) / 1000; }

export { DOCTRINE, UNITS };
