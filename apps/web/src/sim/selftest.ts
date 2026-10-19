// Headless checks (run: npm test). Determinism, ledger conservation, pari-mutuel conservation,
// bounded populations, fog-filtered observations, a world that actually fights, the expanding frontier
// (§3.4), exact save/restore, and tick cost at the 128 x 128 / 24-commander launch target.

declare const process: { argv: string[]; exit(code: number): never };

import { CLOCK, FACTIONS, FRONTIER, MAP_H, MAP_W, POP, PSI_DIM, S, STRUCTS } from '../shared/config.ts';
import { hashStr, hex32 } from '../shared/rng.ts';
import { World } from './world.ts';
import { apportion } from './operations.ts';
import { placeBet, claimGrant } from './market.ts';
import { deserialize, serialize } from './persist.ts';
import { makeCommander } from './agents.ts';
import { findCoreSite } from './society.ts';
import { FlowCache, INF } from './pathing.ts';
import { Rng } from '../shared/rng.ts';

const args = process.argv.slice(2);
const TICKS = Number(args[0] ?? 12000);
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

function run(seed: number, ticks: number, hook?: (w: World) => void): { w: World; ms: number; tickMs: number[] } {
  const w = new World('world', seed);
  const t0 = performance.now();
  const tickMs: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const a = performance.now();
    w.step();
    tickMs.push(performance.now() - a);
    if (!w.ledger.balanced()) { check(`ledger balanced at tick ${w.tick}`, false); break; }
    hook?.(w);
  }
  return { w, ms: performance.now() - t0, tickMs };
}

function pcts(ms: number[]): string {
  const s = ms.slice().sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
  return `p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, p99 ${q(0.99)} ms`;
}
const p95 = (ms: number[]) => ms.slice().sort((a, b) => a - b)[Math.floor(ms.length * 0.95)];

/** Digest of the full simulation state (beyond the rolling hash) for save/restore comparison. */
function digest(w: World): string {
  return hex32(hashStr(JSON.stringify([
    w.tick, w.nextId, w.squads, w.structs, w.rng.state(), w.chunksOpen, w.nextFrontierTick, Array.from(w.owner),
    w.cmds.map((c) => [c.id, c.status, c.res, c.plan?.tile ?? -1, c.nextStrategic, c.nextOperational, c.lw, c.memory.length]),
  ])));
}

const squadsOnClosed = (w: World) => w.squads.filter((s) => !w.active[s.tile]).length;

// 1. determinism: same seed, same hash
const A = run(1234, 1500);
const B = run(1234, 1500);
check('deterministic state hash (seed 1234, 1500 ticks)', A.w.stateHash === B.w.stateHash, `${hex32(A.w.stateHash)} vs ${hex32(B.w.stateHash)}`);
const C = run(99, 300);
check('different seed → different world', C.w.map.terrain.join() !== A.w.map.terrain.join());

// 2. initial theatre: 128 x 128 map, the central 4 x 4 chunks (64 x 64 tiles) open
{
  const w0 = new World('world', 20261018);
  const open = w0.active.reduce((a, v) => a + v, 0);
  const passableClosed = w0.moveCost.some((c, t) => c > 0 && !w0.active[t]);
  check('128 x 128 theatre, 16 initial chunks / 4096 active tiles', w0.map.w === MAP_W && w0.map.h === MAP_H && w0.chunksOpen.length === 16 && open === 4096, `${w0.map.w}x${w0.map.h}, ${w0.chunksOpen.length} chunks, ${open} tiles`);
  check('closed tiles are impassable', !passableClosed);
  const inner = (t: number) => { const c = w0.grid.col(t), r = w0.grid.row(t); return c >= 32 && c <= 95 && r >= 32 && r <= 95; };
  check('initial structures all lie in the open square', w0.structs.every((s) => inner(s.tile) && w0.active[s.tile] === 1), `${w0.structs.length} structures`);
  const fsites = Object.values(w0.map.frontierSites).flat();
  check('frontier sites exist for every frontier chunk but are not structures yet', Object.keys(w0.map.frontierSites).length === 48 && fsites.every((s) => !w0.structAt(s.tile)), `${fsites.length} frontier sites`);
  const names = [...w0.map.sites.map((s) => s.name), ...fsites.map((s) => s.name), ...w0.map.bridges.map((b) => b.name), ...Object.values(w0.map.frontierBridges).flat().map((b) => b.name)];
  check('every site and crossing name is unique', new Set(names).size === names.length, `${names.length} names`);
  const perQuad = [0, 0, 0, 0];
  for (const [ci, list] of Object.entries(w0.map.frontierSites)) { const c = Number(ci) % 8, r = Math.floor(Number(ci) / 8); perQuad[(r >= 4 ? 2 : 0) + (c >= 4 ? 1 : 0)] += list.length; }
  check('frontier sites mirrored across quadrants', perQuad.every((v) => v === perQuad[0]), perQuad.join('/'));
}

// 3. long run with frontier, inactive-tile and save/restore probes
const LONG = Math.max(TICKS, FRONTIER.firstAt + 800);
let closedViolations = 0, samples = 0;
let frontierProbe: { chunks: number; missing: number; dup: number; opened: string[] } | null = null;
let fork: { w2: World; at: number; restoreMs: number; bytes: number } | null = null;
let restoreResult: { a: string; b: string; ha: string; hb: string } | null = null;
let plansAfterOpening = 0, frontierPlans = 0, lockedUnsealed = 0, lockedTicks = 0, activeBefore = 0, activeAfter = 0;
const { w, ms, tickMs } = run(20261018, LONG, (w) => {
  if (w.tick % 100 === 0) { samples++; closedViolations += squadsOnClosed(w); }
  // plans chosen in the first interval after the first opening, and how many of them target frontier land
  if (w.tick > FRONTIER.firstAt && w.tick <= FRONTIER.firstAt + FRONTIER.interval) {
    for (const c of w.cmds) if (c.plan && c.plan.started === w.tick) { plansAfterOpening++; if (w.isFrontierChunk(w.chunkOf(c.plan.tile))) frontierPlans++; }
  }
  if (w.tick === FRONTIER.firstAt - 1) activeBefore = w.cmds.filter((c) => c.status === 'active').length;
  if (w.tick === FRONTIER.firstAt) activeAfter = w.cmds.filter((c) => c.status === 'active').length;
  // a Locked operation must hold the seal for its whole lock lead (outsiders evacuate before the roster deploys)
  const locked = w.ops.find((o) => o.status === 'Locked');
  if (locked) { lockedTicks++; if (w.regionOpId !== locked.id) lockedUnsealed++; }
  if (w.tick === FRONTIER.firstAt + 10) {
    let missing = 0, dup = 0;
    for (const ci of w.lastOpenedChunks()) {
      for (const s of w.map.frontierSites[ci] ?? []) {
        const hits = w.structs.filter((x) => x.tile === s.tile && x.kind === s.kind && x.name === s.name).length;
        if (hits === 0) missing++; else if (hits > 1) dup++;
      }
      for (const b of w.map.frontierBridges[ci] ?? []) if (!w.structs.some((x) => x.tile === b.tile && x.kind === S.BRIDGE)) missing++;
    }
    frontierProbe = { chunks: w.chunksOpen.length, missing, dup, opened: w.lastOpenedChunks().map((ci) => w.chunkName(ci)) };
  }
  // fork after the first opening: snapshot, restore, and run both copies 500 ticks
  if (w.tick === FRONTIER.firstAt + 250) {
    const text = serialize(w);
    const t0 = performance.now();
    const w2 = deserialize(text);
    if (w2) fork = { w2, at: w.tick, restoreMs: performance.now() - t0, bytes: text.length };
  }
  if (fork && w.tick === fork.at + 500) {
    for (let i = 0; i < 500; i++) fork.w2.step();
    restoreResult = { a: digest(w), b: digest(fork.w2), ha: hex32(w.stateHash), hb: hex32(fork.w2.stateHash) };
  }
});
console.log(`\n${LONG} ticks (${(LONG / 5 / 60).toFixed(1)} sim min) in ${(ms / 1000).toFixed(2)} s — tick ${pcts(tickMs)}`);
console.log(`map attempts ${w.map.attempts}, squads ${w.squads.length}, structs ${w.structs.length}, commanders ${w.cmds.length} (${w.cmds.filter((c) => c.status === 'active').length} active), chunks open ${w.chunksOpen.length}/${w.chunkCount()}, caps ${w.activeCap()} active / ${w.factionCapBase()} per faction`);
const terr = [0, 0, 0, 0];
for (let t = 0; t < w.grid.n; t++) if (w.ownerF[t] >= 0) terr[w.ownerF[t]]++;
console.log('territory by faction', terr.join(' / '));
for (const c of w.cmds) {
  const n = w.squads.filter((s) => s.owner === c.id).length;
  console.log(`  ${c.name.padEnd(10)} f${c.faction} ${c.status.padEnd(7)} squads ${String(n).padStart(2)} kills ${String(c.stats.kills).padStart(3)} losses ${String(c.stats.losses).padStart(3)} caps ${String(c.stats.captures).padStart(2)} plans ${String(c.stats.plans).padStart(3)} upd ${String(c.updates).padStart(3)} err ${c.errEma.toFixed(3)} merit ${w.ledger.balance(c.meritAcct)} ${c.policyMajor}.${c.policyMinor} plan=${c.plan ? c.plan.name : '-'} res=${c.res.alloy}/${c.res.energy}/${c.res.supply}`);
}
for (const e of w.chronicle.filter((x) => x.cat === 'frontier' || (x.cat === 'lineage' && x.text.includes('frontier')))) console.log(`  [t${e.tick}] ${e.text}`);
const kills = w.cmds.reduce((a, c) => a + c.stats.kills, 0);
const caps = w.cmds.reduce((a, c) => a + c.stats.captures, 0);
const rejected = w.cmds.reduce((a, c) => a + c.rel.rejected, 0), issued = w.cmds.reduce((a, c) => a + c.rel.issued, 0);
check('combat occurs', kills > 5, `${kills} kills`);
check('sites change hands', caps > 3, `${caps} captures`);
check('agents learn online', w.cmds.some((c) => c.updates > 3), `max updates ${Math.max(...w.cmds.map((c) => c.updates))}`);
const activeN = w.cmds.filter((c) => c.status === 'active').length;
check('population bounded by land-scaled caps', activeN <= w.activeCap() && w.activeCap() <= POP.ACTIVE_MAX && w.squads.length <= w.activeCap() * POP.SQUADS_PER_CMD
  && [0, 1, 2, 3].every((f) => w.cmds.filter((c) => c.faction === f && c.status === 'active').length <= w.factionCap(f)), `${activeN} active / cap ${w.activeCap()}`);
check('memory bounded', w.cmds.every((c) => c.memory.length <= 24));
check('ledger balanced', w.ledger.balanced());
check('validator rejected no orders', rejected === 0, `${rejected} of ${issued} orders rejected`);
const ops = w.ops.map((o) => `${o.code}:${o.status}${o.result ? '(' + o.result + ')' : ''}`).join(' ');
console.log('operations', ops);
console.log('markets', w.markets.map((m) => `${m.id}:${m.status}:${m.bets.length}bets${m.note ? ' [' + m.note + ']' : ''}`).join('\n  '));
check('operations progressed', w.ops.length > 0);
if (LONG > CLOCK.OP_OPEN_LEAD + CLOCK.OP_RUN + 100) check('an operation settled', w.ops.some((o) => o.status === 'Settled' || o.status === 'Voided'));
const fp = frontierProbe as { chunks: number; missing: number; dup: number; opened: string[] } | null;
check(`frontier opened at tick ${FRONTIER.firstAt}: 20 chunks, new sites are structures`, !!fp && fp.chunks === 20 && fp.missing === 0 && fp.dup === 0, fp ? `${fp.chunks} chunks (${fp.opened.join(', ')}), ${fp.missing} missing, ${fp.dup} duplicated` : 'probe not reached');
check('frontier log written per opened chunk', w.chronicle.filter((e) => e.cat === 'frontier').length >= 4);
check('commanders plan on frontier land within one interval of the first opening', frontierPlans >= 1, `${frontierPlans} of ${plansAfterOpening} plans in t${FRONTIER.firstAt}..${FRONTIER.firstAt + FRONTIER.interval}`);
const founding = w.chronicle.filter((e) => e.cat === 'lineage' && e.text.includes('frontier muster: founding'));
check('frontier muster founds one commander per faction when the caps allow', activeAfter >= activeBefore + 4 && founding.length >= 4 && founding.length % 4 === 0,
  `${activeBefore} → ${activeAfter} active at t${FRONTIER.firstAt}; ${founding.length} foundings`);
check('a locked operation is sealed for its whole lock lead', lockedTicks > 0 && lockedUnsealed === 0, `${lockedUnsealed} of ${lockedTicks} locked ticks unsealed`);
check('no squad ever stands on a closed tile', closedViolations === 0, `${samples} samples every 100 ticks, ${closedViolations} violations`);
check('no structure or owned tile on closed land', w.structs.every((s) => w.active[s.tile] === 1) && w.owner.every((o, t) => o < 0 || w.active[t] === 1));
const fk = fork as { w2: World; at: number; restoreMs: number; bytes: number } | null;
const rr = restoreResult as { a: string; b: string; ha: string; hb: string } | null;
check('save → restore → +500 ticks identical after a frontier opening', !!rr && rr.a === rr.b && rr.ha === rr.hb,
  rr && fk ? `snapshot at tick ${fk.at} (${(fk.bytes / 1024).toFixed(0)} KB, restore ${fk.restoreMs.toFixed(0)} ms): digest ${rr.a} vs ${rr.b}, hash ${rr.ha} vs ${rr.hb}` : 'fork not reached');

// 4. user bet path: cap, duplicate idempotency, one outcome
const fresh = new World('world', 77);
for (let i = 0; i < 3000 && !fresh.markets.some((m) => m.status === 'Open'); i++) fresh.step();
const mk = fresh.markets.find((m) => m.status === 'Open');
if (mk) {
  const o = mk.outcomes[0].id;
  const r1 = placeBet(fresh, fresh.wallet.acct, mk.id, o, 60, 'k1');
  const r2 = placeBet(fresh, fresh.wallet.acct, mk.id, o, 60, 'k2');
  const r3 = placeBet(fresh, fresh.wallet.acct, mk.id, o, 10, 'k1');
  const r4 = placeBet(fresh, fresh.wallet.acct, mk.id, mk.outcomes[1].id, 5, 'k4');
  check('bet accepted', r1.ok, r1.msg);
  check('stake cap enforced (10% of balance, ≤100)', !r2.ok, r2.msg);
  check('idempotency key rejects duplicate', !r3.ok, r3.msg);
  check('one outcome per market', !r4.ok, r4.msg);
  check('grant not claimable twice in campaign 0', !claimGrant(fresh, 'g').ok);
} else check('open market available', false);

// 5. apportionment conserves totals
const parts = apportion(1000, [1, 1, 1], [3, 1, 2]);
check('largest-remainder apportionment conserves pool', parts.reduce((a, b) => a + b, 0) === 1000, parts.join(','));

// 6. fog: observation must not include invisible enemies — check ghost sources are visible-at-time
const f0 = w.factions[0];
const leak = w.squads.filter((s) => s.faction !== 0 && f0.visible[s.tile] === 0 && f0.ghosts.some((g) => g.id === s.id && g.tick === w.tick)).length;
check('no live updates of hidden enemies in faction memory', leak === 0);

// 7. proving-ground duels keep world commander ids (any id, not just 1..2): economy stays finite and equal-budget
{
  const snap = (id: number, f: number) => ({ id, name: `P${id}`, doctrine: FACTIONS[f].doctrine.slice(), weights: new Array(PSI_DIM).fill(0), policy: 'v1.0' });
  const bad: string[] = [];
  for (const [a, b] of [[5, 7], [1, 2], [9, 1]]) {
    const dw = new World('duel', 12345, { a: snap(a, 0), b: snap(b, 1) });
    dw.learning = false;
    for (let i = 0; i < 600; i++) dw.step();
    for (const c of dw.cmds) if (![c.res.alloy, c.res.energy, c.res.supply, c.power].every(Number.isFinite)) bad.push(`id ${c.id}`);
  }
  check('duel economy finite for sides with ids 5/7, 1/2, 9/1', bad.length === 0, bad.join(', '));
}

// 8. full expansion: every scheduled event at once, then the launch budget stops growth
{
  const fw = new World('world', 4242);
  const before = fw.structs.length;
  const expected = Object.values(fw.map.frontierSites).flat().length + Object.values(fw.map.frontierBridges).flat().length;
  for (let i = 0; i < 20; i++) if (fw.nextFrontierTick > 0) fw.frontierStep();
  fw.frontierStep(); // past the budget: no-op
  fw.openChunk(fw.chunksOpen[fw.chunksOpen.length - 1]); // already open: no-op
  const budgetLogs = fw.chronicle.filter((e) => e.cat === 'frontier' && e.text.includes('budget')).length;
  const openLogs = fw.chronicle.filter((e) => e.cat === 'frontier' && e.text.startsWith('Frontier opened')).length;
  const tiles = new Set(fw.structs.map((s) => s.tile));
  check('all 64 chunks open after 12 events, then growth stops', fw.chunksOpen.length === 64 && fw.active.every((v) => v === 1) && fw.nextFrontierTick === -1 && budgetLogs === 1 && openLogs === 48,
    `${fw.chunksOpen.length} chunks, ${openLogs} openings, ${budgetLogs} budget notice`);
  // frontier foundings add command cores during expansion; count the frontier specs themselves
  let instantiated = 0, wrong = 0;
  for (const ci of Object.keys(fw.map.frontierSites)) for (const sp of fw.map.frontierSites[Number(ci)]) { const k = fw.structs.filter((x) => x.tile === sp.tile && x.kind === sp.kind && x.name === sp.name).length; if (k === 1) instantiated++; else wrong++; }
  for (const ci of Object.keys(fw.map.frontierBridges)) for (const b of fw.map.frontierBridges[Number(ci)]) { const k = fw.structs.filter((x) => x.tile === b.tile && x.kind === S.BRIDGE).length; if (k === 1) instantiated++; else wrong++; }
  const addedOther = fw.structs.length - before - instantiated - fw.structs.filter((x) => x.kind === S.CORE).length + fw.map.cores.length;
  check('every frontier site and crossing instantiated exactly once', instantiated === expected && wrong === 0 && addedOther === 0 && tiles.size === fw.structs.length, `${instantiated} of ${expected}, ${wrong} missing or duplicated, ${addedOther} unexpected`);
  check('caps reach the launch target (24 active, 6 per faction)', fw.activeCap() === POP.ACTIVE_MAX && fw.factionCapBase() === POP.FACTION_MAX, `${fw.activeCap()} / ${fw.factionCapBase()}`);
  // partial flow fields (exact out to their bound, above it beyond) give the same steps as full fields
  {
    const fc = new FlowCache(fw.grid, fw.moveCost, fw.regionMask);
    const rr = new Rng(7);
    const land: number[] = [];
    for (let t = 0; t < fw.grid.n; t++) if (fw.moveCost[t] > 0) land.push(t);
    let mismatch = 0, settled = 0;
    for (let k = 0; k < 40; k++) {
      const target = land[rr.int(land.length)], from = land[rr.int(land.length)];
      const part = fc.field(target, 0, from), full = fw.flow.compute([target], 0), bound = fc.boundOf(target, 0);
      if (part[from] !== full[from]) mismatch++;
      for (let t = 0; t < fw.grid.n; t++) {
        if (full[t] <= bound) { settled++; if (part[t] !== full[t]) mismatch++; } else if (part[t] <= bound) mismatch++;
      }
    }
    check('partial flow fields exact within their bound, above it beyond', mismatch === 0, `${mismatch} mismatches, ${(settled / 40 / land.length * 100).toFixed(0)}% of land settled on average`);
  }
  const citadel = fw.structs.find((s) => s.kind === S.CITADEL)!;
  const field = fw.flow.compute([citadel.tile], 0);
  const unreachable = fw.structs.filter((s) => (STRUCTS[s.kind].capturable || s.kind === S.BRIDGE) && field[s.tile] >= INF).length;
  check('every site reachable from the citadel with the whole map open', unreachable === 0, `${unreachable} unreachable`);

  // 9. launch-target load: 24 commanders on the fully open 128 x 128 theatre (frontier foundings plus fill-up)
  for (let f = 0; f < 4; f++) {
    while (fw.cmds.filter((c) => c.faction === f && c.status === 'active').length < fw.factionCap(f) && fw.cmds.filter((c) => c.status === 'active').length < fw.activeCap()) {
      const tile = findCoreSite(fw, f);
      if (tile < 0) break;
      const c = makeCommander(fw, { faction: f, doctrine: FACTIONS[f].doctrine.slice(), gen: 1, parents: [], birthKind: 'load test' });
      fw.deployCommander(c, tile, 'founding');
    }
  }
  const nAct = fw.cmds.filter((c) => c.status === 'active').length;
  const settled = fw.cmds.filter((c) => c.status === 'active' && fw.isFrontierChunk(fw.chunkOf(c.homeTile))).length;
  const loadMs: number[] = [];
  let loadClosed = 0;
  for (let i = 0; i < 3000; i++) {
    const a = performance.now();
    fw.step();
    loadMs.push(performance.now() - a);
    if (fw.tick % 100 === 0) loadClosed += squadsOnClosed(fw);
  }
  console.log(`\nlaunch-target load: ${nAct} commanders (${settled} based on frontier land), ${fw.squads.length} squads, ${fw.structs.length} structs after 3000 ticks — tick ${pcts(loadMs)}`);
  check('24 commanders deploy on the open theatre', nAct === POP.ACTIVE_MAX, `${nAct}`);
  check('load test: ledger balanced, no squad on closed land', fw.ledger.balanced() && loadClosed === 0);
  check('tick p95 under 5 ms at 128 x 128 with 24 commanders (Node)', p95(loadMs) < 5, `${p95(loadMs).toFixed(2)} ms`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
