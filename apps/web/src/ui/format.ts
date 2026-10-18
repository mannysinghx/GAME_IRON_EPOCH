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
  team: '#5aa9ff', policy: '#9aa7ff', eval: '#b8c2d0', chapter: '#e6ebf2', build: '#8fd3c0',
};
