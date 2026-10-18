// Headless checks (run: npm test). Determinism, ledger conservation, pari-mutuel conservation,
// bounded populations, fog-filtered observations, and a world that actually fights.

declare const process: { argv: string[]; exit(code: number): never };

import { CLOCK, POP } from '../shared/config.ts';
import { hex32 } from '../shared/rng.ts';
import { World } from './world.ts';
import { apportion } from './operations.ts';
import { placeBet, claimGrant } from './market.ts';

const args = process.argv.slice(2);
const TICKS = Number(args[0] ?? 6000);
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

function run(seed: number, ticks: number): { w: World; ms: number; tickMs: number[] } {
  const w = new World('world', seed);
  const t0 = performance.now();
  const tickMs: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const a = performance.now();
    w.step();
    tickMs.push(performance.now() - a);
    if (!w.ledger.balanced()) { check(`ledger balanced at tick ${w.tick}`, false); break; }
  }
  return { w, ms: performance.now() - t0, tickMs };
}

// 1. determinism: same seed, same hash
const A = run(1234, 1500);
const B = run(1234, 1500);
check('deterministic state hash (seed 1234, 1500 ticks)', A.w.stateHash === B.w.stateHash, `${hex32(A.w.stateHash)} vs ${hex32(B.w.stateHash)}`);
const C = run(99, 300);
check('different seed → different world', C.w.map.terrain.join() !== A.w.map.terrain.join());

// 2. long run
const { w, ms, tickMs } = run(20261018, TICKS);
tickMs.sort((a, b) => a - b);
const pct = (p: number) => tickMs[Math.min(tickMs.length - 1, Math.floor(tickMs.length * p))].toFixed(2);
console.log(`\n${TICKS} ticks (${(TICKS / 5 / 60).toFixed(1)} sim min) in ${(ms / 1000).toFixed(2)} s — tick p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, p99 ${pct(0.99)} ms`);
console.log(`map attempts ${w.map.attempts}, squads ${w.squads.length}, structs ${w.structs.length}, commanders ${w.cmds.length} (${w.cmds.filter((c) => c.status === 'active').length} active)`);
const terr = [0, 0, 0, 0];
for (let t = 0; t < w.grid.n; t++) if (w.ownerF[t] >= 0) terr[w.ownerF[t]]++;
console.log('territory by faction', terr.join(' / '));
for (const c of w.cmds) {
  const n = w.squads.filter((s) => s.owner === c.id).length;
  console.log(`  ${c.name.padEnd(10)} f${c.faction} ${c.status.padEnd(7)} squads ${String(n).padStart(2)} kills ${String(c.stats.kills).padStart(3)} losses ${String(c.stats.losses).padStart(3)} caps ${String(c.stats.captures).padStart(2)} plans ${String(c.stats.plans).padStart(3)} upd ${String(c.updates).padStart(3)} err ${c.errEma.toFixed(3)} merit ${w.ledger.balance(c.meritAcct)} ${c.policyMajor}.${c.policyMinor} plan=${c.plan ? c.plan.name : '-'} res=${c.res.alloy}/${c.res.energy}/${c.res.supply}`);
}
const kills = w.cmds.reduce((a, c) => a + c.stats.kills, 0);
const caps = w.cmds.reduce((a, c) => a + c.stats.captures, 0);
check('combat occurs', kills > 5, `${kills} kills`);
check('sites change hands', caps > 3, `${caps} captures`);
check('agents learn online', w.cmds.some((c) => c.updates > 3), `max updates ${Math.max(...w.cmds.map((c) => c.updates))}`);
check('population bounded', w.cmds.filter((c) => c.status === 'active').length <= POP.ACTIVE_CAP && w.squads.length <= POP.ACTIVE_CAP * POP.SQUADS_PER_CMD);
check('memory bounded', w.cmds.every((c) => c.memory.length <= 24));
check('ledger balanced', w.ledger.balanced());
const ops = w.ops.map((o) => `${o.code}:${o.status}${o.result ? '(' + o.result + ')' : ''}`).join(' ');
console.log('operations', ops);
console.log('markets', w.markets.map((m) => `${m.id}:${m.status}:${m.bets.length}bets${m.note ? ' [' + m.note + ']' : ''}`).join('\n  '));
check('operations progressed', w.ops.length > 0);
if (TICKS > CLOCK.OP_OPEN_LEAD + CLOCK.OP_RUN + 100) check('an operation settled', w.ops.some((o) => o.status === 'Settled' || o.status === 'Voided'));

// 3. user bet path: cap, duplicate idempotency, one outcome
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

// 4. apportionment conserves totals
const parts = apportion(1000, [1, 1, 1], [3, 1, 2]);
check('largest-remainder apportionment conserves pool', parts.reduce((a, b) => a + b, 0) === 1000, parts.join(','));

// 5. fog: observation must not include invisible enemies — check ghost sources are visible-at-time
const f0 = w.factions[0];
const leak = w.squads.filter((s) => s.faction !== 0 && f0.visible[s.tile] === 0 && f0.ghosts.some((g) => g.id === s.id && g.tick === w.tick)).length;
check('no live updates of hidden enemies in faction memory', leak === 0);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
