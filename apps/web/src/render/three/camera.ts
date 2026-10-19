// Spectator camera: MapControls (left-drag pans along the ground, right-drag / modifier+left rotates yaw and
// pitch, wheel zooms toward the cursor, one-finger pan, two-finger zoom/rotate) plus eased programmatic
// goals for focus, zoom, rotate, presets and the follow / operation / director modes. Yaw is a compass
// bearing of the view direction (0 = north, i.e. looking toward -z; +pi/2 = east); pitch is the view angle
// below the horizon (pi/2 = straight down).

import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import type { CameraMode, CameraPreset, CameraState } from '../api.ts';
import { GROUND_Y, clamp, lerpAngle } from './common.ts';

export const MIN_DIST = 6, MAX_DIST = 520, MIN_POLAR = 0.02, MAX_POLAR = 1.42;
const PRESET_POLAR: Record<CameraPreset, number> = { top: 0.04, oblique: 0.8, low: 1.24 };
const DIRECTOR_MS = 7000;

export interface CameraHooks {
  follow(out: Float32Array): boolean;
  operation(out: Float32Array): boolean;
  director(out: Float32Array): boolean;
}

const _off = new THREE.Vector3();
const _sph = new THREE.Spherical();
const _p = new Float32Array(3);

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  mode: CameraMode = 'free';
  onMode: (m: CameraMode) => void = () => {};
  private gT = new THREE.Vector3(); private hasT = false;
  private gDist = 90; private hasD = false;
  private gYaw = 0; private hasYaw = false;
  private gPolar = 0.8; private hasP = false;
  private shakeOff = new THREE.Vector3();
  private lastDirector = -1e9;
  private dom: HTMLElement;
  private press = { down: false, x: 0, y: 0, pan: false, moved: false, pointers: 0 };
  private interacting = false;

  constructor(dom: HTMLElement) {
    this.dom = dom;
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.3, 2600);
    this.camera.position.set(0, 80, 80);
    const c = new MapControls(this.camera, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.085;
    c.zoomToCursor = true;
    c.screenSpacePanning = false;
    c.minDistance = MIN_DIST; c.maxDistance = MAX_DIST;
    c.minPolarAngle = MIN_POLAR; c.maxPolarAngle = MAX_POLAR;
    c.rotateSpeed = 0.55; c.zoomSpeed = 1.15; c.panSpeed = 1;
    c.maxTargetRadius = 6000;
    c.autoRotateSpeed = 0.35;
    c.target.set(0, GROUND_Y, 0);
    c.addEventListener('start', this.onStart);
    c.addEventListener('end', this.onEnd);
    this.controls = c;
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointercancel', this.onUp);
    c.update();
  }

  /** User input takes over: drop programmatic goals so the gesture is never fought. */
  private onStart = (): void => { this.interacting = true; this.hasT = false; this.hasD = false; this.hasYaw = false; this.hasP = false; };
  private onEnd = (): void => { this.interacting = false; };

  private onDown = (e: PointerEvent): void => {
    // a primary pointer starts a fresh gesture (guards against a missed pointerup skewing the count)
    this.press.pointers = e.isPrimary ? 1 : this.press.pointers + 1;
    const mods = e.ctrlKey || e.metaKey || e.shiftKey;
    // MapControls: left pans unless a modifier turns it into rotate; right rotates unless a modifier pans
    const pan = e.pointerType === 'touch' ? this.press.pointers === 1 : (e.button === 0 && !mods) || (e.button === 2 && mods);
    if (this.press.pointers === 1) { this.press.down = true; this.press.x = e.clientX; this.press.y = e.clientY; this.press.moved = false; this.press.pan = pan; }
    else this.press.pan = false;
  };
  private onMove = (e: PointerEvent): void => {
    if (!this.press.down || this.press.moved) return;
    if (Math.abs(e.clientX - this.press.x) + Math.abs(e.clientY - this.press.y) > 4) {
      this.press.moved = true;
      if (this.press.pan && this.mode !== 'free') this.setMode('free');
    }
  };
  private onUp = (): void => {
    this.press.pointers = Math.max(0, this.press.pointers - 1);
    if (this.press.pointers === 0) this.press.down = false;
  };

  /** True when the last pointer press moved enough to count as a drag (suppresses picking). */
  get dragged(): boolean { return this.press.moved; }

  setAspect(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setCursor(x: number, z: number): void { this.controls.cursor.set(x, GROUND_Y, z); }

  setMode(m: CameraMode, notify = true): void {
    const prev = this.mode;
    this.mode = m;
    this.lastDirector = -1e9;
    this.controls.autoRotate = m === 'director';
    if (m !== prev) {
      const d = this.distance;
      if (m === 'follow') { this.gDist = Math.min(d, 60); this.hasD = d > 60; }
      else if (m === 'operation') { this.gDist = 62; this.hasD = true; this.gPolar = 0.86; this.hasP = true; }
    }
    if (notify) this.onMode(m);
  }

  get distance(): number { return this.camera.position.distanceTo(this.controls.target); }

  /** Compass bearing of the view (0 = north). */
  get yaw(): number {
    _off.copy(this.camera.position).sub(this.controls.target);
    return -Math.atan2(_off.x, _off.z);
  }

  get polar(): number {
    _off.copy(this.camera.position).sub(this.controls.target);
    const r = _off.length();
    return r > 0 ? Math.acos(clamp(_off.y / r, -1, 1)) : 0;
  }

  focus(x: number, y: number, z: number, dist?: number): void {
    this.gT.set(x, y, z); this.hasT = true;
    if (dist !== undefined && dist > 0) { this.gDist = clamp(dist, MIN_DIST, MAX_DIST); this.hasD = true; }
  }

  /** Instant placement (first frame of a new world). */
  place(x: number, z: number, dist: number, polar: number, yaw: number): void {
    const t = this.controls.target;
    t.set(x, GROUND_Y, z);
    _sph.set(clamp(dist, MIN_DIST, MAX_DIST), clamp(polar, MIN_POLAR, MAX_POLAR), -yaw);
    _off.setFromSpherical(_sph);
    this.camera.position.copy(t).add(_off);
    this.hasT = this.hasD = this.hasYaw = this.hasP = false;
    this.controls.update();
  }

  zoomBy(f: number): void {
    if (!(f > 0)) return;
    this.gDist = clamp((this.hasD ? this.gDist : this.distance) / f, MIN_DIST, MAX_DIST);
    this.hasD = true;
  }

  rotateBy(dYaw: number, dPitch: number): void {
    this.gYaw = (this.hasYaw ? this.gYaw : this.yaw) + dYaw;
    this.hasYaw = true;
    if (dPitch) { this.gPolar = clamp((this.hasP ? this.gPolar : this.polar) - dPitch, MIN_POLAR, MAX_POLAR); this.hasP = true; }
  }

  panBy(dx: number, dz: number): void {
    const b = this.hasYaw ? this.gYaw : this.yaw;
    const fx = Math.sin(b), fz = -Math.cos(b), rx = Math.cos(b), rz = Math.sin(b);
    if (!this.hasT) this.gT.copy(this.controls.target);
    this.gT.x += rx * dx + fx * dz;
    this.gT.z += rz * dx + fz * dz;
    this.hasT = true;
    if (this.mode !== 'free') this.setMode('free');
  }

  resetNorth(): void { this.gYaw = 0; this.hasYaw = true; }

  preset(p: CameraPreset): void {
    this.gPolar = PRESET_POLAR[p]; this.hasP = true;
    if (p === 'low') { this.gDist = clamp(this.distance * 0.7, 12, MAX_DIST); this.hasD = true; }
  }

  /** Frames a world rectangle with the oblique pitch, keeping the yaw. */
  fit(minX: number, maxX: number, minZ: number, maxZ: number, instant = false): void {
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const ex = maxX - minX, ez = maxZ - minZ;
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const polar = PRESET_POLAR.oblique;
    const d = Math.max((ex / 2) / (t * this.camera.aspect), (ez * Math.cos(polar)) / (2 * t)) * 1.08 + 6;
    if (instant) { this.place(cx, cz, d, polar, this.yaw); return; }
    this.focus(cx, GROUND_Y, cz, d);
    this.gPolar = polar; this.hasP = true;
  }

  state(): CameraState {
    const t = this.controls.target;
    return { yaw: this.yaw, pitch: Math.PI / 2 - this.polar, distance: this.distance, x: t.x, z: t.z, mode: this.mode };
  }

  update(dtMs: number, now: number, hooks: CameraHooks, shake: number): void {
    const cam = this.camera, ctl = this.controls, t = ctl.target;
    cam.position.sub(this.shakeOff);
    this.shakeOff.set(0, 0, 0);
    if (!this.interacting) {
      if (this.mode === 'follow') { if (hooks.follow(_p)) { this.gT.set(_p[0], GROUND_Y, _p[2]); this.hasT = true; } }
      else if (this.mode === 'operation') { if (hooks.operation(_p)) { this.gT.set(_p[0], GROUND_Y, _p[2]); this.hasT = true; } }
      else if (this.mode === 'director' && now - this.lastDirector > DIRECTOR_MS) {
        this.lastDirector = now;
        if (hooks.director(_p)) {
          this.gT.set(_p[0], GROUND_Y, _p[2]); this.hasT = true;
          this.gDist = 45; this.hasD = true;
          this.gPolar = 0.98; this.hasP = true;
        }
      }
    }
    if (this.hasT || this.hasD || this.hasYaw || this.hasP) {
      const kT = 1 - Math.exp(-dtMs / 230), kD = 1 - Math.exp(-dtMs / 200), kR = 1 - Math.exp(-dtMs / 210);
      _off.copy(cam.position).sub(t);
      _sph.setFromVector3(_off);
      if (this.hasT) {
        t.lerp(this.gT, kT);
        if (t.distanceToSquared(this.gT) < 1e-4 && this.mode === 'free') this.hasT = false;
      }
      if (this.hasD) {
        _sph.radius = Math.exp(Math.log(_sph.radius) + (Math.log(this.gDist) - Math.log(_sph.radius)) * kD);
        if (Math.abs(_sph.radius - this.gDist) < 0.01) { _sph.radius = this.gDist; this.hasD = false; }
      }
      if (this.hasYaw) {
        _sph.theta = lerpAngle(_sph.theta, -this.gYaw, kR);
        let d = (-this.gYaw - _sph.theta) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
        if (Math.abs(d) < 1e-3) this.hasYaw = false;
      }
      if (this.hasP) {
        _sph.phi += (this.gPolar - _sph.phi) * kR;
        if (Math.abs(this.gPolar - _sph.phi) < 1e-3) this.hasP = false;
      }
      _sph.phi = clamp(_sph.phi, MIN_POLAR, MAX_POLAR);
      _off.setFromSpherical(_sph);
      cam.position.copy(t).add(_off);
    }
    ctl.update(dtMs / 1000);
    if (shake > 0) {
      const a = shake * this.distance * 0.012;
      this.shakeOff.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a * 0.6, (Math.random() - 0.5) * a);
      cam.position.add(this.shakeOff);
    }
    cam.updateMatrixWorld();
  }

  dispose(): void {
    this.controls.removeEventListener('start', this.onStart);
    this.controls.removeEventListener('end', this.onEnd);
    this.dom.removeEventListener('pointerdown', this.onDown);
    this.dom.removeEventListener('pointermove', this.onMove);
    this.dom.removeEventListener('pointerup', this.onUp);
    this.dom.removeEventListener('pointercancel', this.onUp);
    this.controls.dispose();
  }
}
