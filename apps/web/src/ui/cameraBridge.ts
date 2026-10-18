// Thin bridge so panels can steer the spectator camera without importing the renderer.
import type { BattleRenderer, CameraMode } from '../render/renderer.ts';
import { store } from './store.ts';

let r: BattleRenderer | null = null;

export function attachRenderer(renderer: BattleRenderer): void { r = renderer; }

export const camera = {
  focusTile(tile: number, zoom?: number): void { if (!r) return; if (r.cam.mode !== 'free') this.setMode('free'); r.focusTile(tile, zoom); },
  setMode(m: CameraMode): void { r?.setCameraMode(m); store.camera = m; store.emit(); },
  zoomBy(f: number): void { r?.zoomBy(f); },
  fit(): void {
    if (!r) return;
    r.setCameraMode('free');
    store.camera = 'free';
    r.cam.tx = r.worldW / 2; r.cam.ty = r.worldH / 2;
    r.cam.tz = Math.max(0.3, Math.min(r.host.clientWidth / r.worldW, r.host.clientHeight / r.worldH) * 1.02);
    store.emit();
  },
  renderer(): BattleRenderer | null { return r; },
};
