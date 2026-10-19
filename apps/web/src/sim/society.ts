// Agent society (design doc §6): founding muster, campaign musters, veteran succession with bounded
// doctrine mutation, defeat into reserve, reconstruction, emergency reconstruction, citadel awakening,
// autonomous team charters, inter-faction non-aggression treaties, and published weather.

import { CLOCK, DOCTRINE, FACTIONS, FRONTIER, MERIT, POP, S, STRUCTS, T } from '../shared/config.ts';
import { hex32 } from '../shared/rng.ts';
import type { World } from './world.ts';
import { makeCommander, remember } from './agents.ts';
import { apportion } from './operations.ts';
import { TASK, type Commander, type Team } from './types.ts';

// ------------------------------------------------------------------ founding
export function foundingMuster(w: World): void {
  for (let f = 0; f < 4; f++) {
    const base = FACTIONS[f].doctrine;
    for (const core of w.map.cores.filter((c) => c.faction === f)) {
      const tilt = core.slot === 0 ? [12, -8, 0, 6, 0, 0] : [-8, 10, 6, -4, 6, 4];
      const doctrine = base.map((v, i) => clamp(v + tilt[i] + w.rng.range(-6, 6), 0, 100));
      const c = makeCommander(w, { faction: f, doctrine, gen: 1, parents: [], birthKind: 'founding muster' });
      w.deployCommander(c, core.tile, 'founding');
      w.log('lineage', `Founding muster: ${c.name} (${FACTIONS[f].name}) takes command. Doctrine A${c.doctrine[0]} C${c.doctrine[1]} L${c.doctrine[2]} E${c.doctrine[3]} Y${c.doctrine[4]} D${c.doctrine[5]}.`, f, [c.id], core.tile);
    }
  }
  scheduleWeather(w, 0);
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ------------------------------------------------------------------ clock boundaries
export function clockEvents(w: World): void {
  const tick = w.tick;
  if (tick % 25 === 0) {
    w.storms = w.weather.filter((s) => tick >= s.start && tick < s.end).map((s) => ({ tile: s.tile, radius: s.radius }));
    for (const t of w.treaties) {
      if (t.status === 'notice' && tick >= t.endsAt) {
        t.status = 'ended';
        w.rebuildWar();
        w.log('diplomacy', `Non-aggression pact between ${FACTIONS[t.a].name} and ${FACTIONS[t.b].name} ended after its notice period.`, t.a, [], -1);
        bumpReviews(w, [t.a, t.b]);
      } else if (t.status === 'active' && tick >= t.expires) {
        t.status = 'ended';
        w.factions[t.a].trust[t.b] = Math.min(100, w.factions[t.a].trust[t.b] + 10);
        w.factions[t.b].trust[t.a] = Math.min(100, w.factions[t.b].trust[t.a] + 10);
        w.rebuildWar();
        w.log('diplomacy', `Non-aggression pact between ${FACTIONS[t.a].name} and ${FACTIONS[t.b].name} expired, fulfilled by both parties.`, t.a, [], -1);
        bumpReviews(w, [t.a, t.b]);
      }
    }
    // hostility cools slowly
    if (tick % 500 === 0) for (const fs of w.factions) fs.hostility = fs.hostility.map((h) => Math.floor(h * 0.9));
  }
  if (tick > 0 && tick % CLOCK.CAMPAIGN === 0) campaignBoundary(w);
  if (tick > 0 && tick % CLOCK.CHAPTER === 0) chapterBoundary(w);
}

function bumpReviews(w: World, factions: number[]): void {
  for (const c of w.cmds) if (c.status === 'active' && factions.includes(c.faction)) c.nextStrategic = Math.min(c.nextStrategic, w.tick + 10 + (c.id % 10));
}

function campaignIndex(w: World): number { return Math.floor(w.tick / CLOCK.CAMPAIGN); }

function campaignBoundary(w: World): void {
  const ci = campaignIndex(w);
  w.log('chapter', `Campaign ${ci + 1} begins. Musters, team charters and treaty windows are open.`, -1, [], -1);
  campaignMerit(w);
  evaluateTreaties(w);
  formTeams(w);
  muster(w, 'campaign muster', POP.MUSTER_MAX, 10);
  scheduleWeather(w, w.tick);
  for (const c of w.cmds) if (c.status === 'active') c.campaignBase = { sites: sitesOf(w, c.id), territory: territoryOf(w, c.id) };
}

function chapterBoundary(w: World): void {
  const ch = Math.floor(w.tick / CLOCK.CHAPTER) + 1;
  const power = [0, 1, 2, 3].map((f) => w.cmds.filter((c) => c.faction === f && c.status === 'active').reduce((a, c) => a + c.power, 0));
  const total = power.reduce((a, b) => a + b, 0) || 1;
  const lead = power.indexOf(Math.max(...power));
  const share = Math.round((power[lead] / total) * 100);
  w.log('chapter', `Chapter ${roman(ch)} opens. ${FACTIONS[lead].name} holds ${share}% of world power${share > 40 ? ' — a dominant position, acknowledged in the chronicle; only published rules shape the next fronts' : ''}.`, lead, [], -1);
  // chapter festival: one variant cohort member with a larger, announced mutation range
  muster(w, 'chapter festival', 1, 20);
}

export function roman(n: number): string {
  const t: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}

function sitesOf(w: World, id: number): number { let n = 0; for (const st of w.structs) if (st.owner === id && STRUCTS[st.kind].capturable) n++; return n; }
function territoryOf(w: World, id: number): number { let n = 0; for (let t = 0; t < w.grid.n; t++) if (w.owner[t] === id) n++; return n; }

// ------------------------------------------------------------------ campaign merit (validated objectives only)
function campaignMerit(w: World): void {
  const active = w.cmds.filter((c) => c.status === 'active');
  const scores = active.map((c) => {
    const sites = sitesOf(w, c.id);
    const terr = territoryOf(w, c.id);
    // held sites count; gains are capped so empty territory trading cannot farm merit
    return sites * 1 + Math.min(6, Math.max(0, sites - c.campaignBase.sites)) * 2 + Math.min(4, Math.max(0, terr - c.campaignBase.territory) / 15);
  });
  const parts = apportion(MERIT.campaignPool, scores, active.map((c) => c.id));
  const issuance = w.ledger.find('issuance', 'MERIT', 'issuance');
  const ci = campaignIndex(w);
  active.forEach((c, i) => {
    const amt = parts[i];
    if (amt <= 0) return;
    const r = w.ledger.post('merit_mint', `campaign-${ci}`, `merit-campaign-${ci}-${c.id}`, [[issuance, -amt], [c.meritAcct, amt]], w.tick);
    if (r.ok) c.meritGross += amt;
  });
}

// ------------------------------------------------------------------ treaties
function evaluateTreaties(w: World): void {
  const power = [0, 1, 2, 3].map((f) => w.cmds.filter((c) => c.faction === f && c.status === 'active').reduce((a, c) => a + c.power, 0));
  const total = power.reduce((a, b) => a + b, 0) || 1;
  const share = power.map((p) => p / total);
  const leader = share.indexOf(Math.max(...share));
  const speaker = (f: number) => w.cmds.filter((c) => c.faction === f && c.status === 'active').sort((a, b) => w.ledger.balance(b.meritAcct) - w.ledger.balance(a.meritAcct) || a.id - b.id)[0];
  // notices: a pact with a now-dominant partner is terminated with one operation of notice
  for (const t of w.treaties) {
    if (t.status !== 'active') continue;
    for (const [me, other] of [[t.a, t.b], [t.b, t.a]] as const) {
      const sp = speaker(me);
      if (!sp) continue;
      if (other === leader && share[other] > 0.36 && sp.doctrine[4] < 75) {
        t.status = 'notice';
        t.noticeAt = w.tick;
        const running = w.ops.find((o) => o.status === 'Running' || o.status === 'Locked' || o.status === 'Open');
        t.endsAt = running ? running.endTick : w.tick + CLOCK.OP_RUN;
        w.factions[other].trust[me] = Math.max(0, w.factions[other].trust[me] - 15);
        w.log('diplomacy', `${sp.name} (${FACTIONS[me].name}) gave notice on the pact with ${FACTIONS[other].name}; it ends after one operation.`, me, [sp.id], -1);
        w.story?.onNotice(w, sp, other);
        break;
      }
    }
  }
  // one new proposal per window: two non-leaders threatened by the leader
  if (share[leader] < 0.3) return;
  let best: [number, number] | null = null, bestU = 0.1;
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    if (a === leader || b === leader || !w.atWar(a, b)) continue;
    if (w.treaties.some((t) => t.status !== 'ended' && ((t.a === a && t.b === b) || (t.a === b && t.b === a)))) continue;
    if (!speaker(a) || !speaker(b)) continue;
    const host = (w.factions[a].hostility[b] + w.factions[b].hostility[a]) / 200;
    const trust = (w.factions[a].trust[b] + w.factions[b].trust[a]) / 200;
    const u = (share[leader] - 0.27) * 3 + (trust - 0.5) - host;
    if (u > bestU) { bestU = u; best = [a, b]; }
  }
  if (!best) return;
  const [a, b] = best;
  const pa = speaker(a)!, pb = speaker(b)!;
  const accept = pb.doctrine[4] >= 30 && w.factions[b].trust[a] >= 35;
  if (!accept) {
    w.log('diplomacy', `${pa.name} (${FACTIONS[a].name}) proposed non-aggression to ${FACTIONS[b].name}; ${pb.name} rejected it (trust ${w.factions[b].trust[a]}).`, a, [pa.id, pb.id], -1);
    return;
  }
  const id = w.treaties.length + 1;
  w.treaties.push({ id, a, b, kind: 'NAP', status: 'active', effective: w.tick, expires: w.tick + CLOCK.CAMPAIGN * 2, noticeAt: -1, endsAt: -1 });
  w.rebuildWar();
  bumpReviews(w, [a, b]);
  w.log('diplomacy', `${FACTIONS[a].name} and ${FACTIONS[b].name} signed a two-campaign non-aggression pact while ${FACTIONS[leader].name} holds ${Math.round(share[leader] * 100)}% of world power. Termination only at windows, one operation of notice.`, a, [pa.id, pb.id], -1);
  w.story?.onPact(w, a, b, leader, share[leader], [pa.id, pb.id]);
}

// ------------------------------------------------------------------ teams
const TEAM_WORDS = ['Iron', 'Ash', 'Storm', 'Night', 'Granite', 'Ember', 'Signal', 'Tide'];

function formTeams(w: World): void {
  for (const t of w.teams) for (const m of t.members) { const c = w.cmdById.get(m.id); if (c) { c.team = -1; c.role = 'unassigned'; } }
  w.teams = [];
  const ci = campaignIndex(w);
  for (let f = 0; f < 4; f++) {
    const act = w.cmds.filter((c) => c.faction === f && c.status === 'active').sort((a, b) => a.id - b.id);
    if (act.length < 2) continue;
    const trustRole = (c: Commander) => w.ledger.balance(c.meritAcct) / 40 + reliability(c) * 2 + (c.elo - 1200) / 100 + c.doctrine[4] / 100;
    const leader = act.slice().sort((a, b) => trustRole(b) - trustRole(a) || a.id - b.id)[0];
    const roles = ['assault lead', 'quartermaster', 'defensive reserve', 'scout'];
    const roleParam = [0, 2, 1, 5];
    const assigned = new Map<number, string>();
    for (let r = 0; r < roles.length; r++) {
      const pool = act.filter((c) => !assigned.has(c.id));
      if (!pool.length) break;
      const pick = pool.sort((a, b) => b.doctrine[roleParam[r]] - a.doctrine[roleParam[r]] || a.id - b.id)[0];
      assigned.set(pick.id, roles[r]);
    }
    const members: Team['members'] = [];
    for (const c of act) {
      const role = assigned.get(c.id) ?? 'defensive reserve';
      if (c.id === leader.id) { members.push({ id: c.id, role, accepted: true }); continue; }
      const top = c.doctrine.indexOf(Math.max(...c.doctrine));
      const complement = roleParam[roles.indexOf(role)] === top ? 0.25 : 0.1;
      const trust = c.trust[leader.id] ?? 50;
      const accept = (c.doctrine[4] / 100) * 0.6 + complement + trust / 200 - 0.35 >= 0;
      members.push({ id: c.id, role, accepted: accept });
      w.log('team', `${c.name} ${accept ? 'accepted' : 'rejected'} the charter from ${leader.name} (${role}; loyalty ${c.doctrine[4]}, trust ${Math.round(trust)}).`, f, [c.id, leader.id], -1);
    }
    if (members.filter((m) => m.accepted).length < 2) continue;
    const team: Team = {
      id: ci * 10 + f + 1, faction: f, name: `${FACTIONS[f].name} ${TEAM_WORDS[(ci + f) % TEAM_WORDS.length]} Pact`, leader: leader.id,
      members, objective: leader.plan?.name ?? 'hold the front', budget: 50, formed: w.tick, expires: w.tick + CLOCK.CAMPAIGN,
      split: 'by observed contribution', record: { ops: 0, captures: 0 },
    };
    w.teams.push(team);
    for (const m of members) {
      const c = w.cmdById.get(m.id)!;
      if (m.accepted) { c.team = team.id; c.role = m.role; }
    }
    w.log('team', `${team.name} chartered: leader ${leader.name}; roles ${members.filter((m) => m.accepted).map((m) => `${w.cmdName(m.id)} ${m.role}`).join(', ')}; budget ${team.budget}% of forces for one campaign.`, f, members.map((m) => m.id), -1);
  }
}

export function reliability(c: Commander): number {
  const valid = c.rel.issued ? 1 - c.rel.rejected / c.rel.issued : 1;
  const fb = c.rel.decisions ? c.rel.fallbacks / c.rel.decisions : 0;
  return Math.max(0, valid * (1 - fb * 0.5));
}

// ------------------------------------------------------------------ musters, succession, reconstruction
function activeCount(w: World, f?: number): number { return w.cmds.filter((c) => c.status === 'active' && (f === undefined || c.faction === f)).length; }

/**
 * Extra muster after a frontier opening (§3.4): eligible commanders deploy within the larger, land-scaled caps, then
 * a founding wave settles the new ground. Without it headcount lags the land: the ordinary muster only deploys
 * commanders who already qualify (awaiting heirs, paid reconstructions, 200-merit veterans), and at an opening
 * nobody usually does.
 */
export function frontierMuster(w: World): void {
  muster(w, 'frontier muster', POP.MUSTER_MAX, 10);
  frontierFounding(w);
}

/**
 * One gen-1 commander per faction, all four factions or none so expansion stays balanced. Sites are chosen before
 * anyone deploys (rotated faction order) and must lie far enough apart that one deployment cannot spoil another's.
 */
function frontierFounding(w: World): void {
  if (activeCount(w) + 4 > w.activeCap()) return;
  for (let f = 0; f < 4; f++) if (activeCount(w, f) >= w.factionCap(f)) return;
  const ev = Math.floor(w.frontierVersion / FRONTIER.perEvent);
  const order = [0, 1, 2, 3].map((k) => (ev + k) % 4);
  const tiles = order.map((f) => findCoreSite(w, f));
  if (tiles.some((t) => t < 0)) return;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (w.grid.dist(tiles[i], tiles[j]) < 16) return;
  order.forEach((f, i) => {
    const doctrine = FACTIONS[f].doctrine.map((v) => clamp(v + w.rng.range(-8, 8), 0, 100));
    const c = makeCommander(w, { faction: f, doctrine, gen: 1, parents: [], birthKind: 'frontier founding' });
    w.deployCommander(c, tiles[i], 'reconstruction');
    c.campaignBase = { sites: 0, territory: territoryOf(w, c.id) };
    const ci = w.chunkOf(tiles[i]);
    const where = w.isFrontierChunk(ci) ? `frontier chunk ${w.chunkName(ci)}` : 'home territory';
    w.log('lineage', `${c.name} (${FACTIONS[f].name}, gen 1) deployed — frontier muster: founding on ${where}. Doctrine A${c.doctrine[0]} C${c.doctrine[1]} L${c.doctrine[2]} E${c.doctrine[3]} Y${c.doctrine[4]} D${c.doctrine[5]}. Standard starter budget only.`, f, [c.id], tiles[i]);
  });
}

function muster(w: World, occasion: string, maxNew: number, mutRange: number): void {
  let spawned = 0;
  const ci = campaignIndex(w);
  // rotate faction order so no faction always musters first
  for (let k = 0; k < 4 && spawned < maxNew; k++) {
    const f = (ci + k) % 4;
    if (activeCount(w) >= w.activeCap() || activeCount(w, f) >= w.factionCap(f)) continue;
    // 1. awaiting descendants deploy first, 2. reconstruct reserve commanders, 3. veteran succession
    const awaiting = w.cmds.find((c) => c.faction === f && c.status === 'reserve' && c.awaiting);
    if (awaiting) { if (deployFromReserve(w, awaiting, `${occasion}: descendant deployment`)) spawned++; continue; }
    const recon = w.cmds
      .filter((c) => c.faction === f && c.status === 'reserve' && !c.awaiting && w.tick - c.reserveSince >= CLOCK.CAMPAIGN)
      .sort((a, b) => a.reserveSince - b.reserveSince)[0];
    if (recon && w.ledger.balance(recon.meritAcct) >= POP.RECON_MERIT) {
      const sink = w.ledger.find('sink', 'MERIT', 'sink');
      const r = w.ledger.post('merit_spend', `reconstruct-${recon.id}`, `recon-${recon.id}-${w.tick}`, [[recon.meritAcct, -POP.RECON_MERIT], [sink, POP.RECON_MERIT]], w.tick);
      if (r.ok) { recon.meritSpent += POP.RECON_MERIT; if (deployFromReserve(w, recon, `${occasion}: reconstruction (paid ${POP.RECON_MERIT} merit)`)) spawned++; continue; }
    }
    const sponsor = w.cmds
      .filter((c) => c.faction === f && c.status === 'active' && c.stats.plans >= POP.SPONSOR_PLANS && w.ledger.balance(c.meritAcct) >= POP.SPONSOR_MERIT && w.tick - c.lastDescendant >= CLOCK.CAMPAIGN)
      .sort((a, b) => w.ledger.balance(b.meritAcct) - w.ledger.balance(a.meritAcct) || a.id - b.id)[0];
    if (sponsor) {
      const child = createDescendant(w, sponsor, occasion, mutRange);
      if (child && deployFromReserve(w, child, `${occasion}: veteran succession`)) spawned++;
    }
  }
}

function createDescendant(w: World, parent: Commander, occasion: string, mutRange: number): Commander | null {
  if (w.cmds.filter((c) => c.status === 'reserve').length >= POP.RESERVE_CAP) retireOldestReserve(w);
  const sink = w.ledger.find('sink', 'MERIT', 'sink');
  const r = w.ledger.post('merit_spend', `descendant-${parent.id}`, `desc-${parent.id}-${w.tick}`, [[parent.meritAcct, -POP.SPONSOR_MERIT], [sink, POP.SPONSOR_MERIT]], w.tick);
  if (!r.ok) return null;
  parent.meritSpent += POP.SPONSOR_MERIT;
  parent.lastDescendant = w.tick;
  // optional co-parent: an accepted teammate with merit contributes half the doctrine blend (no merit cost)
  const team = w.teams.find((t) => t.id === parent.team);
  const coId = team?.members.find((m) => m.accepted && m.id !== parent.id)?.id;
  const co = coId !== undefined ? w.cmdById.get(coId) : undefined;
  const blend = co && w.ledger.balance(co.meritAcct) >= 100 ? parent.doctrine.map((v, i) => Math.floor((v + co.doctrine[i]) / 2)) : parent.doctrine.slice();
  const seed = w.rng.u32();
  const before = blend.slice();
  const nMut = 1 + w.rng.int(2);
  const params: number[] = [];
  while (params.length < nMut) { const p = w.rng.int(6); if (!params.includes(p)) params.push(p); }
  const mutation: { param: string; delta: number }[] = [];
  for (const p of params) {
    let d = w.rng.range(-mutRange, mutRange);
    if (d === 0) d = 1;
    blend[p] = clamp(blend[p] + d, 0, 100);
    mutation.push({ param: DOCTRINE[p], delta: blend[p] - before[p] });
  }
  const parents = co && blend.some((v, i) => v !== parent.doctrine[i] && co.doctrine[i] !== parent.doctrine[i]) ? [parent.id, co.id] : [parent.id];
  const child = makeCommander(w, { faction: parent.faction, doctrine: blend, gen: parent.gen + 1, parents, birthKind: occasion });
  child.mutation = mutation;
  child.awaiting = true;
  parent.children.push(child.id);
  if (parents.length > 1 && co) co.children.push(child.id);
  // at most two approved historical lessons, provenance retained
  const lessons = parent.memory.filter((m) => m.kind === 'DANGER' || m.kind === 'PLAN_OUTCOME').sort((a, b) => b.conf - a.conf).slice(0, 2);
  for (const l of lessons) remember(w, child, { kind: 'LESSON', tile: l.tile, subject: l.subject, value: l.value, conf: Math.min(0.8, l.conf), tick: w.tick, src: `inherited from ${parent.name} (${l.kind.toLowerCase()})` });
  const mtxt = mutation.map((m) => `${m.param} ${before[DOCTRINE.indexOf(m.param as typeof DOCTRINE[number])]}→${before[DOCTRINE.indexOf(m.param as typeof DOCTRINE[number])] + m.delta}`).join(', ');
  w.log('lineage', `${parent.name} sponsored descendant ${child.name} (gen ${child.gen}${parents.length > 1 ? `, co-parent ${co!.name}` : ''}) for ${POP.SPONSOR_MERIT} merit. Mutation: ${mtxt}. Seed ${hex32(seed)}. No inherited skill rating.`, parent.faction, [parent.id, child.id], -1);
  w.story?.onDescendant(w, parent, child);
  return child;
}

function retireOldestReserve(w: World): void {
  const r = w.cmds.filter((c) => c.status === 'reserve').sort((a, b) => a.reserveSince - b.reserveSince)[0];
  if (!r) return;
  r.status = 'retired';
  w.log('lineage', `${r.name} retired from reserve (reserve capacity). Its record and defeats remain in the chronicle.`, r.faction, [r.id], -1);
}

function deployFromReserve(w: World, c: Commander, why: string): boolean {
  const tile = findCoreSite(w, c.faction);
  if (tile < 0) return false;
  c.awaiting = false;
  w.deployCommander(c, tile, 'reconstruction');
  c.campaignBase = { sites: 0, territory: territoryOf(w, c.id) };
  w.log('lineage', `${c.name} (${FACTIONS[c.faction].name}, gen ${c.gen}) deployed — ${why}. Standard starter budget only.`, c.faction, [c.id], tile);
  return true;
}

/** Hex distance (capped) from every tile to the nearest tile matching `src`: multi-source BFS, O(n). */
function distField(w: World, src: (t: number) => boolean, cap: number): Uint8Array {
  const g = w.grid, n = g.n;
  const d = new Uint8Array(n).fill(cap);
  const q = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let t = 0; t < n; t++) if (src(t)) { d[t] = 0; q[qt++] = t; }
  while (qh < qt) {
    const u = q[qh++];
    const du = d[u] + 1;
    if (du >= cap) continue;
    for (let k = 0; k < 6; k++) { const v = g.nb[u * 6 + k]; if (v >= 0 && d[v] > du) { d[v] = du; q[qt++] = v; } }
  }
  return d;
}

/**
 * Deployment site for a new or returning commander: supplied home territory, or open unowned land within 6 of the
 * faction's territory and at least 8 from any enemy (newly opened frontier preferred, so new commanders settle it).
 * Falls back to the bounded reserve entry. Closed frontier tiles are never used.
 */
export function findCoreSite(w: World, f: number): number {
  const g = w.grid;
  const fs = w.factions[f];
  let best = -1, bestScore = -1e9;
  const dEnemy = distField(w, (t) => { const of = w.ownerF[t]; return of >= 0 && of !== f; }, 30);
  const dOwn = distField(w, (t) => w.ownerF[t] === f, 8);
  const cores = w.structs.filter((s) => s.kind === S.CORE);
  const occupied = new Uint8Array(g.n);
  for (const st of w.structs) occupied[st.tile] = 1;
  const newest = new Set(w.lastOpenedChunks());
  for (let t = 0; t < g.n; t++) {
    if (!w.active[t] || occupied[t]) continue;
    const of = w.ownerF[t];
    const home = of === f && fs.inSupply[t] === 1;
    const settle = of === -1 && dOwn[t] <= 6 && dEnemy[t] >= 8;
    if (!home && !settle) continue;
    const tt = w.terrain[t];
    if (tt !== T.PLAINS && tt !== T.ROAD && tt !== T.RUIN) continue;
    if (dEnemy[t] < 6) continue;
    let near = false;
    for (const st of cores) if (g.dist(st.tile, t) < 7) { near = true; break; }
    if (near) continue;
    let score = dEnemy[t] * 2 - g.dist(t, fs.reserveEntry) * 0.15;
    // frontier land outranks any home tile (max 60 from distance), the newest chunks most
    if (settle) { const ci = w.chunkOf(t); if (w.isFrontierChunk(ci)) score += newest.has(ci) ? 60 : 45; }
    if (score > bestScore) { bestScore = score; best = t; }
  }
  if (best >= 0) return best;
  // bounded reserve entry outside immediate enemy firing range
  const entry = fs.reserveEntry;
  for (const t of g.within(entry, 4)) {
    if (!w.active[t] || w.moveCost[t] === 0 || w.structAt(t)) continue;
    let hostile = false;
    for (const s of w.squads) if (s.faction !== f && g.dist(s.tile, t) <= 6) { hostile = true; break; }
    if (!hostile) return t;
  }
  return -1;
}

// ------------------------------------------------------------------ defeat
export function onCoreDestroyed(w: World, c: Commander, killerId: number): void {
  const killer = w.cmdById.get(killerId);
  w.story?.onCoreFell(w, c, killer, w.structById.get(c.coreId)?.tile ?? c.homeTile);
  c.status = 'reserve';
  c.reserveSince = w.tick;
  c.plan = null;
  c.queue = [];
  const heir = w.cmds
    .filter((x) => x.status === 'active' && x.faction === c.faction && x.id !== c.id)
    .sort((a, b) => w.ledger.balance(b.meritAcct) - w.ledger.balance(a.meritAcct) || a.id - b.id)[0];
  const mine = w.squads.filter((s) => s.owner === c.id);
  if (heir) {
    let moved = 0;
    for (const s of mine) {
      if (w.squads.filter((x) => x.owner === heir.id).length >= 16) { s.hp = 0; continue; }
      s.owner = heir.id; s.task = TASK.IDLE; moved++;
    }
    for (let t = 0; t < w.grid.n; t++) if (w.owner[t] === c.id) w.setOwner(t, heir.id);
    for (const st of w.structs) if (st.owner === c.id) st.owner = heir.id;
    w.log('battle', `${c.name}'s command core fell to ${killer?.name ?? 'enemy fire'}. ${c.name} enters reserve; ${moved} squads and its territory transfer to ${heir.name}.`, c.faction, killer ? [c.id, killer.id, heir.id] : [c.id, heir.id], w.structById.get(c.coreId)?.tile ?? -1);
  } else {
    for (const s of mine) s.hp = 0;
    for (let t = 0; t < w.grid.n; t++) if (w.owner[t] === c.id) w.setOwner(t, -1);
    for (const st of w.structs) if (st.owner === c.id) { st.owner = -1; st.faction = -1; }
    w.log('battle', `${c.name}'s command core fell to ${killer?.name ?? 'enemy fire'}. ${FACTIONS[c.faction].name} has no command presence left; remnant forces disperse.`, c.faction, killer ? [c.id, killer.id] : [c.id], w.structById.get(c.coreId)?.tile ?? -1);
  }
  if (killer) {
    remember(w, killer, { kind: 'PLAN_OUTCOME', tile: c.homeTile, subject: 2, value: 1, conf: 0.9, tick: w.tick, src: `destroyed ${c.name} core` });
    w.factions[c.faction].hostility[killer.faction] = 100;
  }
  for (const t of w.teams) {
    const m = t.members.find((x) => x.id === c.id);
    if (m) m.accepted = false;
  }
  c.team = -1;
  c.coreId = -1;
  if (w.cmds.filter((x) => x.status === 'reserve').length > POP.RESERVE_CAP) retireOldestReserve(w);
}

/** Emergency reconstruction when a faction has lost its viable command presence (§6.1). */
export function emergencyCheck(w: World): void {
  for (let f = 0; f < 4; f++) {
    if (activeCount(w, f) > 0) continue;
    // wait until operations that involve this faction finish
    if (w.ops.some((o) => (o.status === 'Locked' || o.status === 'Running') && o.roster.some((id) => w.cmdById.get(id)?.faction === f))) continue;
    if (activeCount(w) >= w.activeCap()) continue;
    let c = w.cmds.filter((x) => x.faction === f && x.status === 'reserve').sort((a, b) => a.reserveSince - b.reserveSince)[0];
    if (!c) c = makeCommander(w, { faction: f, doctrine: FACTIONS[f].doctrine.slice(), gen: 1, parents: [], birthKind: 'emergency reconstruction' });
    const tile = findCoreSite(w, f);
    if (tile < 0) continue;
    c.awaiting = false;
    w.deployCommander(c, tile, 'reconstruction');
    w.log('lineage', `Emergency reconstruction: ${c.name} redeploys for ${FACTIONS[f].name} at its reserve entry with the standard starter budget.`, f, [c.id], tile);
  }
}

// ------------------------------------------------------------------ weather (published schedule, §3.5)
const STORM_NAMES = ['Ion squall', 'Dust front', 'Static veil', 'Ash storm', 'Magnetic surge'];

function scheduleWeather(w: World, from: number): void {
  w.weather = w.weather.filter((s) => s.end > w.tick);
  const sites = w.structs.filter((s) => STRUCTS[s.kind].capturable && s.kind !== S.CITADEL && w.active[s.tile]);
  if (!sites.length) return;
  for (let i = 0; i < 2; i++) {
    const site = sites[w.rng.int(sites.length)];
    const start = from + 600 + w.rng.int(Math.floor(CLOCK.CAMPAIGN * 0.6));
    w.weather.push({ id: w.weather.length + w.tick + i, name: `${STORM_NAMES[w.rng.int(STORM_NAMES.length)]} over ${site.name}`, tile: site.tile, radius: 6, start, end: start + 2400 });
  }
}
