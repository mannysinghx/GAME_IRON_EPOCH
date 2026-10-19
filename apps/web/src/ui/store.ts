// Spectator client store. Receives committed views from the world worker; sends spectator commands.
// Nothing here can alter an army's decisions — the worker only accepts ledger and viewing commands.

import { useEffect, useState } from 'preact/hooks';
import type { ChronEvent, ClientCmd, Dossier, FrameMsg, FrontierMsg, MapStatic, SeriesView, UiSnapshot, WorkerMsg, EvalMatch, EvalResult } from '../shared/protocol.ts';
import { DEFAULT_OVERLAYS, type CameraMode, type Overlays, type PickInfo } from '../render/api.ts';

export interface Toast { id: number; level: 'ok' | 'warn' | 'err' | 'info'; text: string; at: number }

export type BottomTab = 'chronicle' | 'analytics' | 'proving' | 'engine' | 'ledger';
export type MobileTab = 'map' | 'theatre' | 'commanders' | 'operation' | 'predict' | 'dossier' | 'chronicle';

class Store {
  ui: UiSnapshot | null = null;
  dossier: Dossier | null = null;
  map: MapStatic | null = null;
  chronicle: ChronEvent[] = [];
  series: SeriesView | null = null;
  toasts: Toast[] = [];
  ready = false;
  resumed = false;
  fps = 0;
  selected = -1;
  overlays: Overlays = { ...DEFAULT_OVERLAYS };
  camera: CameraMode = 'free';
  bottomTab: BottomTab = 'chronicle';
  mobileTab: MobileTab = 'map';
  sortBy: 'power' | 'skill' | 'merit' | 'kd' = 'power';
  collapsed: Record<string, boolean> = loadCollapsed();
  chronFilter = 'all';
  chronSearch = '';
  hover: PickInfo | null = null;
  /** Latest frontier unlock (kept so a renderer that attaches late can still apply it after setStatic). */
  frontier: FrontierMsg | null = null;
  /** Chunk indices (cy * chunksX + cx) opened by the latest unlock, diffed from the previous active mask. */
  newChunks: number[] = [];
  frontierAt = 0; // performance.now() of the latest unlock that opened chunks (drives the map flash)
  hoverListeners = new Set<() => void>();
  version = 0;
  private listeners = new Set<() => void>();
  private toastId = 1;
  worker: Worker | null = null;
  proving: Worker | null = null;
  onFrame: (f: FrameMsg) => void = () => {};
  onStatic: (m: MapStatic) => void = () => {};
  onFrontier: (f: FrontierMsg) => void = () => {};

  emit(): void { this.version++; for (const l of this.listeners) l(); }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  send(cmd: ClientCmd): void { this.worker?.postMessage(cmd); }

  setHover(p: PickInfo | null): void {
    this.hover = p;
    for (const l of this.hoverListeners) l();
  }

  toast(level: Toast['level'], text: string): void {
    const t = { id: this.toastId++, level, text, at: performance.now() };
    this.toasts = [...this.toasts.slice(-4), t];
    this.emit();
    setTimeout(() => { this.toasts = this.toasts.filter((x) => x.id !== t.id); this.emit(); }, level === 'err' ? 9000 : 4200);
  }

  select(id: number): void {
    this.selected = id;
    this.send({ type: 'select', id });
    this.emit();
  }

  setOverlays(patch: Partial<Overlays>): void {
    this.overlays = { ...this.overlays, ...patch };
    if (patch.fog !== undefined) this.send({ type: 'viewFaction', f: patch.fog });
    this.emit();
  }

  toggleSection(key: string): void {
    this.collapsed = { ...this.collapsed, [key]: !this.collapsed[key] };
    try { localStorage.setItem('ie.collapsed', JSON.stringify(this.collapsed)); } catch { /* storage may be blocked */ }
    this.emit();
  }

  start(): void {
    this.worker = new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' });
    this.proving = new Worker(new URL('../sim/proving.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerMsg>) => this.handle(ev.data);
    this.worker.onerror = (e) => this.toast('err', `World worker failed: ${e.message}`);
    this.proving.onmessage = (ev: MessageEvent<{ type: string; result?: EvalResult; message?: string }>) => {
      if (ev.data.type === 'result' && ev.data.result) this.send({ type: 'evalResult', result: ev.data.result });
    };
    this.send({ type: 'init', resume: true });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.send({ type: 'save' }); });
  }

  private applyFrontier(m: FrontierMsg): void {
    const prev = this.map;
    if (prev) {
      // diff at chunk level so panels can highlight what just opened without trusting `opened` semantics
      const ch = prev.chunk || 16, cx = Math.ceil(prev.w / ch), cy = Math.ceil(prev.h / ch);
      const fresh: number[] = [];
      for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
        const t = Math.min(prev.h - 1, j * ch + (ch >> 1)) * prev.w + Math.min(prev.w - 1, i * ch + (ch >> 1));
        if (m.active[t] && !prev.active[t]) fresh.push(j * cx + i);
      }
      if (fresh.length) { this.newChunks = fresh; this.frontierAt = performance.now(); }
      // new object, not a mutation: the renderer may still hold the previous MapStatic
      this.map = { ...prev, active: m.active, sites: m.sites };
    }
    this.frontier = m;
    this.onFrontier(m);
    this.emit();
  }

  private handle(m: WorkerMsg): void {
    switch (m.type) {
      case 'static': this.map = m.map; this.chronicle = []; this.series = null; this.frontier = null; this.newChunks = []; this.onStatic(m.map); this.emit(); break;
      case 'frontier': this.applyFrontier(m); break;
      case 'frame': this.onFrame(m); break;
      case 'ui': {
        this.ui = m.ui;
        if (m.ui.chronicle.length) {
          this.chronicle = this.chronicle.concat(m.ui.chronicle);
          if (this.chronicle.length > 1500) this.chronicle = this.chronicle.slice(-1500);
        }
        if (m.ui.series) this.series = m.ui.series;
        if (this.selected < 0) {
          const first = m.ui.commanders.find((c) => c.status === 'active');
          if (first) this.select(first.id);
        }
        this.emit();
        break;
      }
      case 'dossier': this.dossier = m.d; this.emit(); break;
      case 'toast': this.toast(m.level, m.text); break;
      case 'evalRequest': this.proving?.postMessage({ type: 'match', match: m.match as EvalMatch }); break;
      case 'ready': this.ready = true; this.resumed = m.resumed; if (m.resumed) this.toast('info', 'Resumed the persistent world from its last durable snapshot.'); this.emit(); break;
    }
  }
}

function loadCollapsed(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem('ie.collapsed') ?? '{}') as Record<string, boolean>; } catch { return {}; }
}

export const store = new Store();

export function useStore(): Store {
  const [, setV] = useState(0);
  useEffect(() => store.subscribe(() => setV((v) => v + 1)), []);
  return store;
}

export function idem(): string {
  return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

export function useHover(): void {
  const [, setV] = useState(0);
  useEffect(() => { const fn = () => setV((v) => v + 1); store.hoverListeners.add(fn); return () => { store.hoverListeners.delete(fn); }; }, []);
}
