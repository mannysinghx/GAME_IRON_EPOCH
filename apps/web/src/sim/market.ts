// Virtual prediction desk (design doc §8). Signal credits are nonredeemable integers. Pari-mutuel pools
// with no house cut; integer payouts by largest fractional remainder; one outcome per account per market;
// stake cap fixed at first entry; refunds for one-sided, unbacked-winner, tie, and void outcomes.
// Agents never observe any of this: no market state flows into observations (§6.5).

import { CLOCK, FACTIONS, RULES_VERSION, SIGNAL } from '../shared/config.ts';
import { hashStr, sha256Hex } from '../shared/rng.ts';
import type { World } from './world.ts';
import type { Market, Npc, Operation } from './types.ts';

const NPC_NAMES = ['orbit', 'kilo', 'mesa', 'quill', 'rook', 'tundra', 'vesta', 'wren', 'yarrow', 'zinc', 'arden', 'bram', 'cobalt', 'delta', 'ember', 'fable', 'gale', 'heron', 'iris', 'juno', 'kite', 'lumen', 'moss', 'nova', 'onyx', 'pike', 'quartz', 'reed', 'sable', 'tarn', 'umber', 'vale', 'wisp', 'xeno', 'yew', 'zephyr'];
const STYLES: Npc['style'][] = ['power', 'skill', 'form', 'contrarian', 'random', 'loyal'];

export function initMarkets(w: World): void {
  const iss = w.ledger.find('issuance', 'SIG', 'issuance');
  w.ledger.find('sink', 'SIG', 'sink');
  w.ledger.find('issuance', 'MERIT', 'issuance');
  w.ledger.find('sink', 'MERIT', 'sink');
  const acct = w.ledger.open('user:you', 'SIG', 'available');
  w.wallet.acct = acct;
  w.ledger.post('grant', 'account-created', 'grant-initial-you', [[iss, -SIGNAL.initialGrant], [acct, SIGNAL.initialGrant]], w.tick);
  w.wallet.grantLastCampaign = 0;
  w.wallet.receipts.unshift({ id: 'r-grant-0', tick: w.tick, marketId: '', kind: 'grant', amount: SIGNAL.initialGrant, text: `One-time grant of ${SIGNAL.initialGrant} Signal credits`, opId: -1 });
  for (let i = 0; i < SIGNAL.npcCount; i++) {
    const a = w.ledger.open(`npc:${NPC_NAMES[i]}`, 'SIG', 'available');
    w.ledger.post('grant', 'account-created', `grant-initial-npc-${i}`, [[iss, -SIGNAL.initialGrant], [a, SIGNAL.initialGrant]], w.tick);
    w.npcs.push({ id: i, name: NPC_NAMES[i], style: STYLES[i % STYLES.length], acct: a, favFaction: i % 4, nextAct: 0 });
  }
}

function makeMarkets(w: World, op: Operation): void {
  const roster = op.roster.map((id) => w.cmdById.get(id)!).filter(Boolean);
  const specBase = {
    rules: RULES_VERSION, op: op.code, region: op.center, radius: op.radius, start: op.startTick, cutoff: op.lockTick, end: op.endTick,
    roster: roster.map((c) => ({ id: c.key, policy: c.policyHash })), seedCommit: op.commit,
  };
  // 1. highest objective score
  const m1: Market = {
    id: `m-${op.code.toLowerCase()}-top`, opId: op.id, kind: 'TOP_SCORE',
    question: `Which commander has the highest objective score in ${op.code} at ${op.name}?`, status: 'Open',
    outcomes: [...roster.map((c) => ({ id: c.key, label: c.name, faction: c.faction })), { id: 'none', label: 'No score / tie', faction: -1 }],
    bets: [], caps: {}, positions: {}, escrowAcct: w.ledger.open(`escrow:${op.code}:top`, 'SIG', 'escrow'),
    cutoffTick: op.lockTick, endTick: op.endTick, specHash: '', result: null, note: null, subjectFaction: -1, subjectTile: op.center, lockedTotals: null,
  };
  m1.specHash = sha256Hex(JSON.stringify({ ...specBase, market: m1.id, outcomes: m1.outcomes.map((o) => o.id), formula: 'sum of objective points held per 1 s; tie → objectives held at final tick → score per resource spent → refund' }));
  // 2. control of the centre objective at the final tick
  const holderF = w.ownerF[op.center];
  const subject = holderF >= 0 && roster.some((c) => c.faction === holderF) ? holderF : roster[0].faction;
  const m2: Market = {
    id: `m-${op.code.toLowerCase()}-ctl`, opId: op.id, kind: 'CONTROL',
    question: `Will ${FACTIONS[subject].name} control ${op.name} at ${op.code}'s final tick?`, status: 'Open',
    outcomes: [{ id: 'yes', label: 'Yes', faction: subject }, { id: 'no', label: 'No', faction: -1 }],
    bets: [], caps: {}, positions: {}, escrowAcct: w.ledger.open(`escrow:${op.code}:ctl`, 'SIG', 'escrow'),
    cutoffTick: op.lockTick, endTick: op.endTick, specHash: '', result: null, note: null, subjectFaction: subject, subjectTile: op.center, lockedTotals: null,
  };
  m2.specHash = sha256Hex(JSON.stringify({ ...specBase, market: m2.id, outcomes: ['yes', 'no'], formula: `tile owner faction at end tick == ${FACTIONS[subject].key}` }));
  w.markets.push(m1, m2);
  // NPC schedules within the open window
  for (const n of w.npcs) n.nextAct = op.openTick + 10 + w.marketRng.int(Math.max(20, op.lockTick - op.openTick - 20));
}

export function tickMarkets(w: World): void {
  for (const op of w.ops) {
    if (op.status === 'Open' && !w.markets.some((m) => m.opId === op.id)) makeMarkets(w, op);
  }
  for (const m of w.markets) {
    const op = w.ops.find((o) => o.id === m.opId);
    if (!op) continue;
    if (m.status === 'Open' && (op.status !== 'Open' || w.tick >= m.cutoffTick)) {
      m.status = op.status === 'Voided' ? 'Voided' : 'Locked';
      m.lockedTotals = totals(m);
    }
    if (m.status === 'Locked' && op.status === 'Running') m.status = 'Running';
    if ((m.status === 'Running' || m.status === 'Locked') && op.status === 'Provisional') { m.status = 'Provisional'; m.result = outcomeOf(w, m, op); }
    if (m.status === 'Provisional' && op.status === 'Settled') settle(w, m, op);
    if (m.status !== 'Settled' && m.status !== 'Voided' && op.status === 'Voided') voidMarket(w, m, op.result ?? 'operation voided');
  }
  // NPC spectators act inside the open window, from public information only
  for (const n of w.npcs) {
    if (w.tick !== n.nextAct) continue;
    for (const m of w.markets) {
      if (m.status !== 'Open' || m.positions[n.acct] !== undefined) continue;
      if (!w.marketRng.pct(62)) continue;
      const outcome = npcChoice(w, n, m);
      const avail = w.ledger.balance(n.acct);
      const cap = Math.min(SIGNAL.stakeCapAbs, Math.floor((avail * SIGNAL.stakeCapPct) / 100));
      if (cap < 1) continue;
      const stake = 1 + w.marketRng.int(cap);
      placeBet(w, n.acct, m.id, outcome, stake, `npc-${n.id}-${m.id}`);
    }
  }
  // drop old settled markets
  const done = w.markets.filter((m) => m.status === 'Settled' || m.status === 'Voided');
  if (done.length > 16) {
    const drop = new Set(done.slice(0, done.length - 16).map((m) => m.id));
    w.markets = w.markets.filter((m) => !drop.has(m.id));
  }
  // periodic grant bookkeeping: net history sample
  if (w.tick % CLOCK.SAMPLE === 0) {
    w.wallet.netHist.push(w.ledger.balance(w.wallet.acct) + escrowOf(w, w.wallet.acct));
    if (w.wallet.netHist.length > 120) w.wallet.netHist.shift();
  }
}

function npcChoice(w: World, n: Npc, m: Market): string {
  const rng = w.marketRng;
  if (m.kind === 'CONTROL') {
    const holds = w.ownerF[m.subjectTile] === m.subjectFaction;
    switch (n.style) {
      case 'contrarian': { const t = totals(m); return (t.yes ?? 0) > (t.no ?? 0) ? 'no' : 'yes'; }
      case 'random': return rng.pct(50) ? 'yes' : 'no';
      case 'loyal': return n.favFaction === m.subjectFaction ? 'yes' : 'no';
      default: return holds === rng.pct(75) ? 'yes' : 'no';
    }
  }
  const cands = m.outcomes.filter((o) => o.id !== 'none').map((o) => ({ o, c: w.cmds.find((c) => c.key === o.id)! }));
  const by = (f: (x: (typeof cands)[0]) => number) => cands.slice().sort((a, b) => f(b) - f(a) || a.c.id - b.c.id)[0].o.id;
  switch (n.style) {
    case 'power': return by((x) => x.c.power);
    case 'skill': return by((x) => x.c.elo);
    case 'form': return by((x) => (x.c.stats.opsWon + 1) / (x.c.stats.opsPlayed + 2));
    case 'contrarian': { const t = totals(m); return cands.slice().sort((a, b) => (t[a.o.id] ?? 0) - (t[b.o.id] ?? 0) || a.c.id - b.c.id)[0].o.id; }
    case 'loyal': return cands.find((x) => x.c.faction === n.favFaction)?.o.id ?? rng.pick(cands).o.id;
    default: return rng.pct(8) ? 'none' : rng.pick(cands).o.id;
  }
}

export function totals(m: Market): Record<string, number> {
  const t: Record<string, number> = {};
  for (const o of m.outcomes) t[o.id] = 0;
  for (const b of m.bets) t[b.outcome] = (t[b.outcome] ?? 0) + b.stake;
  return t;
}

function escrowOf(w: World, acct: number): number {
  let s = 0;
  for (const m of w.markets) if (m.status !== 'Settled' && m.status !== 'Voided') for (const b of m.bets) if (b.account === acct) s += b.stake;
  return s;
}

export function userEscrow(w: World): number { return escrowOf(w, w.wallet.acct); }

/** Atomic stake acceptance: status & cutoff, idempotency, one outcome, cap at first entry, balance. */
export function placeBet(w: World, acct: number, marketId: string, outcome: string, stake: number, idem: string): { ok: boolean; msg: string } {
  const m = w.markets.find((x) => x.id === marketId);
  if (!m) return { ok: false, msg: 'Unknown market.' };
  if (m.status !== 'Open' || w.tick >= m.cutoffTick) return { ok: false, msg: `Market is ${m.status.toLowerCase()}; only Open markets accept stakes.` };
  if (!m.outcomes.some((o) => o.id === outcome)) return { ok: false, msg: 'Unknown outcome.' };
  if (!Number.isInteger(stake) || stake < 1) return { ok: false, msg: 'Minimum stake is 1 credit.' };
  if (w.ledger.seen(idem)) return { ok: false, msg: 'Duplicate request ignored (idempotency key).' };
  const prior = m.positions[acct];
  if (prior !== undefined && prior !== outcome) return { ok: false, msg: 'One outcome per account per market; you can only add to your existing position.' };
  const avail = w.ledger.balance(acct);
  if (m.caps[acct] === undefined) m.caps[acct] = Math.max(1, Math.min(SIGNAL.stakeCapAbs, Math.floor((avail * SIGNAL.stakeCapPct) / 100)));
  const already = m.bets.filter((b) => b.account === acct).reduce((s, b) => s + b.stake, 0);
  if (already + stake > m.caps[acct]) return { ok: false, msg: `Stake cap for this market is ${m.caps[acct]} (fixed at first entry); ${m.caps[acct] - already} remaining.` };
  if (avail < stake) return { ok: false, msg: 'Insufficient available credits.' };
  const r = w.ledger.post('stake', m.id, idem, [[acct, -stake], [m.escrowAcct, stake]], w.tick);
  if (!r.ok) return { ok: false, msg: r.err };
  const id = `b-${r.tx.id}`;
  m.bets.push({ id, account: acct, outcome, stake, tick: w.tick });
  m.positions[acct] = outcome;
  if (acct === w.wallet.acct) {
    w.wallet.bets++;
    const label = m.outcomes.find((o) => o.id === outcome)?.label ?? outcome;
    const op = w.ops.find((o) => o.id === m.opId);
    w.wallet.receipts.unshift({ id: `r-${r.tx.id}`, tick: w.tick, marketId: m.id, kind: 'stake', amount: -stake, text: `Staked ${stake} on ${label} · ${op?.code ?? ''} (tx ${r.tx.id})`, opId: m.opId });
    trimReceipts(w);
  }
  return { ok: true, msg: `Accepted at tick ${w.tick}: ${stake} credits escrowed (tx ${r.tx.id}).` };
}

function trimReceipts(w: World): void { if (w.wallet.receipts.length > 40) w.wallet.receipts.length = 40; }

function outcomeOf(w: World, m: Market, op: Operation): string {
  if (m.kind === 'CONTROL') return w.ownerF[m.subjectTile] === m.subjectFaction ? 'yes' : 'no';
  if (op.winner < 0) return 'none';
  return w.cmdById.get(op.winner)?.key ?? 'none';
}

function refundAll(w: World, m: Market, reason: string, status: 'Settled' | 'Voided'): void {
  const byAcct = new Map<number, number>();
  for (const b of m.bets) byAcct.set(b.account, (byAcct.get(b.account) ?? 0) + b.stake);
  const postings: [number, number][] = [];
  let total = 0;
  for (const [a, s] of [...byAcct.entries()].sort((x, y) => x[0] - y[0])) { postings.push([a, s]); total += s; }
  if (total > 0) {
    postings.push([m.escrowAcct, -total]);
    w.ledger.post('refund', m.id, `refund-${m.id}`, postings, w.tick);
  }
  m.status = status;
  m.note = reason;
  const mine = byAcct.get(w.wallet.acct);
  if (mine) {
    w.wallet.refunds++;
    w.wallet.receipts.unshift({ id: `r-refund-${m.id}`, tick: w.tick, marketId: m.id, kind: 'refund', amount: mine, text: `Refund ${mine} · ${reason}`, opId: m.opId });
    trimReceipts(w);
  }
}

function voidMarket(w: World, m: Market, reason: string): void {
  refundAll(w, m, `void: ${reason}`, 'Voided');
  w.log('market', `${m.id} voided and refunded: ${reason}.`, -1, [], -1);
}

function settle(w: World, m: Market, op: Operation): void {
  const result = m.result ?? outcomeOf(w, m, op);
  m.result = result;
  const t = totals(m);
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  if (total === 0) { m.status = 'Settled'; m.note = 'no accepted stakes; no ledger movement'; return; }
  const backed = Object.values(t).filter((v) => v > 0).length;
  if (backed <= 1) { refundAll(w, m, 'only one outcome was backed', 'Settled'); return; }
  if (m.kind === 'TOP_SCORE' && op.result === 'TIE') { refundAll(w, m, 'tied highest score after published tie-breaks', 'Settled'); return; }
  const winTotal = t[result] ?? 0;
  if (winTotal === 0) { refundAll(w, m, 'winning outcome had no backing', 'Settled'); return; }
  // pari-mutuel: base_i = floor(total × stake_i / winTotal); remainders by largest fraction, stable hash ties
  const winners = new Map<number, number>();
  for (const b of m.bets) if (b.outcome === result) winners.set(b.account, (winners.get(b.account) ?? 0) + b.stake);
  const rows = [...winners.entries()].map(([acct, stake]) => {
    const num = total * stake;
    const base = Math.floor(num / winTotal);
    return { acct, stake, base, rem: num - base * winTotal, h: hashStr(`${m.id}:${acct}`) };
  });
  let given = rows.reduce((a, r) => a + r.base, 0);
  rows.sort((a, b) => b.rem - a.rem || a.h - b.h);
  for (let k = 0; given < total; k = (k + 1) % rows.length, given++) rows[k].base++;
  const postings: [number, number][] = rows.sort((a, b) => a.acct - b.acct).map((r) => [r.acct, r.base]);
  postings.push([m.escrowAcct, -total]);
  const res = w.ledger.post('payout', m.id, `settle-${m.id}`, postings, w.tick);
  if (!res.ok) { refundAll(w, m, `settlement integrity failure: ${res.err}`, 'Voided'); return; }
  m.status = 'Settled';
  const label = m.outcomes.find((o) => o.id === result)?.label ?? result;
  m.note = `pool ${total} → ${winners.size} winning accounts`;
  const mineStake = m.bets.filter((b) => b.account === w.wallet.acct).reduce((s, b) => s + b.stake, 0);
  if (mineStake > 0) {
    const pay = rows.find((r) => r.acct === w.wallet.acct)?.base ?? 0;
    const net = pay - mineStake;
    w.wallet.net += net;
    if (pay > 0) w.wallet.wins++; else w.wallet.losses++;
    w.wallet.receipts.unshift({
      id: `r-settle-${m.id}`, tick: w.tick, marketId: m.id, kind: pay > 0 ? 'payout' : 'loss', amount: pay,
      text: pay > 0 ? `Won ${pay} (stake ${mineStake}, net ${net >= 0 ? '+' : ''}${net}) · ${label} · ${op.code}` : `Lost ${mineStake} · result ${label} · ${op.code}`, opId: op.id,
    });
    trimReceipts(w);
  }
  w.log('market', `${m.id} settled to "${label}": pool ${total}, ${winners.size} winning accounts, tx ${res.tx.id}.`, -1, [], -1);
}

export function claimGrant(w: World, idem: string): { ok: boolean; msg: string } {
  const ci = Math.floor(w.tick / CLOCK.CAMPAIGN);
  if (w.wallet.grantLastCampaign >= ci) return { ok: false, msg: 'Grant already claimed this campaign. Unclaimed periods do not accumulate.' };
  const iss = w.ledger.find('issuance', 'SIG', 'issuance');
  const r = w.ledger.post('grant', `campaign-${ci}`, idem || `grant-${ci}`, [[iss, -SIGNAL.periodicGrant], [w.wallet.acct, SIGNAL.periodicGrant]], w.tick);
  if (!r.ok) return { ok: false, msg: r.err };
  w.wallet.grantLastCampaign = ci;
  w.wallet.receipts.unshift({ id: `r-grant-${ci}`, tick: w.tick, marketId: '', kind: 'grant', amount: SIGNAL.periodicGrant, text: `Campaign grant +${SIGNAL.periodicGrant} (explicit mint, tx ${r.tx.id})`, opId: -1 });
  trimReceipts(w);
  return { ok: true, msg: `+${SIGNAL.periodicGrant} Signal credits granted.` };
}
