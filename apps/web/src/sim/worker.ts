/// <reference lib="webworker" />
// The authoritative world process for this browser sandbox. Runs fixed 5 Hz ticks scaled by the
// spectator's playback speed, publishes committed views, and persists durable snapshots.

import { CLOCK, TICK_HZ } from '../shared/config.ts';
import { hashStr } from '../shared/rng.ts';
import type { ClientCmd, EvalResult, PerfView, PolicySnapshot, WorkerMsg } from '../shared/protocol.ts';
import { World } from './world.ts';
import { buildDossier, buildFrame, buildFrontier, buildStatic, buildUi, newViewState, type ViewState } from './view.ts';
import { claimGrant, placeBet } from './market.ts';
import { clearSnapshot, deserialize, loadSnapshot, saveSnapshot, serialize } from './persist.ts';
import { policyLabel } from './agents.ts';

declare const self: DedicatedWorkerGlobalScope;

let world: World | null = null;
let vs: ViewState = newViewState();
let speed = 2;
let paused = false;
let acc = 0;
let last = performance.now();
let lastFrame = 0, lastUi = 0, lastDossier = 0, lastSave = performance.now(), lastEval = 0;
let evalPending = -1;
let lastSaveTick = 0, saveBytes = 0, frameBytes = 0;
let lagging = false;
let frontierSent = -1; // frontierVersion of the last FrontierMsg posted
const tickTimes = new Float64Array(600);
let tickIdx = 0, tickCount = 0;
const tpsWindow: number[] = [];

function post(msg: WorkerMsg, transfer: Transferable[] = []): void { self.postMessage(msg, transfer); }

function toast(level: 'ok' | 'warn' | 'err' | 'info', text: string): void { post({ type: 'toast', level, text }); }

async function start(resume: boolean, seed?: number): Promise<void> {
  let resumed = false;
  world = null;
  if (resume) {
    const text = await loadSnapshot();
    if (text) {
      try { world = deserialize(text); resumed = !!world; } catch (e) { console.warn('snapshot restore failed', e); world = null; }
    }
  }
  if (!world) world = new World('world', seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0));
  vs = newViewState();
  vs.selected = world.cmds.find((c) => c.status === 'active')?.id ?? -1;
  lastSaveTick = world.tick;
  post({ type: 'static', map: buildStatic(world) });
  sendFrontier(true);
  post({ type: 'ready', resumed });
  sendFrame();
  sendUi();
  sendDossier();
}

function perfView(): PerfView {
  const n = Math.min(tickCount, tickTimes.length);
  const arr = Array.from(tickTimes.subarray(0, n)).sort((a, b) => a - b);
  const q = (p: number) => (n ? arr[Math.min(n - 1, Math.floor(n * p))] : 0);
  const nowT = performance.now();
  while (tpsWindow.length && nowT - tpsWindow[0] > 1000) tpsWindow.shift();
  return {
    tickP50: q(0.5), tickP95: q(0.95), tickP99: q(0.99), tps: tpsWindow.length, targetTps: paused ? 0 : speed * TICK_HZ, lagging,
    visMs: 0, agentMs: 0, flowFields: 0, flowHits: 0, flowMisses: 0, frameBytes, entities: 0, memoryFacts: 0, decisions: 0,
    lastSaveTick, saveBytes, stateHash: '', hashHist: [],
  };
}

/** Active mask + site list; posted after the static map and whenever chunks open, before the frame that shows them. */
function sendFrontier(initial = false): void {
  if (!world) return;
  const msg = buildFrontier(world, initial);
  frontierSent = world.frontierVersion;
  post(msg, [msg.active.buffer as ArrayBuffer]);
}

function sendFrame(): void {
  if (!world) return;
  const { msg, transfer } = buildFrame(world, vs);
  frameBytes = transfer.reduce((a, b) => a + b.byteLength, 0);
  post(msg, transfer);
}

function sendUi(): void {
  if (!world) return;
  post({ type: 'ui', ui: buildUi(world, vs, speed, paused, perfView(), { running: evalPending >= 0 }) });
}

function sendDossier(): void {
  if (!world || vs.selected < 0) return;
  post({ type: 'dossier', d: buildDossier(world, vs.selected) });
}

async function save(): Promise<void> {
  if (!world) return;
  try {
    const text = serialize(world);
    saveBytes = text.length;
    await saveSnapshot(text);
    lastSaveTick = world.tick;
  } catch (e) {
    console.warn('save failed', e);
  }
}

function snapshotPolicy(id: number): PolicySnapshot | null {
  const c = world?.cmdById.get(id);
  if (!c) return null;
  return { id: c.id, name: c.name, doctrine: c.doctrine.slice(), weights: c.lw.slice(), policy: policyLabel(c) };
}

/** Proving ground: rotate mirrored, equal-budget duels against a frozen opponent pool (§7.2). */
function requestEval(): void {
  if (!world) return;
  const pool = world.cmds.filter((c) => c.status !== 'retired' && c.stats.plans >= 2);
  if (pool.length < 2) return;
  const a = pool.slice().sort((x, y) => x.evalGames - y.evalGames || x.id - y.id)[0];
  const others = pool.filter((c) => c.id !== a.id);
  const b = others[(world.evalCounter * 7 + a.id) % others.length];
  const id = ++world.evalCounter;
  const seed = hashStr(`${world.seed}:eval:${Math.floor(id / 2)}`);
  const swapped = id % 2 === 0;
  const pa = snapshotPolicy(a.id)!, pb = snapshotPolicy(b.id)!;
  evalPending = id;
  post({ type: 'evalRequest', match: { id, seed, a: pa, b: pb, swapped } });
}

function applyEval(r: EvalResult): void {
  evalPending = -1;
  if (!world) return;
  const a = world.cmdById.get(r.a), b = world.cmdById.get(r.b);
  if (!a || !b) return;
  const ea = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400));
  const sa = r.winner === 'a' ? 1 : r.winner === 'draw' ? 0.5 : 0;
  const ka = a.evalGames < 10 ? 32 : 20, kb = b.evalGames < 10 ? 32 : 20;
  a.elo += ka * (sa - ea);
  b.elo += kb * ((1 - sa) - (1 - ea));
  a.evalGames++; b.evalGames++;
  if (sa === 1) a.evalWins++; else if (sa === 0) b.evalWins++; else { a.evalDraws++; b.evalDraws++; }
  world.evals.push({ id: r.id, a: r.a, b: r.b, seed: r.seed, result: r.winner, ticks: r.ticks, scoreA: r.scoreA, scoreB: r.scoreB, swapped: r.swapped });
  if (world.evals.length > 40) world.evals.shift();
  const res = r.winner === 'draw' ? 'drew' : r.winner === 'a' ? 'beat' : 'lost to';
  // the proving-ground tab lists every duel; the chronicle records only upsets (the underdog by 150+ Elo wins)
  const upset = (sa === 1 && ea < 0.3) || (sa === 0 && ea > 0.7);
  if (upset) world.log('eval', `Proving ground #${r.id}: ${a.name} ${res} ${b.name} ${r.scoreA}–${r.scoreB} (equal budget, ${r.swapped ? 'sides swapped' : 'standard sides'}, seed ${(r.seed >>> 0).toString(16)}). Elo ${Math.round(a.elo)} / ${Math.round(b.elo)}.`, a.faction, [a.id, b.id], -1);
}

function loop(): void {
  const now = performance.now();
  const dt = Math.min(250, now - last);
  last = now;
  if (world && !paused) {
    acc += (dt * speed * TICK_HZ) / 1000;
    const maxBacklog = Math.max(10, speed * TICK_HZ * 1.5);
    lagging = acc > maxBacklog;
    if (acc > maxBacklog) acc = maxBacklog;
    const end = now + 24;
    while (acc >= 1 && performance.now() < end) {
      const t0 = performance.now();
      world.step();
      const t1 = performance.now();
      tickTimes[tickIdx] = t1 - t0;
      tickIdx = (tickIdx + 1) % tickTimes.length;
      tickCount++;
      tpsWindow.push(t1);
      acc -= 1;
    }
  }
  if (world) {
    if (world.frontierVersion !== frontierSent) sendFrontier();
    if (now - lastFrame >= 50) { lastFrame = now; sendFrame(); }
    if (now - lastUi >= 250) { lastUi = now; sendUi(); }
    if (now - lastDossier >= 500) { lastDossier = now; sendDossier(); }
    if (now - lastSave >= 30000) { lastSave = now; void save(); }
    if (evalPending < 0 && now - lastEval > 4000 && world.tick > CLOCK.STRATEGIC_MIN * 2) { lastEval = now; requestEval(); }
  }
  setTimeout(loop, 8);
}

self.onmessage = (ev: MessageEvent<ClientCmd>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init': void start(m.resume, m.seed); break;
    case 'speed': speed = Math.max(0.5, Math.min(32, m.speed)); paused = false; break;
    case 'pause': paused = m.paused; break;
    case 'select': vs.selected = m.id; lastDossier = 0; sendDossier(); break;
    case 'viewFaction': vs.viewFaction = m.f; break;
    case 'bet': {
      if (!world) break;
      const r = placeBet(world, world.wallet.acct, m.marketId, m.outcomeId, Math.floor(m.stake), m.idem);
      toast(r.ok ? 'ok' : 'warn', r.msg);
      // durability: an accepted stake is written to the snapshot immediately, so a reload cannot lose it
      if (r.ok) void save();
      sendUi();
      break;
    }
    case 'claimGrant': {
      if (!world) break;
      const r = claimGrant(world, m.idem);
      toast(r.ok ? 'ok' : 'warn', r.msg);
      if (r.ok) void save();
      sendUi();
      break;
    }
    case 'rename': if (world) world.wallet.name = m.name.slice(0, 24); break;
    case 'newWorld': void clearSnapshot().then(() => start(false, m.seed)); break;
    case 'save': void save().then(() => toast('info', `Durable snapshot written at tick ${world?.tick ?? 0}.`)); break;
    case 'evalResult': applyEval(m.result); break;
  }
};

self.addEventListener('error', (e) => toast('err', `World worker error: ${e.message}`));
loop();
