// HTML labels projected over the canvas: site names ("lbl lbl-site", coloured by owner) and commander core
// names ("lbl lbl-core", larger). Elements are pooled per site/core and only restyled when their screen
// position, opacity or colour actually changes, so a static camera touches no DOM. As in the 2D renderer the
// labels stay above the fog view (they name known places), but they fade back on tiles the viewer cannot see.

import * as THREE from 'three';
import { S } from '../../shared/config.ts';
import type { SiteInfo } from '../../shared/protocol.ts';
import type { IntentOverlay } from '../api.ts';
import { INTENT_FRESH_MS, cssHex, factionHex, mixHex, type Theatre } from './common.ts';
import type { StructVis } from './structures.ts';

interface Label {
  el: HTMLDivElement; x: number; y: number; z: number; tile: number; core: boolean; text: string; color: string;
  sx: number; sy: number; op: number; shown: boolean; far: number; fade: number; seen: number;
  /** extra opacity factor (fresh-intent fade); 0 hides the label */
  extra: number; intent?: boolean;
}

const FONT = "'Chakra Petch', 'Inter', system-ui, sans-serif";
const SHADOW = '0 0 2px #05070a, 0 1px 2px #05070a, 0 0 6px rgba(5,7,10,0.9), 0 0 12px rgba(5,7,10,0.6)';
const _v = new THREE.Vector3();
/** Label opacity by fog value (unseen, remembered, visible). */
const FOG_OP = [0.4, 0.7, 1];

export class LabelLayer {
  readonly root: HTMLDivElement;
  private sites = new Map<number, Label>();
  private cores = new Map<number, Label>();
  private intents = new Map<number, Label>(); // by commander id
  private th: Theatre | null = null;
  private seen = 0;
  private flat: Label[] = []; // iteration copy, rebuilt only when membership changes
  private dirty = true;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'lbl-layer';
    const st = this.root.style;
    st.position = 'absolute'; st.left = '0'; st.top = '0'; st.right = '0'; st.bottom = '0';
    st.pointerEvents = 'none'; st.overflow = 'hidden'; st.userSelect = 'none'; st.zIndex = '1';
    host.appendChild(this.root);
  }

  private make(core: boolean, big: boolean): HTMLDivElement {
    const el = document.createElement('div');
    el.className = core ? 'lbl lbl-core' : 'lbl lbl-site';
    const s = el.style;
    s.position = 'absolute'; s.left = '0'; s.top = '0'; s.whiteSpace = 'nowrap'; s.pointerEvents = 'none';
    s.fontFamily = FONT; s.textShadow = SHADOW; s.willChange = 'transform, opacity'; s.lineHeight = '1';
    s.display = 'none';
    if (core) {
      s.fontSize = '12.5px'; s.fontWeight = '700'; s.letterSpacing = '0.16em'; s.textTransform = 'uppercase';
      s.padding = '0 0 3px'; s.borderBottom = '1px solid currentColor';
    } else {
      s.fontSize = big ? '12px' : '10.5px'; s.fontWeight = '600'; s.letterSpacing = '0.12em';
      s.fontVariant = 'small-caps'; s.fontVariantCaps = 'all-small-caps';
    }
    this.root.appendChild(el);
    return el;
  }

  setTheatre(th: Theatre): void {
    this.th = th;
    for (const l of this.sites.values()) l.el.remove();
    for (const l of this.cores.values()) l.el.remove();
    for (const l of this.intents.values()) l.el.remove();
    this.sites.clear(); this.cores.clear(); this.intents.clear();
    this.dirty = true;
  }

  setSites(sites: SiteInfo[]): void {
    const th = this.th;
    if (!th) return;
    const keep = new Set<number>();
    for (const s of sites) {
      if (s.kind === S.BRIDGE || s.tile < 0 || s.tile >= th.n) continue;
      keep.add(s.id);
      let l = this.sites.get(s.id);
      if (!l) {
        const big = s.kind === S.CITADEL;
        l = { el: this.make(false, big), x: th.x[s.tile], y: th.walk[s.tile], z: th.z[s.tile], tile: s.tile, core: false, text: '', color: '', sx: -1, sy: -1, op: -1, shown: false, far: big ? 190 : 135, fade: 40, seen: 0, extra: 1 };
        l.el.style.color = '#aab3c0';
        l.color = '#aab3c0';
        this.sites.set(s.id, l);
        this.dirty = true;
      }
      if (l.text !== s.name) { l.text = s.name; l.el.textContent = s.name; }
    }
    for (const [id, l] of this.sites) if (!keep.has(id)) { l.el.remove(); this.sites.delete(id); this.dirty = true; }
  }

  /** Colours site labels by current owner and keeps one label per command core (20 Hz, not per frame). */
  syncStructs(list: StructVis[], names: Map<number, { name: string; faction: number; status: string }>): void {
    const th = this.th;
    if (!th) return;
    const seen = ++this.seen;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const site = this.sites.get(s.id);
      if (site) {
        const c = s.faction >= 0 ? cssHex(mixHex(factionHex(s.faction), 0xffffff, 0.35)) : '#aab3c0';
        if (c !== site.color) { site.color = c; site.el.style.color = c; }
      }
      if (s.kind !== S.CORE) continue;
      let l = this.cores.get(s.id);
      if (!l) {
        l = { el: this.make(true, true), x: s.x, y: s.y + 2.55, z: s.z, tile: s.tile, core: true, text: '', color: '', sx: -1, sy: -1, op: -1, shown: false, far: 430, fade: 70, seen, extra: 1 };
        this.cores.set(s.id, l);
        this.dirty = true;
      }
      l.seen = seen;
      const name = (names.get(s.owner)?.name ?? 'Core').toUpperCase();
      if (name !== l.text) { l.text = name; l.el.textContent = name; }
      const c = cssHex(mixHex(factionHex(s.faction), 0xffffff, 0.25));
      if (c !== l.color) { l.color = c; l.el.style.color = c; }
    }
    for (const [id, l] of this.cores) if (l.seen !== seen) { l.el.remove(); this.cores.delete(id); this.dirty = true; }
  }

  /**
   * Fresh announcements get a "NAME ▸ PLAN" chip over their target for INTENT_FRESH_MS, fading out; older intents
   * keep only their ground ring. One pooled element per commander.
   */
  setIntents(list: IntentOverlay[], age: (owner: number, now: number) => number, now: number): void {
    const th = this.th;
    if (!th) return;
    const keep = new Set<number>();
    for (const it of list) {
      if (it.tile < 0 || it.tile >= th.n) continue;
      const a = age(it.owner, now);
      if (a < 0 || a >= INTENT_FRESH_MS) continue;
      keep.add(it.owner);
      let l = this.intents.get(it.owner);
      if (!l) {
        const el = this.make(false, false);
        const s = el.style;
        s.fontSize = '10.5px'; s.fontWeight = '700'; s.letterSpacing = '0.1em'; s.textTransform = 'uppercase'; s.fontVariant = 'normal';
        s.fontVariantCaps = 'normal'; s.padding = '2px 6px'; s.borderRadius = '3px'; s.border = '1px solid currentColor'; s.background = 'rgba(5,7,10,0.62)';
        l = { el, x: 0, y: 0, z: 0, tile: -1, core: false, text: '', color: '', sx: -1, sy: -1, op: -1, shown: false, far: 300, fade: 70, seen: 0, extra: 0, intent: true };
        this.intents.set(it.owner, l);
        this.dirty = true;
      }
      if (l.tile !== it.tile) { l.tile = it.tile; l.x = th.x[it.tile]; l.y = th.walk[it.tile] + 0.9; l.z = th.z[it.tile]; l.sx = -1e9; }
      const text = `${it.name} ▸ ${it.kind.replace('_', ' ')}`;
      if (text !== l.text) { l.text = text; l.el.textContent = text; }
      const c = cssHex(mixHex(factionHex(it.faction), 0xffffff, 0.3));
      if (c !== l.color) { l.color = c; l.el.style.color = c; }
      l.extra = Math.min(1, (1 - a / INTENT_FRESH_MS) * 2.2); // full for the first half, then fades
    }
    for (const [id, l] of this.intents) if (!keep.has(id)) { l.el.remove(); this.intents.delete(id); this.dirty = true; }
  }

  /** fog: the fog view (0 unseen, 1 remembered, 2 visible) or null. */
  update(camera: THREE.PerspectiveCamera, w: number, h: number, on: boolean, fog: Uint8Array | null): void {
    if (this.dirty) {
      this.flat.length = 0;
      for (const l of this.sites.values()) this.flat.push(l);
      for (const l of this.cores.values()) this.flat.push(l);
      for (const l of this.intents.values()) this.flat.push(l);
      this.dirty = false;
    }
    const f = this.flat;
    const fv = fog && this.th && fog.length === this.th.n ? fog : null;
    for (let i = 0; i < f.length; i++) this.place(f[i], camera, w, h, on, fv ? FOG_OP[fv[f[i].tile]] ?? 1 : 1);
  }

  private place(l: Label, cam: THREE.PerspectiveCamera, w: number, h: number, on: boolean, fogK: number): void {
    let show = on;
    let op = 0, sx = 0, sy = 0;
    if (show) {
      const dx = l.x - cam.position.x, dy = l.y - cam.position.y, dz = l.z - cam.position.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      op = Math.min(1, (l.far - d) / l.fade) * fogK * l.extra;
      if (op <= 0.02) show = false;
      else {
        _v.set(l.x, l.y, l.z).project(cam);
        if (_v.z > 1 || _v.z < -1) show = false;
        else {
          sx = (_v.x + 1) * 0.5 * w; sy = (1 - _v.y) * 0.5 * h;
          if (sx < -120 || sx > w + 120 || sy < -40 || sy > h + 40) show = false;
        }
      }
    }
    if (!show) {
      if (l.shown) { l.el.style.display = 'none'; l.shown = false; }
      return;
    }
    if (!l.shown) { l.el.style.display = 'block'; l.shown = true; l.sx = -1e9; }
    const rx = Math.round(sx * 2) / 2, ry = Math.round(sy * 2) / 2;
    if (rx !== l.sx || ry !== l.sy) {
      l.sx = rx; l.sy = ry;
      l.el.style.transform = l.core || l.intent
        ? `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -100%)`
        : `translate3d(${rx}px, ${ry}px, 0) translate(-50%, 13px)`;
    }
    const o = Math.round(op * (l.core || l.intent ? 1 : 0.9) * 50) / 50;
    if (o !== l.op) { l.op = o; l.el.style.opacity = String(o); }
  }

  dispose(): void { this.root.remove(); this.sites.clear(); this.cores.clear(); this.intents.clear(); }
}
