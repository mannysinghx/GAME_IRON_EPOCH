// Spectator story layer: public plan announcements, ranked "moments" and head-to-head rivalries, derived from
// committed world events. Presentation only. It reads simulation state and writes nothing but its own bounded
// records: no RNG, no effect on combat, economy, markets or the state hash (the selftest runs a world with and
// without it). Agents never read it (§9.2). Every text states accepted plan ids, observed facts and results
// (§15.4); none invents an intention, a casualty or a motive.

import { CLOCK, PK, PLAN_COUNT, PLAN_NAMES, S, STRUCTS, UNITS } from '../shared/config.ts';
import type { BeatStatus, MomentView, PlanBeatView, RivalryView, StoryView } from '../shared/protocol.ts';
import type { World } from './world.ts';
import type { Candidate, Commander, Operation, Plan, Struct, Treaty } from './types.ts';

export const STORY = {
  BEATS: 48, MOMENTS: 60, RIVALS: 240,
  CLASH_GAP: 150, // a new clash between a pair starts after 30 s without contact
  RIVAL_MIN: 40, // pair score that names a rivalry (both sides at least a quarter of it, three clashes)
  LAST_STAND: 0.35, LAST_STAND_GAP: 900,
  FOCUS_WINDOW: 600, // moments the Director may still cut to (2 sim min), half-weight every 60 s
  PACT_WINDOW: 3000, // a kill this soon after a pact ended by notice is that pact's first blood
  HEADLINE: 60, // moments at or above this weight flash on the map
  COMEBACK_GAP: 0.1, // "last" means at least 10% behind the leader in world power
} as const;

export interface PlanBeat {
  id: string; tick: number; cmd: number; f: number; kind: number; target: string; tile: number;
  alt: { kind: number; target: string; score: number } | null; score: number; reason: string; explored: boolean;
  status: BeatStatus; reward: number | null; closed: number;
}

export interface Moment { id: number; tick: number; kind: string; weight: number; text: string; f: number; a: number[]; tile: number }

/** Pair record, a < b. Each tuple is [by a, by b]. */
export interface Rivalry {
  a: number; b: number;
  k: [number, number]; // squads destroyed
  c: [number, number]; // sites captured from the other
  x: [number, number]; // command cores felled
  o: [number, number]; // operations finished ahead of the other
  clashes: number; since: number; last: number; heat: number; named: number; mile: number;
}

export interface CmdRecord { closed: number; won: number; streak: number; best: number }

export interface StoryState {
  beats: PlanBeat[]; announced: number;
  moments: Moment[]; nextMoment: number; counts: Record<string, number>;
  rivals: Rivalry[]; evicted: number;
  records: Record<number, CmdRecord>;
  kindN: number[]; kindWon: number[];
  sites: Record<number, { hist: number[]; n: number; campaign: number }>; // capture history per site struct
  felledBy: Record<number, { by: number; tick: number }>; // commander → who felled its core last
  coreHp: Record<number, number>; lastStand: Record<number, number>;
  assaults: Record<string, number>; // `${cmd}:${core}` → tick announced (dedupe)
  leader: number; lastRank: number[]; // faction power leader; faction clearly last in power at recent samples (-1: none)
  op: { id: number; lead: number; lastChange: number; lastMoment: number };
  pacts: number[]; firstBlood: boolean;
}

function fresh(): StoryState {
  return {
    beats: [], announced: 0, moments: [], nextMoment: 1, counts: {}, rivals: [], evicted: 0, records: {},
    kindN: new Array(PLAN_COUNT).fill(0), kindWon: new Array(PLAN_COUNT).fill(0), sites: {}, felledBy: {}, coreHp: {}, lastStand: {},
    assaults: {}, leader: -1, lastRank: [], op: { id: -1, lead: -1, lastChange: -1, lastMoment: -1 }, pacts: [], firstBlood: false,
  };
}

const STREAKS = [5, 8, 12, 16, 20];
const SLUMPS = [4, 7, 10];
const MILESTONES = [10, 25, 50, 100, 200]; // clash counts of a named rivalry worth a line
/** Plan names often repeat their kind ("support Mirage: …", "recon near …"); say each once. */
const SELF_NAMED = new Set<number>([PK.SECURE_SUPPLY, PK.RECON, PK.SUPPORT, PK.REGROUP]);
export function planLabel(kind: number, name: string): string { return SELF_NAMED.has(kind) ? name : `${PLAN_NAMES[kind].replace('_', ' ').toLowerCase()} ${name}`; }

/** "at X" / "near X" for the nearest named site or crossing, never a command core's own name. */
function place(w: World, tile: number): string {
  let best = '', bd = 1e9;
  for (const s of w.structs) {
    if (!s.name || (s.kind !== S.BRIDGE && !STRUCTS[s.kind].capturable)) continue;
    const d = w.grid.dist(s.tile, tile);
    if (d < bd) { bd = d; best = s.name; }
  }
  return best ? `${bd === 0 ? 'at' : 'near'} ${best}` : `at hex ${w.grid.col(tile)},${w.grid.row(tile)}`;
}
const pairKey = (a: number, b: number) => (a < b ? a * 4096 + b : b * 4096 + a);
const side = (r: Rivalry, id: number) => (id === r.a ? 0 : 1);
export const rivalScore = (r: Rivalry, i: number) => r.k[i] + 4 * r.c[i] + 15 * r.x[i] + 6 * r.o[i];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const clock = (t: number) => { const s = Math.floor(t / 5); return `T+${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

export class Story {
  st: StoryState = fresh();
  private byPair = new Map<number, Rivalry>();

  save(): StoryState { return this.st; }

  load(saved: unknown): void {
    const d = saved as Partial<StoryState> | undefined;
    this.st = d && Array.isArray(d.beats) ? { ...fresh(), ...d } : fresh(); // snapshots from before the story layer start empty
    this.byPair.clear();
    for (const r of this.st.rivals) this.byPair.set(pairKey(r.a, r.b), r);
  }

  // ------------------------------------------------------------------ moments
  private moment(w: World, kind: string, weight: number, text: string, f: number, a: number[], tile: number): void {
    const st = this.st;
    st.moments.push({ id: st.nextMoment++, tick: w.tick, kind, weight, text, f, a: a.filter((x) => x >= 0), tile });
    if (st.moments.length > STORY.MOMENTS) st.moments.shift();
    st.counts[kind] = (st.counts[kind] ?? 0) + 1;
    w.log('story', text, f, a.filter((x) => x >= 0), tile);
  }

  // ------------------------------------------------------------------ plans
  /** A strategic review committed a plan: announce it with the runner-up it was chosen over. */
  onDecision(w: World, c: Commander, cands: Candidate[], order: number[], chosen: number): void {
    const p = c.plan;
    if (!p) return;
    const st = this.st;
    // the alternative is the best-scoring other candidate (for an exploratory pick, the top-ranked plan it skipped)
    const altIdx = order.find((i) => i !== chosen);
    const alt = altIdx !== undefined ? cands[altIdx] : undefined;
    st.beats.push({
      id: p.decisionId, tick: w.tick, cmd: c.id, f: c.faction, kind: p.kind, target: p.name, tile: p.tile,
      alt: alt ? { kind: alt.kind, target: alt.name, score: round3(alt.score) } : null, score: round3(p.score), reason: p.reason, explored: p.explored,
      status: 'active', reward: null, closed: -1,
    });
    if (st.beats.length > STORY.BEATS) st.beats.shift();
    st.announced++;
    if (p.kind === PK.ASSAULT_CORE) {
      const core = w.structById.get(p.struct);
      const key = `${c.id}:${p.struct}`;
      if (core && w.tick - (st.assaults[key] ?? -1e9) > 600) {
        st.assaults[key] = w.tick;
        const owner = w.cmdById.get(core.owner);
        this.moment(w, 'CORE_ASSAULT', 55, `${c.name} orders an assault on ${owner ? `${owner.name}'s` : 'an enemy'} command core${p.explored ? ' (exploratory pick)' : ''}.`, c.faction, [c.id, core.owner], core.tile);
      }
    }
  }

  /** The previous plan closed at a review: record the verdict next to the learner's own reward. */
  onPlanClosed(w: World, c: Commander, p: Plan, achieved: boolean, reward: number): void {
    const st = this.st;
    const status: BeatStatus = achieved ? (reward > 0 ? 'success' : 'costly') : 'fail';
    const b = st.beats.find((x) => x.id === p.decisionId);
    if (b) { b.status = status; b.reward = round3(reward); b.closed = w.tick; }
    st.kindN[p.kind]++;
    if (status === 'success') st.kindWon[p.kind]++;
    const r = st.records[c.id] ?? (st.records[c.id] = { closed: 0, won: 0, streak: 0, best: 0 });
    r.closed++;
    const prev = r.streak;
    if (status === 'success') { r.won++; r.streak = prev > 0 ? prev + 1 : 1; r.best = Math.max(r.best, r.streak); }
    else if (status === 'fail') r.streak = prev < 0 ? prev - 1 : -1;
    else r.streak = 0;
    // about half of all plans succeed, so short runs are noise: only longer streaks and slumps are moments
    const latest = planLabel(p.kind, p.name);
    if (STREAKS.includes(r.streak)) this.moment(w, 'STREAK', Math.min(66, 44 + 2 * r.streak), `${c.name} lands ${r.streak} successful plans in a row (latest: ${latest}).`, c.faction, [c.id], p.tile);
    else if (SLUMPS.includes(-r.streak)) this.moment(w, 'SLUMP', Math.min(50, 34 + 2 * -r.streak), `${c.name}'s plans keep failing: ${-r.streak} in a row (latest: ${latest}).`, c.faction, [c.id], p.tile);
  }

  // ------------------------------------------------------------------ rivalries
  private rival(w: World, a: number, b: number): Rivalry {
    const key = pairKey(a, b);
    let r = this.byPair.get(key);
    if (!r) {
      // make room first: the new pair has no score yet and would otherwise be its own eviction victim
      if (this.st.rivals.length >= STORY.RIVALS) this.evict();
      r = { a: Math.min(a, b), b: Math.max(a, b), k: [0, 0], c: [0, 0], x: [0, 0], o: [0, 0], clashes: 0, since: w.tick, last: -1e9, heat: 0, named: -1, mile: 0 };
      this.st.rivals.push(r);
      this.byPair.set(key, r);
    }
    return r;
  }

  /** Bounded: drop the weakest unnamed pair (score plus decaying heat; named rivalries only when nothing else is left). */
  private evict(): void {
    const list = this.st.rivals;
    let worst = -1, ws = Infinity;
    for (let pass = 0; pass < 2 && worst < 0; pass++) {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (pass === 0 && r.named >= 0) continue;
        const s = rivalScore(r, 0) + rivalScore(r, 1) + r.heat;
        if (s < ws) { ws = s; worst = i; }
      }
    }
    if (worst < 0) return;
    const [r] = list.splice(worst, 1);
    this.byPair.delete(pairKey(r.a, r.b));
    this.st.evicted++;
  }

  /** One head-to-head event; `heat` is the event's weight. Names the rivalry when it becomes mutual. */
  private clash(w: World, by: Commander, vs: Commander, field: 'k' | 'c' | 'x' | 'o', heat: number, tile: number): void {
    if (by.id === vs.id || by.faction === vs.faction) return;
    const r = this.rival(w, by.id, vs.id);
    r[field][side(r, by.id)]++;
    if (w.tick - r.last > STORY.CLASH_GAP) r.clashes++;
    r.last = w.tick;
    r.heat += heat;
    const sa = rivalScore(r, 0), sb = rivalScore(r, 1), tot = sa + sb;
    const A = w.cmdName(r.a), B = w.cmdName(r.b);
    const lead = sa === sb ? 'level' : `${sa > sb ? A : B} leads ${Math.max(sa, sb)}–${Math.min(sa, sb)}`;
    if (r.named < 0) {
      if (tot >= STORY.RIVAL_MIN && Math.min(sa, sb) >= tot * 0.25 && r.clashes >= 3) {
        r.named = w.tick;
        this.moment(w, 'RIVALRY', 52, `A rivalry: ${A} vs ${B}, ${r.clashes} clashes so far, ${lead}.`, by.faction, [r.a, r.b], tile);
      }
    } else if (MILESTONES.includes(r.clashes) && r.mile < r.clashes) {
      r.mile = r.clashes; // once per milestone
      this.moment(w, 'RIVALRY', 44, `${A} vs ${B}: ${ordinal(r.clashes)} clash, ${lead}.`, by.faction, [r.a, r.b], tile);
    }
  }

  // ------------------------------------------------------------------ combat and territory
  onKill(w: World, killer: Commander, victim: Commander, cls: number, tile: number): void {
    const st = this.st;
    if (!st.firstBlood && killer.faction !== victim.faction) {
      st.firstBlood = true;
      this.moment(w, 'FIRST_BLOOD', 45, `First blood: ${killer.name} destroys ${victim.name}'s ${UNITS[cls].name.toLowerCase()} ${place(w, tile)}.`, killer.faction, [killer.id, victim.id], tile);
    }
    const t = this.endedPact(w, killer.faction, victim.faction);
    if (t) {
      st.pacts.push(t.id);
      this.moment(w, 'PACT_BROKEN', 74, `First blood since the ${w.factionName(t.a)}–${w.factionName(t.b)} pact ended: ${killer.name} destroys ${victim.name}'s ${UNITS[cls].name.toLowerCase()} ${place(w, tile)}.`, killer.faction, [killer.id, victim.id], tile);
    }
    this.clash(w, killer, victim, 'k', cls === 2 ? 3 : 1, tile);
  }

  /** A pact between the two factions that ended by notice within the window and has no first blood yet. */
  private endedPact(w: World, fa: number, fb: number): Treaty | undefined {
    for (const t of w.treaties) {
      if (t.status !== 'ended' || t.noticeAt < 0 || this.st.pacts.includes(t.id)) continue;
      if (!((t.a === fa && t.b === fb) || (t.a === fb && t.b === fa))) continue;
      if (w.tick - t.endsAt <= STORY.PACT_WINDOW) return t;
    }
    return undefined;
  }

  onSiteCaptured(w: World, by: Commander, st: Struct, prevOwner: number, prevF: number): void {
    const s = this.st;
    const ci = Math.floor(w.tick / CLOCK.CAMPAIGN);
    const rec = s.sites[st.id] ?? (s.sites[st.id] = { hist: [], n: 0, campaign: ci });
    if (rec.campaign !== ci) { rec.campaign = ci; rec.n = 0; }
    const retake = rec.hist.length >= 2 && rec.hist[rec.hist.length - 1] === prevOwner && rec.hist[rec.hist.length - 2] === by.id;
    rec.hist.push(by.id);
    if (rec.hist.length > 4) rec.hist.shift();
    const prev = w.cmdById.get(prevOwner);
    // neutral captures are plan payoffs (announced as plan results), not head-to-head moments
    if (prevF < 0 || prevF === by.faction || !prev) return;
    rec.n++;
    this.clash(w, by, prev, 'c', 4, st.tile);
    const big = st.kind === S.HUB || st.kind === S.CITADEL;
    if (rec.n < 2 && !retake && !big) return;
    const times = rec.n >= 2 ? `; it has changed hands ${rec.n === 2 ? 'twice' : `${rec.n} times`} this campaign` : '';
    const kind = rec.n >= 3 ? 'TUG_OF_WAR' : retake ? 'RETAKE' : 'CAPTURE';
    // a site trading hands again and again climbs toward a headline; a single exchange stays a chronicle line
    const weight = Math.min(66, (kind === 'TUG_OF_WAR' ? 46 + 4 * (rec.n - 3) : retake ? 44 : 38) + (big ? 6 : 0));
    this.moment(w, kind, weight, `${by.name} ${retake ? 'retakes' : 'takes'} ${st.name} from ${prev.name}${times}.`, by.faction, [by.id, prev.id], st.tile);
  }

  onCoreFell(w: World, victim: Commander, killer: Commander | undefined, tile: number): void {
    const s = this.st;
    // the fallen commander's announced plan ends without a verdict
    for (const b of s.beats) if (b.cmd === victim.id && b.status === 'active') { b.status = 'aborted'; b.closed = w.tick; }
    if (!killer) { this.moment(w, 'CORE_DOWN', 88, `${victim.name}'s command core falls ${place(w, tile)}.`, victim.faction, [victim.id], tile); return; }
    let revenge = '';
    const own = s.felledBy[killer.id];
    if (own && own.by === victim.id) revenge = ` Revenge: ${victim.name} had felled ${killer.name}'s core at ${clock(own.tick)}.`;
    else for (const pid of killer.parents) {
      const p = s.felledBy[pid];
      if (p && p.by === victim.id) { revenge = ` Revenge: ${victim.name} had felled the core of ${w.cmdName(pid)}, ${killer.name}'s parent.`; break; }
    }
    s.felledBy[victim.id] = { by: killer.id, tick: w.tick };
    this.clash(w, killer, victim, 'x', 15, tile);
    this.moment(w, revenge ? 'REVENGE' : 'CORE_DOWN', revenge ? 98 : 92, `${killer.name} fells ${victim.name}'s command core ${place(w, tile)}.${revenge}`, killer.faction, [killer.id, victim.id], tile);
  }

  onCitadel(w: World, c: Commander, tile: number): void {
    this.moment(w, 'CITADEL', 70, `${c.name} takes Citadel Prime first: ${w.factionName(c.faction)} gains a specialist recruitment slot.`, c.faction, [c.id], tile);
  }

  // ------------------------------------------------------------------ operations
  onOpScored(w: World, op: Operation): void {
    const o = this.st.op;
    if (o.id !== op.id) { o.id = op.id; o.lead = -1; o.lastChange = -1; o.lastMoment = -1; }
    const ranked = op.roster.map((id) => ({ id, s: op.scores[id] ?? 0 })).sort((a, b) => b.s - a.s);
    if (!ranked.length || ranked[0].s === 0 || (ranked[1] && ranked[1].s === ranked[0].s)) return; // no sole leader
    const lead = ranked[0].id;
    if (lead === o.lead) return;
    const prev = o.lead;
    o.lead = lead;
    o.lastChange = w.tick;
    if (prev < 0 || w.tick - op.startTick < 300 || w.tick - o.lastMoment < 150) return;
    o.lastMoment = w.tick;
    const c = w.cmdById.get(lead);
    this.moment(w, 'LEAD_CHANGE', 46, `${w.cmdName(lead)} takes the lead in ${op.code} at ${op.name} from ${w.cmdName(prev)}, ${ranked[0].s}–${op.scores[prev] ?? 0}.`, c?.faction ?? -1, [lead, prev], op.center);
  }

  onOpFinished(w: World, op: Operation, ranked: { id: number; score: number }[]): void {
    const top = ranked[0], second = ranked[1];
    for (const r of ranked.slice(1)) {
      const a = w.cmdById.get(top?.id ?? -1), b = w.cmdById.get(r.id);
      if (a && b && op.winner === a.id) this.clash(w, a, b, 'o', 6, op.center);
    }
    if (op.winner < 0 || !top || !second) return;
    const winner = w.cmdById.get(op.winner);
    if (!winner) return;
    // upset: the pool at cutoff mostly backed someone else (spectator data, read for a spectator headline only)
    const m = w.markets.find((x) => x.opId === op.id && x.kind === 'TOP_SCORE');
    const tot = m?.lockedTotals ? Object.values(m.lockedTotals).reduce((a, b) => a + b, 0) : 0;
    const share = m?.lockedTotals && tot > 0 ? (m.lockedTotals[winner.key] ?? 0) / tot : -1;
    if (share >= 0 && share < 0.2) {
      this.moment(w, 'UPSET', 76, `Upset in ${op.code}: ${winner.name} wins at ${op.name} with ${Math.round(share * 100)}% of the pool behind it (${top.score}–${second.score}).`, winner.faction, [winner.id, second.id], op.center);
      return;
    }
    // the last recorded lead change went to the winner within the final minute (a points tie broken later does not count)
    const late = this.st.op.id === op.id && this.st.op.lead === winner.id && this.st.op.lastChange >= op.endTick - 300;
    if (late || top.score - second.score <= Math.max(3, Math.round(top.score * 0.03))) {
      this.moment(w, 'PHOTO_FINISH', 72, `${winner.name} edges ${w.cmdName(second.id)} ${top.score}–${second.score} in ${op.code} at ${op.name}${late ? ', taking the lead in the final minute' : ''}.`, winner.faction, [winner.id, second.id], op.center);
    }
  }

  // ------------------------------------------------------------------ society
  onNotice(w: World, speaker: Commander, other: number): void {
    this.moment(w, 'NOTICE', 50, `${speaker.name} (${w.factionName(speaker.faction)}) serves notice on the pact with ${w.factionName(other)}: it ends after one operation.`, speaker.faction, [speaker.id], -1);
  }

  onPact(w: World, a: number, b: number, leader: number, share: number, ids: number[]): void {
    this.moment(w, 'PACT', 44, `${w.factionName(a)} and ${w.factionName(b)} sign a non-aggression pact while ${w.factionName(leader)} holds ${Math.round(share * 100)}% of world power.`, a, ids, -1);
  }

  onDescendant(w: World, parent: Commander, child: Commander): void {
    this.moment(w, 'DESCENDANT', 34, `${parent.name} sponsors a descendant: ${child.name}, generation ${child.gen}.`, parent.faction, [parent.id, child.id], -1);
  }

  // ------------------------------------------------------------------ periodic detectors
  step(w: World): void {
    if (w.tick % 25 === 0) this.scanCores(w);
    if (w.tick % CLOCK.SAMPLE === 0) this.sample(w);
  }

  private scanCores(w: World): void {
    const s = this.st;
    const hp: Record<number, number> = {};
    for (const st of w.structs) {
      if (st.kind !== S.CORE || st.faction < 0 || st.hp <= 0 || st.maxHp <= 0) continue;
      const frac = st.hp / st.maxHp;
      const prev = s.coreHp[st.id] ?? frac;
      hp[st.id] = frac;
      if (frac >= STORY.LAST_STAND || frac >= prev - 1e-6 || w.tick - (s.lastStand[st.id] ?? -1e9) < STORY.LAST_STAND_GAP) continue;
      s.lastStand[st.id] = w.tick;
      const owner = w.cmdById.get(st.owner), by = w.cmdById.get(st.hitBy);
      this.moment(w, 'LAST_STAND', 78, `${owner?.name ?? 'A'}'s command core is down to ${Math.round(frac * 100)}%${by ? ` under fire from ${by.name}` : ''}.`, st.faction, [st.owner, st.hitBy], st.tile);
    }
    s.coreHp = hp;
    for (const k of Object.keys(s.lastStand)) if (!(k in hp) && w.tick - s.lastStand[Number(k)] > STORY.LAST_STAND_GAP) delete s.lastStand[Number(k)];
  }

  private sample(w: World): void {
    const s = this.st;
    for (const r of s.rivals) r.heat = Math.round(r.heat * 0.85 * 100) / 100;
    for (const k of Object.keys(s.assaults)) if (w.tick - s.assaults[k] > 3000) delete s.assaults[k];
    const power = [0, 1, 2, 3].map((f) => w.cmds.filter((c) => c.faction === f && c.status === 'active').reduce((a, c) => a + c.power, 0));
    let lead = 0, last = 0;
    for (let f = 1; f < 4; f++) { if (power[f] > power[lead]) lead = f; if (power[f] < power[last]) last = f; }
    // a sample's last place counts toward a comeback only when it trailed the leader by a real margin
    s.lastRank.push(power[last] <= power[lead] * (1 - STORY.COMEBACK_GAP) ? last : -1);
    if (s.lastRank.length > 20) s.lastRank.shift();
    if (s.leader < 0 || w.tick < 900) { s.leader = lead; return; }
    // hysteresis: a challenger must beat the current leader by 2% to take the lead
    if (lead === s.leader || power[lead] < power[s.leader] * 1.02) return;
    const prev = s.leader;
    s.leader = lead;
    const wasLast = s.lastRank.lastIndexOf(lead, s.lastRank.length - 2);
    const leaders = w.cmds.filter((c) => c.faction === lead && c.status === 'active').map((c) => c.id);
    if (wasLast >= 0) {
      const secs = ((s.lastRank.length - 1 - wasLast) * CLOCK.SAMPLE) / 5;
      const ago = secs < 120 ? `${secs} seconds` : `${Math.round(secs / 60)} minutes`;
      this.moment(w, 'COMEBACK', 82, `Comeback: ${w.factionName(lead)} goes from last to first in world power in ${ago} (${Math.round(power[lead])} vs ${w.factionName(prev)} ${Math.round(power[prev])}).`, lead, leaders, -1);
    } else this.moment(w, 'NEW_LEADER', 62, `${w.factionName(lead)} overtakes ${w.factionName(prev)} for the lead in world power, ${Math.round(power[lead])} to ${Math.round(power[prev])}.`, lead, leaders, -1);
  }

  // ------------------------------------------------------------------ views
  record(id: number): CmdRecord { return this.st.records[id] ?? { closed: 0, won: 0, streak: 0, best: 0 }; }

  rivalView(w: World, r: Rivalry): RivalryView {
    return {
      a: r.a, b: r.b, nameA: w.cmdName(r.a), nameB: w.cmdName(r.b), fa: w.cmdById.get(r.a)?.faction ?? -1, fb: w.cmdById.get(r.b)?.faction ?? -1,
      scoreA: rivalScore(r, 0), scoreB: rivalScore(r, 1), kills: [...r.k], caps: [...r.c], cores: [...r.x], ops: [...r.o],
      clashes: r.clashes, since: r.since, last: r.last, heat: r.heat, named: r.named >= 0,
    };
  }

  /** Rivalries involving any two of the given commanders (operation rosters), most intense first. */
  between(w: World, ids: number[]): RivalryView[] {
    const out: RivalryView[] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const r = this.byPair.get(pairKey(ids[i], ids[j]));
      if (r) out.push(this.rivalView(w, r));
    }
    return out.sort((x, y) => y.scoreA + y.scoreB - (x.scoreA + x.scoreB));
  }

  involving(w: World, id: number, n: number): RivalryView[] {
    return this.st.rivals.filter((r) => r.a === id || r.b === id)
      .sort((x, y) => rivalScore(y, 0) + rivalScore(y, 1) - rivalScore(x, 0) - rivalScore(x, 1)).slice(0, n).map((r) => this.rivalView(w, r));
  }

  view(w: World, roster: number[]): StoryView {
    const s = this.st;
    const beats: PlanBeatView[] = s.beats.slice(-24).reverse().map((b) => ({
      id: b.id, tick: b.tick, cmd: b.cmd, name: w.cmdName(b.cmd), f: b.f, kind: PLAN_NAMES[b.kind], target: b.target, tile: b.tile,
      alt: b.alt ? { kind: PLAN_NAMES[b.alt.kind], target: b.alt.target, score: b.alt.score } : null, score: b.score, reason: b.reason,
      explored: b.explored, status: b.status, reward: b.reward, closed: b.closed,
    }));
    const moments: MomentView[] = s.moments.slice(-30).reverse().map((m) => ({ ...m, a: m.a.slice() }));
    const rank = (r: Rivalry) => (r.named >= 0 ? 1e6 : 0) + r.heat * 4 + rivalScore(r, 0) + rivalScore(r, 1);
    const rivalries = s.rivals.filter((r) => rivalScore(r, 0) + rivalScore(r, 1) >= 8).sort((x, y) => rank(y) - rank(x)).slice(0, 12).map((r) => this.rivalView(w, r));
    const focus: StoryView['focus'] = [];
    for (const m of s.moments) {
      const age = w.tick - m.tick;
      if (m.tile < 0 || age > STORY.FOCUS_WINDOW) continue;
      focus.push({ id: m.id, tile: m.tile, score: Math.round(m.weight * Math.pow(0.5, age / 300) * 10) / 10, kind: m.kind });
    }
    focus.sort((a, b) => b.score - a.score || b.id - a.id);
    const closed = s.kindN.reduce((a, b) => a + b, 0), won = s.kindWon.reduce((a, b) => a + b, 0);
    return {
      beats, moments, rivalries, opRivals: roster.length > 1 ? this.between(w, roster) : [], focus: focus.slice(0, 6),
      kinds: PLAN_NAMES.map((k, i) => ({ kind: k, n: s.kindN[i], won: s.kindWon[i] })),
      stats: { announced: s.announced, closed, won, moments: s.nextMoment - 1, named: s.rivals.filter((r) => r.named >= 0).length, pairs: s.rivals.length, evicted: s.evicted },
      counts: { ...s.counts }, headline: STORY.HEADLINE,
    };
  }
}

function round3(v: number): number { return Math.round(v * 1000) / 1000; }
