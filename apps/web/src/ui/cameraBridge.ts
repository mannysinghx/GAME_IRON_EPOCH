// Thin bridge so panels can steer the spectator camera without importing the renderer. Typed only to the
// BattleView contract (render/api.ts); every call is a no-op until a renderer has attached.
import type { BattleView, CameraMode, CameraPreset } from '../render/api.ts';
import { store } from './store.ts';

let r: BattleView | null = null;

export function attachRenderer(renderer: BattleView | null): void { r = renderer; }

/** Leave an automatic camera (follow / operation / director) before a manual move would be overridden. */
function toFree(): void { if (store.camera !== 'free') camera.setMode('free'); }

export const camera = {
  focusTile(tile: number, distance?: number): void { if (!r || tile < 0) return; toFree(); r.focusTile(tile, distance); },
  focusXZ(x: number, z: number): void { if (!r) return; toFree(); r.focusXZ(x, z); },
  setMode(m: CameraMode): void { r?.setCameraMode(m); if (store.camera !== m) { store.camera = m; store.emit(); } },
  /** factor > 1 moves closer. Zoom and rotation orbit the current target, so they keep follow/director modes. */
  zoomBy(f: number): void { r?.zoomBy(f); },
  /** +yaw turns the view clockwise (right); +pitch steepens toward top-down. */
  rotateBy(yawRad: number, pitchRad: number): void { r?.rotateBy(yawRad, pitchRad); },
  /** Screen-relative pan in world units: +dx right, +dz forward. */
  panBy(dx: number, dz: number): void { if (!r) return; toFree(); r.panBy(dx, dz); },
  resetNorth(): void { r?.resetNorth(); },
  setPreset(p: CameraPreset): void { r?.setPreset(p); },
  fit(): void { if (!r) return; toFree(); r.fit(); },
  renderer(): BattleView | null { return r && r.ready ? r : null; },
};
