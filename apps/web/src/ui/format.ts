import { FACTIONS, NEUTRAL_CSS } from '../shared/config.ts';

export const fcss = (f: number): string => (f >= 0 && f < 4 ? FACTIONS[f].css : NEUTRAL_CSS);
export const fname = (f: number): string => (f >= 0 && f < 4 ? FACTIONS[f].name : 'Neutral');

export function num(n: number): string { return Math.round(n).toLocaleString('en-US'); }

export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return Math.round(n).toLocaleString('en-US');
}

export function pct(v: number, d = 0): string { return `${(v * 100).toFixed(d)}%`; }

export function signed(n: number, d = 0): string { const s = n.toFixed(d); return n > 0 ? `+${s}` : s; }

/** Simulation clock from ticks (5 ticks = 1 simulated second). */
export function simClock(ticks: number): string {
  const s = Math.max(0, Math.floor(ticks / 5));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function simDur(ticks: number): string {
  const s = Math.max(0, Math.ceil(ticks / 5));
  const m = Math.floor(s / 60), sec = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Wall-clock estimate at the current playback speed. */
export function realEta(ticks: number, speed: number, paused: boolean): string {
  if (paused) return 'paused';
  const s = ticks / 5 / Math.max(0.5, speed);
  if (s < 60) return `~${Math.ceil(s)}s`;
  if (s < 3600) return `~${Math.round(s / 60)}m`;
  return `~${(s / 3600).toFixed(1)}h`;
}

export function shortHash(h: string, n = 10): string { return h ? `${h.slice(0, n)}…` : '—'; }

export const CAT_COLORS: Record<string, string> = {
  battle: '#ff6a55', territory: '#ffb547', ops: '#ffd166', market: '#7fe7ff', lineage: '#c08cff', diplomacy: '#7ee2a8',
  team: '#5aa9ff', policy: '#9aa7ff', eval: '#b8c2d0', chapter: '#e6ebf2', build: '#8fd3c0', frontier: '#ff8a3d', story: '#ff4f9a',
};

// ------------------------------------------------------------------ story layer
/** Plan kinds whose target names already start with what they are ("support Mirage: …", "recon near …"). */
const SELF_NAMED = new Set(['SECURE_SUPPLY', 'RECON', 'SUPPORT', 'REGROUP']);
export const kindText = (kind: string): string => kind.replace('_', ' ').toLowerCase();
/** [verb, object] for a plan, saying the kind once: ["recon", "near Relay 9"], ["secure supply", "line toward Hub Gate"]. */
export function planParts(kind: string, target: string): [string, string] {
  const k = kindText(kind);
  if (kind === 'SECURE_SUPPLY') return [k, target.replace(/^supply /, '')];
  if (!SELF_NAMED.has(kind)) return [k, target];
  const first = `${k.split(' ')[0]} `;
  return [k, target.startsWith(first) ? target.slice(first.length) : target];
}
export function planText(kind: string, target: string): string { return planParts(kind, target).join(' '); }

/** Verb pairs for a closed plan: [succeeded, failed]. */
const VERBS: Record<string, [string, string]> = {
  CAPTURE: ['took', 'failed to take'], ATTACK: ['took', 'failed to take'], OPERATION: ['held', 'failed to hold'],
  ASSAULT_CORE: ['destroyed', 'failed to destroy'], RAID: ['destroyed', 'failed to destroy'], DEFEND: ['held', 'lost'],
  FORTIFY: ['fortified', 'failed to fortify'], SECURE_SUPPLY: ['secured supply', 'failed to secure supply'], REPAIR: ['repaired', 'failed to repair'],
  SABOTAGE: ['cut', 'failed to cut'], RECON: ['scouted', 'failed to scout'], REGROUP: ['regrouped', 'failed to regroup'],
};
export function verdictText(kind: string, target: string, ok: boolean): string {
  const v = VERBS[kind];
  return v ? `${ok ? v[0] : v[1]} ${planParts(kind, target)[1]}` : `${ok ? 'completed' : 'failed'} ${planText(kind, target)}`;
}

/** Moment kinds: short chip label and accent. */
export const MOMENT_STYLE: Record<string, [string, string]> = {
  REVENGE: ['Revenge', '#ff3d81'], CORE_DOWN: ['Core down', '#ff5d5d'], LAST_STAND: ['Last stand', '#ff6a55'], CORE_ASSAULT: ['Strike ordered', '#ff8a3d'],
  COMEBACK: ['Comeback', '#7ee2a8'], NEW_LEADER: ['New leader', '#ffd166'], UPSET: ['Upset', '#7fe7ff'], PHOTO_FINISH: ['Photo finish', '#ffd166'],
  LEAD_CHANGE: ['Lead change', '#ffd166'], PACT_BROKEN: ['Pact broken', '#ff3d81'], NOTICE: ['Notice', '#ffb547'], PACT: ['Pact', '#7ee2a8'],
  TUG_OF_WAR: ['Tug of war', '#ffb547'], RETAKE: ['Retake', '#ffb547'], CAPTURE: ['Changes hands', '#ffb547'], RIVALRY: ['Rivalry', '#ff4f9a'],
  STREAK: ['Streak', '#7ee2a8'], SLUMP: ['Slump', '#ff5d5d'], CITADEL: ['Citadel', '#ffd166'], FIRST_BLOOD: ['First blood', '#ff6a55'],
  DESCENDANT: ['Lineage', '#c08cff'],
};
export const momentStyle = (kind: string): [string, string] => MOMENT_STYLE[kind] ?? [kindText(kind), '#8a93a2'];

export const BEAT_ICON: Record<string, string> = { active: '▸', success: '✔', costly: '≈', fail: '✘', aborted: '■' };
export const BEAT_COLOR: Record<string, string> = { active: '#7fe7ff', success: '#7ee2a8', costly: '#ffd166', fail: '#ff5d5d', aborted: '#8a93a2' };

/** Frontier boundary / expansion accent: amber-orange, kept distinct from Vector's amber (#ffb547). */
export const FRONTIER_CSS = CAT_COLORS.frontier;
