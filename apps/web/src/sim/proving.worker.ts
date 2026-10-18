/// <reference lib="webworker" />
// Proving ground: equal-budget mirrored duels on a small arena, run headless as fast as possible.
// Policies are frozen snapshots (no learning during evaluation); faction modifiers are neutral.

import { hex32 } from '../shared/rng.ts';
import type { EvalMatch, EvalResult } from '../shared/protocol.ts';
import { World } from './world.ts';

declare const self: DedicatedWorkerGlobalScope;

const DUEL_TICKS = 2400;

function runDuel(m: EvalMatch): EvalResult {
  const [side0, side1] = m.swapped ? [m.b, m.a] : [m.a, m.b];
  const w = new World('duel', m.seed, { a: side0, b: side1 });
  w.learning = false;
  let ticks = 0;
  for (; ticks < DUEL_TICKS; ticks++) {
    w.step();
    if (w.cmds.some((c) => c.status !== 'active')) break;
  }
  const op = w.ops[0];
  const s0 = op?.scores[side0.id] ?? 0, s1 = op?.scores[side1.id] ?? 0;
  const dead0 = w.cmdById.get(side0.id)?.status !== 'active';
  const dead1 = w.cmdById.get(side1.id)?.status !== 'active';
  let win0: 'win' | 'loss' | 'draw';
  if (dead0 && !dead1) win0 = 'loss';
  else if (dead1 && !dead0) win0 = 'win';
  else win0 = s0 > s1 ? 'win' : s1 > s0 ? 'loss' : 'draw';
  const aIs0 = !m.swapped;
  const aResult = aIs0 ? win0 : win0 === 'win' ? 'loss' : win0 === 'loss' ? 'win' : 'draw';
  return {
    id: m.id, a: m.a.id, b: m.b.id, seed: m.seed, swapped: m.swapped,
    winner: aResult === 'win' ? 'a' : aResult === 'loss' ? 'b' : 'draw',
    scoreA: aIs0 ? s0 : s1, scoreB: aIs0 ? s1 : s0, ticks, hash: hex32(w.stateHash),
  };
}

self.onmessage = (ev: MessageEvent<{ type: 'match'; match: EvalMatch }>) => {
  if (ev.data.type !== 'match') return;
  try {
    self.postMessage({ type: 'result', result: runDuel(ev.data.match) });
  } catch (e) {
    self.postMessage({ type: 'error', id: ev.data.match.id, message: String(e) });
  }
};
