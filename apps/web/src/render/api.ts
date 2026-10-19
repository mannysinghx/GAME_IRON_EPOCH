// Contract between the spectator UI and the 3D battlefield renderer. The UI only talks to the renderer
// through this interface; the renderer only consumes committed frames and never feeds the simulation.

import type { FrameMsg, MapStatic, SiteInfo } from '../shared/protocol.ts';

export interface Overlays {
  territory: boolean; fronts: boolean; supply: boolean; fog: number; plans: boolean; intents: boolean; danger: boolean;
  labels: boolean; weather: boolean; bloom: boolean; shadows: boolean;
}

export const DEFAULT_OVERLAYS: Overlays = {
  territory: true, fronts: true, supply: false, fog: -1, plans: true, intents: true, danger: false, labels: true, weather: true, bloom: true, shadows: true,
};

/** Every active commander's announced plan target (public story layer). `id` is the decision id. */
export interface IntentOverlay { id: string; owner: number; faction: number; tile: number; kind: string; name: string }

/** Director candidates from the story layer, best first (moment id, tile, freshness-weighted score). */
export interface FocusPoint { id: number; tile: number; score: number }

export type CameraMode = 'free' | 'follow' | 'operation' | 'director';
export type CameraPreset = 'top' | 'oblique' | 'low';

export interface PickInfo {
  kind: 'unit' | 'struct' | 'tile' | 'none';
  id: number; owner: number; faction: number; tile: number; cls: number; structKind: number;
  hp: number; supply: number; morale: number; flags: number; screenX: number; screenY: number;
}

export interface PlanOverlay {
  owner: number; faction: number; target: number; group: number[];
  candidates: { tile: number; score: number; chosen: boolean }[]; danger: { tile: number; conf: number }[];
}

export interface CameraState { yaw: number; pitch: number; distance: number; x: number; z: number; mode: CameraMode }

export interface MinimapData {
  w: number; h: number;
  terrain: Uint8Array; territory: Int8Array; active: Uint8Array;
  structs: { tile: number; kind: number; faction: number }[];
  units: { x: number; z: number; faction: number }[];
  opCenter: number; opRadius: number;
  battles: { tile: number; intensity: number }[];
}

/**
 * World coordinates (shared by renderer and minimap): hex circumradius 1, pointy-top odd-r layout,
 * x = sqrt(3) * (col + 0.5 * parity(row)), z = 1.5 * row, y is up. Land outside the theatre continues forever.
 */
export interface BattleView {
  readonly ready: boolean;
  init(host: HTMLElement): Promise<void>;
  setStatic(map: MapStatic): void;
  setFrontier(active: Uint8Array, sites: SiteInfo[], opened: number[]): void;
  applyFrame(f: FrameMsg): void;
  setOverlays(o: Overlays): void;

  // spectator state pushed by the UI
  selectedOwner: number;
  selectedUnit: number;
  plan: PlanOverlay | null;
  speed: number;
  commanderNames: Map<number, { name: string; faction: number; status: string }>;
  opInfo: { code: string; status: string; center: number; radius: number } | null;
  battles: { tile: number; intensity: number }[];
  intents: IntentOverlay[];
  focus: FocusPoint[];

  // callbacks
  onPick: (p: PickInfo) => void;
  onHover: (p: PickInfo | null) => void;
  onFps: (fps: number) => void;
  onCameraMode: (m: CameraMode) => void;

  // free 3D camera: pan anywhere, zoom, yaw, pitch
  setCameraMode(m: CameraMode): void;
  focusTile(tile: number, distance?: number): void;
  focusXZ(x: number, z: number): void;
  zoomBy(factor: number): void;
  rotateBy(yawRad: number, pitchRad: number): void;
  panBy(dx: number, dz: number): void; // screen-relative: +dx right, +dz forward, in world units
  resetNorth(): void;
  setPreset(p: CameraPreset): void;
  fit(): void;
  getCameraState(): CameraState;

  // minimap support
  tileXZ(tile: number): [number, number];
  theatreBounds(): { minX: number; maxX: number; minZ: number; maxZ: number };
  viewFootprint(): [number, number][]; // ground-plane polygon of the current view (x, z), clockwise
  minimapData(): MinimapData;
  hostRect(): DOMRect;
  dispose(): void;
}
