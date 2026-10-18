// 2.5D battlefield renderer (PixiJS, WebGL preferred). Charcoal terrain, restrained faction colours,
// bright front lines, short tracers, geometric vehicles (design doc §2.4). Rendering never feeds back
// into the simulation; it only consumes committed frames.

import { Application, Container, Graphics, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import { FACTIONS, S, STRUCTS, T, U } from '../shared/config.ts';
import { ELEV_PX, HEX_SIZE, HEX_W, ROW_H, TILT, HexGrid, hexCorners, tileCX, tileCY } from '../shared/hex.ts';
import { FX, FX_STRIDE, SF, STRUCT_ID_BASE, STRUCT_STRIDE, UF, UNIT_STRIDE, type FrameMsg, type MapStatic } from '../shared/protocol.ts';
import { NEUTRAL, buildTextures, factionColor, mix, shade, type TextureBank } from './gfx.ts';

const DIR_EDGE = [1, 0, 5, 4, 3, 2];

export interface Overlays {
  territory: boolean; fronts: boolean; supply: boolean; fog: number; plans: boolean; danger: boolean; labels: boolean; weather: boolean;
}

export type CameraMode = 'free' | 'follow' | 'operation' | 'director';

export interface PickInfo {
  kind: 'unit' | 'struct' | 'tile' | 'none';
  id: number; owner: number; faction: number; tile: number; cls: number; structKind: number;
  hp: number; supply: number; morale: number; flags: number; screenX: number; screenY: number;
}

export interface PlanOverlay {
  owner: number; faction: number; target: number; group: number[]; candidates: { tile: number; score: number; chosen: boolean }[]; danger: { tile: number; conf: number }[];
}

interface UnitVis {
  id: number; cont: Container; body: Sprite; shadow: Sprite; hpBg: Sprite; hpFg: Sprite; sup: Sprite; mark: Graphics;
  x: number; y: number; tx: number; ty: number; heading: number; cls: number; faction: number; owner: number; key: string;
  hp: number; supply: number; morale: number; flags: number; target: number; tile: number; seen: number; markKey: string;
}

interface StructVis {
  id: number; cont: Container; g: Graphics; anim: Graphics; key: string; kind: number; tile: number; x: number; y: number;
  faction: number; owner: number; flags: number; hp: number; build: number; seen: number; phase: number;
}

interface Tracer { x0: number; y0: number; x1: number; y1: number; t0: number; dur: number; color: number; width: number; len: number }
interface Shell { x0: number; y0: number; x1: number; y1: number; t0: number; dur: number; color: number; tile: number }
interface Ring { x: number; y: number; t0: number; dur: number; r0: number; r1: number; color: number; width: number; alpha: number; hex?: boolean }
interface Particle { s: Sprite; vx: number; vy: number; life: number; max: number; s0: number; s1: number; a0: number; grav: number; drag: number; active: boolean }

export class BattleRenderer {
  app = new Application();
  host: HTMLElement;
  grid!: HexGrid;
  map!: MapStatic;
  tex!: TextureBank;
  px = new Float32Array(0);
  py = new Float32Array(0);
  worldW = 0;
  worldH = 0;

  world = new Container();
  terrainG = new Graphics();
  decorG = new Graphics();
  waterG = new Graphics();
  territoryG = new Graphics();
  frontGlowG = new Graphics();
  frontG = new Graphics();
  supplyG = new Graphics();
  opG = new Graphics();
  decalLayer = new Container();
  structLayer = new Container();
  unitLayer = new Container();
  fxAdd = new Container();
  fxNormal = new Container();
  tracerG = new Graphics();
  ringG = new Graphics();
  weatherLayer = new Container();
  fogG = new Graphics();
  planG = new Graphics();
  labelLayer = new Container();

  units = new Map<number, UnitVis>();
  structs = new Map<number, StructVis>();
  tracers: Tracer[] = [];
  shells: Shell[] = [];
  rings: Ring[] = [];
  particles: Particle[] = [];
  decals: { s: Sprite; t0: number; life: number }[] = [];
  labels = new Map<number, Text>();
  labelFaction = new Map<number, number>();
  lastTerritoryBuild = 0;
  coreLabels = new Map<number, Text>();
  clouds: { s: Sprite; storm: number; ang: number; rad: number; spd: number }[] = [];
  lightning: { pts: number[]; t0: number }[] = [];

  territory: Int8Array = new Int8Array(0);
  owner: Int16Array = new Int16Array(0);
  supply: Uint8Array = new Uint8Array(0);
  fog: Uint8Array | null = null;
  ghosts: Float32Array | null = null;
  opRegion: Int32Array | null = null;
  opEdges: number[] = [];
  storms: { tile: number; radius: number }[] = [];
  territoryDirty = false;
  supplyDirty = false;
  fogDirty = false;
  lastFogBuild = 0;

  overlays: Overlays = { territory: true, fronts: true, supply: false, fog: -1, plans: true, danger: false, labels: true, weather: true };
  speed = 2;
  selectedOwner = -1;
  selectedUnit = -1;
  plan: PlanOverlay | null = null;
  commanderNames = new Map<number, { name: string; faction: number; status: string }>();
  opInfo: { code: string; status: string; center: number } | null = null;
  battles: { tile: number; intensity: number }[] = [];

  cam = { x: 0, y: 0, zoom: 0.8, tx: 0, ty: 0, tz: 0.8, mode: 'free' as CameraMode, shake: 0, lastDirector: 0 };
  frameNo = 0;
  lastFrameAt = 0;
  ready = false;
  onFps: (fps: number) => void = () => {};
  private fpsAcc = 0;
  private fpsN = 0;
  private dragging = false;
  private dragMoved = false;
  private lastPointer = { x: 0, y: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  onPick: (p: PickInfo) => void = () => {};
  onHover: (p: PickInfo | null) => void = () => {};
  onCameraMode: (m: CameraMode) => void = () => {};
  private hoverAt = 0;

  constructor(host: HTMLElement) { this.host = host; }

  async init(): Promise<void> {
    await this.app.init({
      resizeTo: this.host, background: 0x07090c, antialias: true, preference: 'webgl',
      resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true, powerPreference: 'high-performance',
    });
    this.host.appendChild(this.app.canvas);
    this.app.stage.eventMode = 'none';
    this.tex = buildTextures(this.app.renderer);
    this.fxAdd.blendMode = 'add';
    this.frontGlowG.blendMode = 'add';
    this.tracerG.blendMode = 'add';
    this.unitLayer.sortableChildren = true;
    this.world.addChild(
      this.terrainG, this.waterG, this.decorG, this.territoryG, this.supplyG, this.frontGlowG, this.frontG, this.opG, this.decalLayer,
      this.structLayer, this.unitLayer, this.fxNormal, this.ringG, this.tracerG, this.fxAdd, this.weatherLayer, this.fogG, this.planG, this.labelLayer,
    );
    this.app.stage.addChild(this.world);
    this.app.ticker.add((t) => this.animate(t.deltaMS));
    this.bindInput();
    for (let i = 0; i < 900; i++) {
      const s = new Sprite(this.tex.glow);
      s.anchor.set(0.5);
      s.visible = false;
      this.particles.push({ s, vx: 0, vy: 0, life: 0, max: 1, s0: 1, s1: 1, a0: 1, grav: 0, drag: 1, active: false });
    }
  }

  // ------------------------------------------------------------------ static map
  setStatic(map: MapStatic): void {
    this.map = map;
    this.grid = new HexGrid(map.w, map.h);
    const n = this.grid.n;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      const c = this.grid.col(t), r = this.grid.row(t);
      this.px[t] = tileCX(c, r);
      this.py[t] = tileCY(r) - map.elev[t] * ELEV_PX;
    }
    this.worldW = HEX_W * (map.w + 1);
    this.worldH = ROW_H * map.h + HEX_SIZE * 2;
    this.territory = new Int8Array(n).fill(-1);
    this.owner = new Int16Array(n).fill(-1);
    this.supply = new Uint8Array(n);
    for (const u of this.units.values()) u.cont.destroy({ children: true });
    for (const s of this.structs.values()) s.cont.destroy({ children: true });
    this.units.clear();
    this.structs.clear();
    for (const l of this.labels.values()) l.destroy();
    this.labelFaction.clear();
    for (const l of this.coreLabels.values()) l.destroy();
    this.labels.clear();
    this.coreLabels.clear();
    this.opRegion = null;
    this.opEdges = [];
    this.buildTerrain();
    this.buildLabels();
    this.ready = true;
    const fitZoom = Math.min(this.host.clientWidth / this.worldW, this.host.clientHeight / this.worldH);
    this.cam.x = this.cam.tx = this.worldW / 2;
    this.cam.y = this.cam.ty = this.worldH / 2;
    this.cam.zoom = this.cam.tz = Math.max(0.35, fitZoom * 1.02);
  }

  private buildTerrain(): void {
    const { map, grid } = this;
    const g = this.terrainG, d = this.decorG;
    g.clear(); d.clear();
    const base = (t: number) => {
      const tt = map.terrain[t];
      const v = (map.variant[t] - 128) / 128;
      let col: number;
      switch (tt) {
        case T.PLAINS: col = mix(0x2a3038, 0x2f3a33, (map.variant[t] & 7) / 22); break;
        case T.FOREST: col = 0x1e2a25; break;
        case T.RIDGE: col = 0x3a3e46; break;
        case T.RUIN: col = 0x34302c; break;
        case T.MARSH: col = 0x223033; break;
        case T.ROAD: col = 0x2d3239; break;
        case T.RIVER: col = 0x10283e; break;
        case T.CROSSING: col = 0x10283e; break;
        default: col = 0x2a3038;
      }
      return shade(col, 1 + v * 0.06 + map.elev[t] * 0.05);
    };
    for (let r = 0; r < map.h; r++) {
      for (let c = 0; c < map.w; c++) {
        const t = r * map.w + c;
        const cx = this.px[t], cy = this.py[t];
        const pts = hexCorners(cx, cy);
        const top = base(t);
        const wall = map.elev[t] * ELEV_PX + 4;
        // front walls (SE then SW) for 2.5D extrusion
        g.poly([pts[4], pts[5], pts[6], pts[7], pts[6], pts[7] + wall, pts[4], pts[5] + wall]).fill(shade(top, 0.5));
        g.poly([pts[6], pts[7], pts[8], pts[9], pts[8], pts[9] + wall, pts[6], pts[7] + wall]).fill(shade(top, 0.38));
        g.poly(pts).fill(top);
        // bevel light from the north, hairline outline
        g.moveTo(pts[10], pts[11]).lineTo(pts[0], pts[1]).lineTo(pts[2], pts[3]).stroke({ width: 1, color: 0xffffff, alpha: map.terrain[t] === T.RIVER ? 0.02 : 0.06 });
        g.poly(pts).stroke({ width: 0.6, color: 0x000000, alpha: 0.28 });
        this.decorate(d, t, cx, cy);
      }
    }
    // roads: connect road-like tiles centre to centre
    const roadish = (t: number) => map.terrain[t] === T.ROAD || map.terrain[t] === T.CROSSING;
    for (let t = 0; t < grid.n; t++) {
      if (map.terrain[t] !== T.ROAD) continue;
      for (let k = 0; k < 3; k++) {
        const v = grid.nb[t * 6 + [0, 4, 5][k]];
        if (v < 0 || !roadish(v)) continue;
        d.moveTo(this.px[t], this.py[t]).lineTo(this.px[v], this.py[v]).stroke({ width: 5.5, color: 0x1b1f25, alpha: 0.9, cap: 'round' });
      }
    }
    for (let t = 0; t < grid.n; t++) {
      if (map.terrain[t] !== T.ROAD) continue;
      for (let k = 0; k < 3; k++) {
        const v = grid.nb[t * 6 + [0, 4, 5][k]];
        if (v < 0 || !roadish(v)) continue;
        d.moveTo(this.px[t], this.py[t]).lineTo(this.px[v], this.py[v]).stroke({ width: 3.6, color: 0x444a54, alpha: 0.95, cap: 'round' });
        d.moveTo(this.px[t], this.py[t]).lineTo(this.px[v], this.py[v]).stroke({ width: 0.7, color: 0x9aa3b0, alpha: 0.18, cap: 'round' });
      }
    }
  }

  private decorate(d: Graphics, t: number, cx: number, cy: number): void {
    const v = this.map.variant[t];
    const rnd = (k: number) => (((v * 2654435761 + k * 40503) >>> 0) % 1000) / 1000;
    switch (this.map.terrain[t]) {
      case T.FOREST: {
        const n = 3 + (v % 3);
        for (let i = 0; i < n; i++) {
          const x = cx + (rnd(i) - 0.5) * 20, y = cy + (rnd(i + 9) - 0.5) * 12;
          const h = 6 + rnd(i + 3) * 4;
          d.ellipse(x, y + 1.5, 3.6, 1.6).fill({ color: 0x000000, alpha: 0.35 });
          d.poly([x, y - h, x - 3.8, y + 1, x + 3.8, y + 1]).fill(0x1f3d2c);
          d.poly([x, y - h, x + 3.8, y + 1, x + 0.6, y + 1]).fill(0x2a5039);
        }
        break;
      }
      case T.RIDGE: {
        for (let i = 0; i < 3; i++) {
          const x = cx + (rnd(i) - 0.5) * 18, y = cy + (rnd(i + 5) - 0.5) * 10;
          const s = 3 + rnd(i + 2) * 3;
          d.poly([x - s, y + s * 0.5, x, y - s, x + s * 1.1, y + s * 0.5]).fill(0x4a4f58);
          d.poly([x, y - s, x + s * 1.1, y + s * 0.5, x + s * 0.2, y + s * 0.5]).fill(0x5a606a);
        }
        break;
      }
      case T.RUIN: {
        for (let i = 0; i < 3; i++) {
          const x = cx + (rnd(i) - 0.5) * 18, y = cy + (rnd(i + 4) - 0.5) * 10;
          const w = 3 + rnd(i + 1) * 5, h = 2 + rnd(i + 7) * 5;
          d.rect(x - w / 2, y - h, w, h).fill(0x4a443e);
          d.rect(x - w / 2, y - h, w, 1.2).fill(0x5d564e);
          if (rnd(i + 11) > 0.82) d.circle(x, y - h - 1, 0.9).fill({ color: 0xff9b4a, alpha: 0.85 });
        }
        break;
      }
      case T.MARSH: {
        for (let i = 0; i < 4; i++) {
          const x = cx + (rnd(i) - 0.5) * 20, y = cy + (rnd(i + 5) - 0.5) * 12;
          d.moveTo(x, y).lineTo(x + 0.6, y - 3.5).stroke({ width: 0.8, color: 0x3f5b4f, alpha: 0.8 });
        }
        d.ellipse(cx + (rnd(20) - 0.5) * 8, cy + (rnd(21) - 0.5) * 6, 4, 1.6).fill({ color: 0x173246, alpha: 0.8 });
        break;
      }
      case T.PLAINS: {
        if (v % 3 === 0) for (let i = 0; i < 3; i++) {
          const x = cx + (rnd(i) - 0.5) * 22, y = cy + (rnd(i + 6) - 0.5) * 14;
          d.moveTo(x, y).lineTo(x + 0.4, y - 2).stroke({ width: 0.7, color: 0x56604f, alpha: 0.5 });
        }
        break;
      }
    }
  }

  private buildLabels(): void {
    for (const s of this.map.sites) {
      if (s.kind === S.BRIDGE) continue;
      const style = new TextStyle({ fontFamily: 'Chakra Petch, Inter, sans-serif', fontSize: s.kind === S.CITADEL ? 13 : 11, fontWeight: '600', fill: 0xaab3c0, letterSpacing: 0.8, stroke: { color: 0x05070a, width: 3 } });
      const t = new Text({ text: s.name.toUpperCase(), style, resolution: 2 });
      t.anchor.set(0.5, 0);
      t.position.set(this.px[s.tile], this.py[s.tile] + 11);
      t.alpha = 0.85;
      this.labelLayer.addChild(t);
      this.labels.set(s.id, t);
    }
  }

  // ------------------------------------------------------------------ frames
  applyFrame(f: FrameMsg): void {
    if (!this.ready) return;
    this.frameNo++;
    const now = performance.now();
    this.lastFrameAt = now;
    if (f.territory) { this.territory = f.territory; this.territoryDirty = true; }
    if (f.owner) { this.owner = f.owner; this.territoryDirty = true; }
    if (f.supply) { this.supply = f.supply; this.supplyDirty = true; }
    if (f.fog) { this.fog = f.fog; this.ghosts = f.ghosts ?? null; this.fogDirty = true; } else if (this.overlays.fog < 0 && this.fog) { this.fog = null; this.fogDirty = true; }
    if (f.opRegion !== undefined) this.setOpRegion(f.opRegion);
    if (f.storms) this.setStorms(f.storms);
    this.applyStructs(f.structs);
    this.applyUnits(f.units);
    this.applyFx(f.fx, now);
  }

  private tileCount = new Map<number, number>();

  private applyUnits(a: Float32Array): void {
    const seen = this.frameNo;
    this.tileCount.clear();
    const n = a.length / UNIT_STRIDE;
    for (let i = 0; i < n; i++) {
      const tile = a[i * UNIT_STRIDE + 4], next = a[i * UNIT_STRIDE + 5];
      const key = next >= 0 && a[i * UNIT_STRIDE + 6] > 0.5 ? next : tile;
      this.tileCount.set(key, (this.tileCount.get(key) ?? 0) + 1);
    }
    const slot = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const o = i * UNIT_STRIDE;
      const id = a[o], cls = a[o + 1], faction = a[o + 2], owner = a[o + 3], tile = a[o + 4], next = a[o + 5], t = a[o + 6];
      let u = this.units.get(id);
      const hp = a[o + 7];
      const soldiers = cls === U.RIFLE ? Math.max(1, Math.min(5, Math.ceil(hp * 5))) : 0;
      const key = `${cls}:${faction}:${soldiers}`;
      if (!u) {
        u = this.makeUnit(id, cls, faction, key);
        const [sx, sy] = this.unitPos(tile, next, t);
        u.x = u.tx = sx; u.y = u.ty = sy;
      }
      if (u.key !== key) { u.body.texture = this.tex.unit.get(key) ?? Texture.WHITE; u.key = key; }
      let [x, y] = this.unitPos(tile, next, t);
      const occ = next >= 0 && t > 0.5 ? next : tile;
      const cnt = this.tileCount.get(occ) ?? 1;
      if (cnt > 1) {
        const k = slot.get(occ) ?? 0;
        slot.set(occ, k + 1);
        const ang = (k / cnt) * Math.PI * 2 + 0.6;
        x += Math.cos(ang) * 7; y += Math.sin(ang) * 7 * TILT;
      }
      if (next >= 0) {
        const hx = this.px[next] - this.px[tile], hy = this.py[next] - this.py[tile];
        if (hx || hy) u.heading = Math.atan2(hy, hx);
      }
      u.tx = x; u.ty = y; u.cls = cls; u.faction = faction; u.owner = owner; u.tile = tile;
      u.hp = hp; u.supply = a[o + 8]; u.morale = a[o + 9]; u.flags = a[o + 10]; u.target = a[o + 11];
      u.seen = seen;
    }
    for (const [id, u] of this.units) {
      if (u.seen !== seen) { u.cont.destroy({ children: true }); this.units.delete(id); }
    }
  }

  private unitPos(tile: number, next: number, t: number): [number, number] {
    if (next < 0 || next >= this.px.length) return [this.px[tile], this.py[tile]];
    return [this.px[tile] + (this.px[next] - this.px[tile]) * t, this.py[tile] + (this.py[next] - this.py[tile]) * t];
  }

  private makeUnit(id: number, cls: number, faction: number, key: string): UnitVis {
    const cont = new Container();
    const shadow = new Sprite(this.tex.shadow); shadow.anchor.set(0.5); shadow.scale.set(cls === U.WALKER ? 1.25 : cls === U.SCOUT ? 0.75 : 0.95); shadow.position.set(0, 4);
    const body = new Sprite(this.tex.unit.get(key) ?? Texture.WHITE); body.anchor.set(0.5); body.scale.set(cls === U.WALKER ? 1.15 : 1);
    const hpBg = new Sprite(Texture.WHITE); hpBg.tint = 0x05070a; hpBg.width = 14; hpBg.height = 2.4; hpBg.anchor.set(0.5); hpBg.position.set(0, -10); hpBg.alpha = 0.85;
    const hpFg = new Sprite(Texture.WHITE); hpFg.anchor.set(0, 0.5); hpFg.height = 1.4; hpFg.position.set(-6.5, -10);
    const sup = new Sprite(Texture.WHITE); sup.anchor.set(0.5); sup.width = 2.2; sup.height = 2.2; sup.position.set(8.5, -10); sup.tint = 0xffb547; sup.visible = false;
    const mark = new Graphics();
    cont.addChild(shadow, mark, body, hpBg, hpFg, sup);
    this.unitLayer.addChild(cont);
    const u: UnitVis = { id, cont, body, shadow, hpBg, hpFg, sup, mark, x: 0, y: 0, tx: 0, ty: 0, heading: 0, cls, faction, owner: -1, key, hp: 1, supply: 1, morale: 1, flags: 0, target: -1, tile: 0, seen: 0, markKey: '' };
    this.units.set(id, u);
    return u;
  }

  private applyStructs(a: Float32Array): void {
    const seen = this.frameNo;
    const n = a.length / STRUCT_STRIDE;
    for (let i = 0; i < n; i++) {
      const o = i * STRUCT_STRIDE;
      const id = a[o], kind = a[o + 1], tile = a[o + 2], faction = a[o + 3], owner = a[o + 4], hp = a[o + 5], build = a[o + 6], flags = a[o + 7];
      let s = this.structs.get(id);
      if (!s) {
        const cont = new Container();
        const g = new Graphics(), anim = new Graphics();
        cont.addChild(g, anim);
        cont.position.set(this.px[tile], this.py[tile]);
        cont.zIndex = this.py[tile];
        this.structLayer.addChild(cont);
        s = { id, cont, g, anim, key: '', kind, tile, x: this.px[tile], y: this.py[tile], faction, owner, flags, hp, build, seen, phase: (id * 0.37) % 6.28 };
        this.structs.set(id, s);
      }
      s.faction = faction; s.owner = owner; s.flags = flags; s.hp = hp; s.build = build; s.seen = seen;
      const key = `${faction}:${flags & (SF.BROKEN | SF.CONSTRUCTING)}:${Math.round(hp * 10)}:${Math.round(build * 8)}`;
      if (key !== s.key) { s.key = key; this.drawStruct(s); }
      const lbl = this.labels.get(id);
      if (lbl && this.labelFaction.get(id) !== faction) {
        this.labelFaction.set(id, faction);
        lbl.style.fill = faction >= 0 ? mix(factionColor(faction), 0xffffff, 0.35) : 0xaab3c0;
      }
      if (kind === S.CORE) this.coreLabel(s);
    }
    for (const [id, s] of this.structs) {
      if (s.seen !== seen) {
        s.cont.destroy({ children: true });
        this.structs.delete(id);
        const cl = this.coreLabels.get(id);
        if (cl) { cl.destroy(); this.coreLabels.delete(id); }
      }
    }
    this.structLayer.sortChildren();
  }

  private coreLabel(s: StructVis): void {
    let t = this.coreLabels.get(s.id);
    const info = this.commanderNames.get(s.owner);
    const name = (info?.name ?? 'Core').toUpperCase();
    if (!t) {
      t = new Text({ text: name, style: new TextStyle({ fontFamily: 'Chakra Petch, Inter, sans-serif', fontSize: 13, fontWeight: '700', fill: 0xffffff, letterSpacing: 1.6, stroke: { color: 0x05070a, width: 4 } }), resolution: 2 });
      t.anchor.set(0.5, 1);
      t.position.set(s.x, s.y - 22);
      this.labelLayer.addChild(t);
      this.coreLabels.set(s.id, t);
    }
    if (t.text !== name) t.text = name;
    if (this.labelFaction.get(-s.id) !== s.faction) { this.labelFaction.set(-s.id, s.faction); t.style.fill = mix(factionColor(s.faction), 0xffffff, 0.25); }
  }

  private drawStruct(s: StructVis): void {
    const g = s.g;
    g.clear();
    s.anim.clear();
    const col = factionColor(s.faction);
    const dark = shade(col, 0.28), mid = shade(col, 0.55);
    const constructing = (s.flags & SF.CONSTRUCTING) !== 0;
    g.alpha = constructing ? 0.55 : 1;
    const hexAt = (r: number) => hexCorners(0, 0, r);
    switch (s.kind) {
      case S.CORE: {
        g.ellipse(0, 4, 17, 8).fill({ color: 0x000000, alpha: 0.45 });
        g.poly(hexAt(14)).fill(shade(col, 0.22)).stroke({ width: 2, color: col, alpha: 0.95 });
        g.poly(hexAt(9)).fill(shade(col, 0.4)).stroke({ width: 1, color: mix(col, 0xffffff, 0.4), alpha: 0.8 });
        g.poly(hexAt(4.5)).fill(mix(col, 0xffffff, 0.55));
        break;
      }
      case S.DEPOT: {
        g.ellipse(0, 3, 10, 4.5).fill({ color: 0x000000, alpha: 0.4 });
        for (const [x, y] of [[-5, -1], [2, -2], [-1, 3]] as const) {
          g.rect(x - 3, y - 3, 6, 5).fill(0x5b5346).stroke({ width: 0.8, color: 0x1a1612 });
          g.rect(x - 3, y - 3, 6, 1.4).fill(col);
        }
        break;
      }
      case S.TOWER: {
        g.ellipse(0, 3, 6, 2.5).fill({ color: 0x000000, alpha: 0.4 });
        g.moveTo(-3, 3).lineTo(0, -14).lineTo(3, 3).stroke({ width: 1.4, color: 0x8b94a3 });
        g.moveTo(-2, -4).lineTo(2, -4).stroke({ width: 1, color: 0x8b94a3 });
        g.circle(0, -15, 2.4).fill(col);
        break;
      }
      case S.BUNKER: {
        g.ellipse(0, 3, 11, 5).fill({ color: 0x000000, alpha: 0.45 });
        g.ellipse(0, 0, 10, 6).fill(0x4b5059).stroke({ width: 1, color: 0x1c1f24 });
        g.ellipse(0, -1.5, 7, 3.5).fill(0x5e646e);
        g.rect(-5, -0.6, 10, 1.4).fill(col);
        break;
      }
      case S.BRIDGE: {
        const ang = this.bridgeAngle(s.tile);
        const c = Math.cos(ang), sn = Math.sin(ang);
        const seg = (a0: number, a1: number) => {
          const w = 4.2;
          const pts = [a0 * c - w * -sn, a0 * sn * TILT - w * c, a1 * c - w * -sn, a1 * sn * TILT - w * c, a1 * c + w * -sn, a1 * sn * TILT + w * c, a0 * c + w * -sn, a0 * sn * TILT + w * c];
          g.poly(pts).fill(0x6a5a44).stroke({ width: 0.8, color: 0x241c12 });
        };
        if (s.flags & SF.BROKEN) {
          seg(-18, -8); seg(8, 18);
          for (let i = 0; i < 4; i++) g.circle((i - 1.5) * 3, (i % 2) * 2, 1.1).fill(0x3a3026);
        } else {
          seg(-18, 18);
          for (let i = -15; i <= 15; i += 4) g.moveTo(i * c - 4 * -sn, i * sn * TILT - 4 * c).lineTo(i * c + 4 * -sn, i * sn * TILT + 4 * c).stroke({ width: 0.6, color: 0x2e251a, alpha: 0.8 });
        }
        break;
      }
      case S.RELAY: {
        g.ellipse(0, 3, 8, 3.5).fill({ color: 0x000000, alpha: 0.4 });
        g.moveTo(-5, 3).lineTo(0, -9).lineTo(5, 3).stroke({ width: 1.3, color: 0x9aa3b0 });
        g.moveTo(0, -9).lineTo(0, 3).stroke({ width: 1, color: 0x9aa3b0 });
        g.ellipse(0, -11, 4.5, 2.2).fill(mid).stroke({ width: 1, color: col });
        g.circle(0, -11, 1.4).fill(mix(col, 0xffffff, 0.6));
        break;
      }
      case S.MINE: {
        g.ellipse(0, 2, 10, 5).fill(0x14110e).stroke({ width: 1, color: 0x3d342a });
        g.moveTo(-6, 2).lineTo(0, -10).lineTo(6, 2).stroke({ width: 1.4, color: 0x7d7468 });
        g.circle(0, -10, 1.6).fill(col);
        for (let i = 0; i < 4; i++) g.circle(-5 + i * 3.2, 3 + (i % 2), 1.2).fill(0xc07a3a);
        break;
      }
      case S.REFINERY: {
        g.ellipse(0, 4, 12, 5).fill({ color: 0x000000, alpha: 0.4 });
        for (const x of [-5, 4]) {
          g.rect(x - 3.5, -8, 7, 11).fill(0x4d535d).stroke({ width: 0.8, color: 0x1c1f24 });
          g.ellipse(x, -8, 3.5, 1.6).fill(mix(col, 0x7fe7ff, 0.45));
        }
        break;
      }
      case S.HUB: {
        g.ellipse(0, 5, 14, 5.5).fill({ color: 0x000000, alpha: 0.45 });
        g.rect(-11, -6, 22, 10).fill(0x3e434c).stroke({ width: 1, color: 0x15181c });
        g.poly([-11, -6, -7, -11, -3, -6, 1, -11, 5, -6, 9, -11, 11, -6]).fill(0x555c67);
        g.rect(-11, 2, 22, 2).fill(col);
        break;
      }
      case S.CITADEL: {
        g.ellipse(0, 6, 24, 11).fill({ color: 0x000000, alpha: 0.5 });
        const star: number[] = [];
        for (let k = 0; k < 16; k++) { const a = (Math.PI / 8) * k; const r = k % 2 ? 13 : 21; star.push(Math.cos(a) * r, Math.sin(a) * r * TILT); }
        g.poly(star).fill(shade(col, s.faction >= 0 ? 0.3 : 0.4)).stroke({ width: 2, color: s.faction >= 0 ? col : 0x9aa3b0 });
        g.poly(hexAt(8)).fill(shade(col, 0.55)).stroke({ width: 1, color: mix(col, 0xffffff, 0.5) });
        g.circle(0, -2, 3).fill(mix(col, 0xffffff, 0.7));
        break;
      }
    }
    if (constructing) {
      g.rect(-9, 9, 18, 2).fill(0x05070a);
      g.rect(-9, 9, 18 * s.build, 2).fill(0x7fe7ff);
    } else if (STRUCTS[s.kind].destructible && s.hp < 0.999 && !(s.flags & SF.BROKEN)) {
      g.rect(-10, 9, 20, 2.2).fill(0x05070a);
      g.rect(-10, 9, 20 * s.hp, 2.2).fill(s.hp > 0.5 ? 0x7ee2a8 : s.hp > 0.25 ? 0xffd166 : 0xff5d5d);
    }
  }

  private bridgeAngle(tile: number): number {
    const g = this.grid;
    let best = 0, bd = -1;
    for (let d = 0; d < 3; d++) {
      const a = g.nb[tile * 6 + d], b = g.nb[tile * 6 + d + 3];
      const land = (v: number) => v >= 0 && this.map.terrain[v] !== T.RIVER;
      const score = (land(a) ? 1 : 0) + (land(b) ? 1 : 0);
      if (score > bd) { bd = score; best = d; }
    }
    const a = g.nb[tile * 6 + best], b = g.nb[tile * 6 + best + 3];
    if (a < 0 || b < 0) return 0;
    return Math.atan2((this.py[b] - this.py[a]) / TILT, this.px[b] - this.px[a]);
  }

  private setOpRegion(r: Int32Array | null): void {
    this.opRegion = r;
    this.opEdges = [];
    if (!r) return;
    const inR = new Uint8Array(this.grid.n);
    for (const t of r) inR[t] = 1;
    for (const t of r) {
      const pts = hexCorners(this.px[t], this.py[t]);
      for (let d = 0; d < 6; d++) {
        const v = this.grid.nb[t * 6 + d];
        if (v >= 0 && inR[v]) continue;
        const e = DIR_EDGE[d];
        const e2 = (e + 1) % 6;
        this.opEdges.push(pts[e * 2], pts[e * 2 + 1], pts[e2 * 2], pts[e2 * 2 + 1]);
      }
    }
  }

  private setStorms(storms: { tile: number; radius: number }[]): void {
    const key = storms.map((s) => s.tile).join(',');
    const cur = this.storms.map((s) => s.tile).join(',');
    if (key === cur) return;
    this.storms = storms.slice();
    for (const c of this.clouds) c.s.destroy();
    this.clouds = [];
    storms.forEach((st, si) => {
      for (let i = 0; i < 16; i++) {
        const s = new Sprite(this.tex.cloud);
        s.anchor.set(0.5);
        s.tint = mix(0x5a6a85, 0x9fb3d1, (i % 5) / 5);
        s.alpha = 0.1 + (i % 3) * 0.03;
        s.scale.set(0.9 + (i % 4) * 0.3, (0.9 + (i % 4) * 0.3) * 0.6);
        this.weatherLayer.addChild(s);
        this.clouds.push({ s, storm: si, ang: (i / 16) * Math.PI * 2, rad: (0.25 + ((i * 37) % 70) / 100) * st.radius * HEX_W * 0.9, spd: 0.04 + (i % 5) * 0.012 });
      }
    });
  }

  // ------------------------------------------------------------------ effects
  private unitScreen(id: number): [number, number] | null {
    if (id >= STRUCT_ID_BASE) {
      const s = this.structs.get(id - STRUCT_ID_BASE);
      return s ? [s.x, s.y - 4] : null;
    }
    const u = this.units.get(id);
    return u ? [u.x, u.y - 2] : null;
  }

  private applyFx(fx: Float32Array, now: number): void {
    const n = fx.length / FX_STRIDE;
    const shotBudget = Math.max(0, 420 - this.tracers.length);
    let shots = 0;
    for (let i = 0; i < n; i++) if (fx[i * FX_STRIDE] === FX.SHOT) shots++;
    const keep = shots > shotBudget ? shotBudget / shots : 1;
    const spread = 50;
    for (let i = 0; i < n; i++) {
      const o = i * FX_STRIDE;
      const kind = fx[o], a = fx[o + 1], b = fx[o + 2], f = fx[o + 3], p1 = fx[o + 4];
      const col = factionColor(f);
      const delay = Math.random() * spread;
      switch (kind) {
        case FX.SHOT: {
          if (keep < 1 && Math.random() > keep) break;
          const from = this.unitScreen(a), to = this.unitScreen(b);
          if (!from || !to) break;
          const cls = p1;
          const jitter = () => (Math.random() - 0.5) * 6;
          const tc = mix(col, 0xfff3d6, 0.55);
          if (cls === U.RIFLE || cls === U.SCOUT || cls === U.ENGINEER) {
            const bursts = cls === U.RIFLE ? 2 : 1;
            for (let k = 0; k < bursts; k++) this.tracers.push({ x0: from[0] + jitter(), y0: from[1] + jitter() * 0.5, x1: to[0] + jitter(), y1: to[1] + jitter() * 0.5, t0: now + delay + k * 55, dur: 110, color: tc, width: 1.1, len: 0.35 });
            this.spawn(this.tex.glow, from[0], from[1], 0, 0, 90, 0.12, 0.05, 0.8, tc, 0, 1, true, delay);
            if (Math.random() < 0.5) this.spark(to[0], to[1], tc, 2, delay + 110);
          } else if (cls === U.WALKER) {
            this.tracers.push({ x0: from[0], y0: from[1], x1: to[0] + jitter(), y1: to[1], t0: now + delay, dur: 140, color: mix(col, 0xffffff, 0.35), width: 2.6, len: 0.5 });
            this.spawn(this.tex.glow, from[0], from[1], 0, 0, 130, 0.16, 0.06, 0.9, mix(col, 0xffffff, 0.5), 0, 1, true, delay);
            this.spawn(this.tex.glow, to[0], to[1], 0, 0, 220, 0.12, 0.26, 0.7, 0xffb070, 0, 1, true, delay + 140);
            this.spark(to[0], to[1], 0xffc080, 5, delay + 140);
          } else {
            // defensive structure turret bolt
            this.tracers.push({ x0: from[0], y0: from[1] - 4, x1: to[0], y1: to[1], t0: now + delay, dur: 160, color: mix(col, 0x9feaff, 0.6), width: 1.8, len: 0.6 });
            this.spark(to[0], to[1], 0x9feaff, 3, delay + 160);
          }
          break;
        }
        case FX.SHELL: {
          const from = this.unitScreen(a);
          if (!from) break;
          const dur = Math.max(260, Math.min(1600, (p1 * 200) / Math.max(0.5, this.speed)));
          this.shells.push({ x0: from[0], y0: from[1], x1: this.px[b], y1: this.py[b], t0: now + delay, dur, color: mix(col, 0xffe2b0, 0.5), tile: b });
          this.spawn(this.tex.glow, from[0], from[1], 0, 0, 180, 0.2, 0.08, 1, 0xffd29a, 0, 1, true, delay);
          this.smoke(from[0], from[1], 1, delay);
          break;
        }
        case FX.IMPACT: this.explosion(this.px[a], this.py[a], p1 >= 2 ? 0.9 : 0.6, col, delay); break;
        case FX.DEATH: {
          const big = b === U.WALKER || b === U.ARTILLERY;
          this.explosion(this.px[a] + (Math.random() - 0.5) * 8, this.py[a] + (Math.random() - 0.5) * 5, big ? 1.5 : 0.85, col, delay);
          this.decal(this.px[a] + (Math.random() - 0.5) * 8, this.py[a] + (Math.random() - 0.5) * 4, big ? 1.1 : 0.7);
          break;
        }
        case FX.CAPTURE: {
          const x = this.px[a], y = this.py[a];
          if (b >= 0) {
            this.rings.push({ x, y, t0: now + delay, dur: 1300, r0: 6, r1: 46, color: col, width: 2.5, alpha: 0.9 });
            this.rings.push({ x, y, t0: now + delay + 200, dur: 1100, r0: 4, r1: 30, color: mix(col, 0xffffff, 0.5), width: 1.4, alpha: 0.7 });
            this.rings.push({ x, y, t0: now + delay, dur: 900, r0: HEX_SIZE, r1: HEX_SIZE, color: col, width: 0, alpha: 0.5, hex: true });
          } else {
            this.rings.push({ x, y, t0: now + delay, dur: 700, r0: HEX_SIZE * 0.95, r1: HEX_SIZE * 0.95, color: col, width: 0, alpha: 0.22, hex: true });
          }
          break;
        }
        case FX.BUILT: {
          const x = this.px[a], y = this.py[a];
          this.rings.push({ x, y, t0: now + delay, dur: 900, r0: 4, r1: 26, color: 0x7fe7ff, width: 1.6, alpha: 0.9 });
          for (let k = 0; k < 8; k++) this.spawn(this.tex.dot, x, y, (Math.random() - 0.5) * 0.06, -0.03 - Math.random() * 0.04, 700, 0.3, 0.05, 0.9, 0x9feaff, 0, 0.99, true, delay);
          break;
        }
        case FX.DESTROYED: this.explosion(this.px[a], this.py[a], 1.6, col, delay); this.decal(this.px[a], this.py[a], 1.3); break;
        case FX.CORE_FALL: {
          const x = this.px[a], y = this.py[a];
          for (let k = 0; k < 5; k++) this.explosion(x + (Math.random() - 0.5) * 26, y + (Math.random() - 0.5) * 14, 1.8, col, delay + k * 140);
          this.rings.push({ x, y, t0: now + delay, dur: 1600, r0: 10, r1: 130, color: 0xffd2a0, width: 4, alpha: 0.9 });
          this.decal(x, y, 2.4);
          this.cam.shake = Math.max(this.cam.shake, 14);
          break;
        }
        case FX.SPAWN: {
          const x = this.px[a], y = this.py[a];
          this.rings.push({ x, y, t0: now + delay, dur: 600, r0: 2, r1: 14, color: col, width: 1.4, alpha: 0.8 });
          break;
        }
      }
    }
  }

  private spawn(tex: Texture, x: number, y: number, vx: number, vy: number, life: number, s0: number, s1: number, a0: number, tint: number, grav: number, drag: number, add: boolean, delay = 0): void {
    let p: Particle | undefined;
    for (let i = 0; i < this.particles.length; i++) if (!this.particles[i].active) { p = this.particles[i]; break; }
    if (!p) return;
    p.active = true;
    p.s.texture = tex;
    p.s.tint = tint;
    p.s.position.set(x, y);
    p.s.scale.set(s0);
    p.s.alpha = delay > 0 ? 0 : a0;
    p.s.visible = true;
    p.vx = vx; p.vy = vy; p.life = -delay; p.max = life; p.s0 = s0; p.s1 = s1; p.a0 = a0; p.grav = grav; p.drag = drag;
    const parent = add ? this.fxAdd : this.fxNormal;
    if (p.s.parent !== parent) parent.addChild(p.s);
  }

  private spark(x: number, y: number, col: number, n: number, delay: number): void {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, v = 0.04 + Math.random() * 0.08;
      this.spawn(this.tex.dot, x, y, Math.cos(a) * v, Math.sin(a) * v * TILT - 0.03, 260 + Math.random() * 200, 0.22, 0.04, 1, col, 0.00018, 0.995, true, delay);
    }
  }

  private smoke(x: number, y: number, size: number, delay: number): void {
    for (let k = 0; k < 2 + size * 2; k++) {
      this.spawn(this.tex.smoke, x + (Math.random() - 0.5) * 8, y + (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 0.01, -0.008 - Math.random() * 0.01, 1400 + Math.random() * 900, 0.25 * size, 0.9 * size, 0.32, mix(0x2a2d33, 0x4a4f58, Math.random()), 0, 0.998, false, delay + k * 40);
    }
  }

  private explosion(x: number, y: number, size: number, col: number, delay: number): void {
    const now = performance.now();
    this.spawn(this.tex.glow, x, y, 0, 0, 220 * size, 0.22 * size, 0.5 * size, 0.95, 0xffd7a0, 0, 1, true, delay);
    this.spawn(this.tex.glow, x, y, 0, 0, 480 * size, 0.3 * size, 0.62 * size, 0.55, mix(col, 0xff6a20, 0.65), 0, 1, true, delay);
    this.rings.push({ x, y, t0: now + delay, dur: 420 * size, r0: 3, r1: 20 * size, color: 0xffd8a8, width: 2 * size, alpha: 0.8 });
    for (let k = 0; k < 7 * size; k++) {
      const a = Math.random() * Math.PI * 2, v = 0.05 + Math.random() * 0.12 * size;
      this.spawn(this.tex.dot, x, y, Math.cos(a) * v, Math.sin(a) * v * TILT - 0.06, 380 + Math.random() * 380, 0.32, 0.06, 1, Math.random() < 0.5 ? 0xffb15a : 0xffe3a0, 0.00025, 0.993, true, delay);
    }
    this.smoke(x, y, size, delay + 80);
  }

  private decal(x: number, y: number, size: number): void {
    const s = new Sprite(this.tex.smoke);
    s.anchor.set(0.5);
    s.tint = 0x050505;
    s.alpha = 0.55;
    s.scale.set(0.42 * size, 0.22 * size);
    s.position.set(x, y + 2);
    this.decalLayer.addChild(s);
    this.decals.push({ s, t0: performance.now(), life: 45000 });
    if (this.decals.length > 160) { const d = this.decals.shift()!; d.s.destroy(); }
  }

  // ------------------------------------------------------------------ overlays
  private rebuildTerritory(): void {
    const g = this.territoryG, fg = this.frontG, gg = this.frontGlowG;
    g.clear(); fg.clear(); gg.clear();
    if (!this.overlays.territory && !this.overlays.fronts) return;
    const { grid } = this;
    for (let t = 0; t < grid.n; t++) {
      const f = this.territory[t];
      if (f < 0) continue;
      const col = factionColor(f);
      const pts = hexCorners(this.px[t], this.py[t], HEX_SIZE - 0.6);
      if (this.overlays.territory) g.poly(pts).fill({ color: col, alpha: 0.15 });
      if (!this.overlays.fronts) continue;
      const inner = hexCorners(this.px[t], this.py[t], HEX_SIZE - 2.1);
      for (let d = 0; d < 6; d++) {
        const v = grid.nb[t * 6 + d];
        const of = v >= 0 ? this.territory[v] : -1;
        if (of === f) {
          // commander boundary within a faction: faint dotted hint
          if (v >= 0 && this.owner[v] !== this.owner[t] && v > t && this.owner[v] >= 0) {
            const e = DIR_EDGE[d], e2 = (e + 1) % 6;
            fg.moveTo(pts[e * 2], pts[e * 2 + 1]).lineTo(pts[e2 * 2], pts[e2 * 2 + 1]).stroke({ width: 0.8, color: mix(col, 0xffffff, 0.3), alpha: 0.25 });
          }
          continue;
        }
        const e = DIR_EDGE[d], e2 = (e + 1) % 6;
        const x0 = inner[e * 2], y0 = inner[e * 2 + 1], x1 = inner[e2 * 2], y1 = inner[e2 * 2 + 1];
        if (of >= 0) {
          // contested front line: hot glow + bright core in own colour
          gg.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 7, color: col, alpha: 0.16, cap: 'round' });
          fg.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 2.2, color: mix(col, 0xffffff, 0.35), alpha: 0.95, cap: 'round' });
        } else {
          fg.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 1.2, color: col, alpha: 0.55, cap: 'round' });
        }
      }
    }
  }

  private rebuildSupply(): void {
    const g = this.supplyG;
    g.clear();
    if (!this.overlays.supply) return;
    for (let t = 0; t < this.grid.n; t++) {
      const m = this.supply[t];
      if (!m) continue;
      for (let f = 0; f < 4; f++) {
        if (!(m & (1 << f))) continue;
        g.circle(this.px[t] + (f - 1.5) * 2.2, this.py[t], 1.5).fill({ color: factionColor(f), alpha: 0.7 });
      }
    }
  }

  private rebuildFog(): void {
    const g = this.fogG;
    g.clear();
    if (!this.fog || this.overlays.fog < 0) return;
    for (let t = 0; t < this.grid.n; t++) {
      const v = this.fog[t];
      if (v === 2) continue;
      const pts = hexCorners(this.px[t], this.py[t], HEX_SIZE + 0.6);
      g.poly(pts).fill({ color: 0x020305, alpha: v === 1 ? 0.5 : 0.82 });
    }
    if (this.ghosts) {
      for (let i = 0; i < this.ghosts.length; i += 4) {
        const tile = this.ghosts[i], f = this.ghosts[i + 2], age = this.ghosts[i + 3];
        const a = Math.max(0.15, 1 - age / 900);
        const x = this.px[tile], y = this.py[tile];
        g.poly([x, y - 6, x + 6, y, x, y + 6, x - 6, y]).stroke({ width: 1.3, color: factionColor(f), alpha: a });
      }
    }
  }

  // ------------------------------------------------------------------ per-frame animation
  private animate(dtMs: number): void {
    if (!this.ready) return;
    const now = performance.now();
    this.fpsAcc += dtMs; this.fpsN++;
    if (this.fpsAcc > 500) { this.onFps((this.fpsN * 1000) / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }
    if (this.territoryDirty && now - this.lastTerritoryBuild > 300) { this.territoryDirty = false; this.lastTerritoryBuild = now; this.rebuildTerritory(); }
    if (this.supplyDirty) { this.supplyDirty = false; this.rebuildSupply(); }
    if (this.fogDirty && now - this.lastFogBuild > 140) { this.fogDirty = false; this.lastFogBuild = now; this.rebuildFog(); }
    this.updateCamera(dtMs, now);
    const z = this.cam.zoom;
    const k = 1 - Math.exp(-dtMs / 85);
    const detail = z > 0.75;
    for (const u of this.units.values()) {
      u.x += (u.tx - u.x) * k;
      u.y += (u.ty - u.y) * k;
      u.cont.position.set(u.x, u.y);
      u.cont.zIndex = u.y;
      let heading = u.heading;
      if (u.flags & UF.COMBAT && u.target >= 0) {
        const tp = this.unitScreen(u.target);
        if (tp) heading = Math.atan2(tp[1] - u.y, tp[0] - u.x);
      }
      u.body.rotation = heading;
      const showHp = detail || u.hp < 0.995 || u.owner === this.selectedOwner;
      u.hpBg.visible = showHp && (u.hp < 0.995 || u.id === this.selectedUnit || detail);
      u.hpFg.visible = u.hpBg.visible;
      if (u.hpFg.visible) {
        u.hpFg.width = 13 * u.hp;
        u.hpFg.tint = u.hp > 0.6 ? 0x7ee2a8 : u.hp > 0.3 ? 0xffd166 : 0xff5d5d;
      }
      u.sup.visible = u.supply < 0.3;
      if (u.sup.visible) u.sup.alpha = 0.5 + 0.5 * Math.sin(now / 160);
      const sel = u.id === this.selectedUnit ? 2 : u.owner === this.selectedOwner ? 1 : 0;
      const mk = `${sel}:${u.flags & (UF.RETREAT | UF.VETERAN | UF.EVAC)}:${u.faction}`;
      if (mk !== u.markKey) {
        u.markKey = mk;
        const g = u.mark;
        g.clear();
        const col = factionColor(u.faction);
        if (sel) g.ellipse(0, 2, sel === 2 ? 11 : 9, (sel === 2 ? 11 : 9) * TILT * 0.75).stroke({ width: sel === 2 ? 1.8 : 1, color: sel === 2 ? 0xffffff : col, alpha: sel === 2 ? 0.95 : 0.7 });
        if (u.flags & UF.RETREAT) g.poly([-10, -2, -7, 0, -10, 2]).fill({ color: 0xffffff, alpha: 0.75 });
        if (u.flags & UF.VETERAN) g.star(0, -14, 5, 2.4, 1.1).fill(0xffd166);
        if (u.flags & UF.EVAC) g.circle(0, 0, 10).stroke({ width: 1, color: 0xffffff, alpha: 0.45 });
      }
      u.body.alpha = u.flags & UF.EVAC ? 0.6 : 1;
    }
    // structure animation (core rings, relay pulses, objective markers)
    for (const s of this.structs.values()) {
      const a = s.anim;
      a.clear();
      const col = factionColor(s.faction);
      if (s.kind === S.CORE && s.hp > 0) {
        const rot = now / 1600 + s.phase;
        for (let i = 0; i < 3; i++) {
          const a0 = rot + (i * Math.PI * 2) / 3;
          const pts: number[] = [];
          for (let k2 = 0; k2 <= 8; k2++) { const ang = a0 + (k2 / 8) * 1.3; pts.push(Math.cos(ang) * 19, Math.sin(ang) * 19 * TILT); }
          a.poly(pts, false).stroke({ width: 1.6, color: col, alpha: 0.8 });
        }
        a.circle(0, 0, 3 + Math.sin(now / 300 + s.phase) * 0.8).fill({ color: 0xffffff, alpha: 0.9 });
      } else if (s.kind === S.RELAY && s.faction >= 0) {
        const p = ((now / 1800 + s.phase) % 1);
        a.ellipse(0, -11, 5 + p * 16, (5 + p * 16) * 0.5).stroke({ width: 1.2, color: col, alpha: 0.6 * (1 - p) });
      } else if (s.kind === S.CITADEL) {
        const p = ((now / 2600) % 1);
        a.ellipse(0, 0, 22 + p * 18, (22 + p * 18) * TILT).stroke({ width: 1.4, color: s.faction >= 0 ? col : 0xc8d0dc, alpha: 0.5 * (1 - p) });
      }
      if (s.flags & SF.OBJECTIVE) {
        const bob = Math.sin(now / 380 + s.phase) * 2;
        const y0 = -30 + bob;
        a.poly([0, y0 - 6, 5, y0, 0, y0 + 6, -5, y0]).fill({ color: 0xffd166, alpha: 0.95 }).stroke({ width: 1, color: 0x05070a });
        a.moveTo(0, y0 + 6).lineTo(0, -14).stroke({ width: 1, color: 0xffd166, alpha: 0.5 });
      }
    }
    // labels: constant screen size, LOD
    const inv = 1 / z;
    for (const [id, t] of this.labels) {
      t.visible = this.overlays.labels && z > 0.55;
      if (t.visible) t.scale.set(Math.min(1.6, inv * 0.9));
      void id;
    }
    for (const t of this.coreLabels.values()) { t.visible = this.overlays.labels; t.scale.set(Math.min(1.8, Math.max(0.8, inv * 0.95))); }
    this.drawFx(now, dtMs);
    this.drawOp(now);
    this.drawPlan(now);
    this.drawWeather(now, dtMs);
    // decals fade
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      const age = now - d.t0;
      if (age > d.life) { d.s.destroy(); this.decals.splice(i, 1); continue; }
      d.s.alpha = 0.55 * (1 - age / d.life);
    }
  }

  private drawFx(now: number, dt: number): void {
    const g = this.tracerG;
    g.clear();
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      const p = (now - tr.t0) / tr.dur;
      if (p < 0) continue;
      if (p > 1) { this.tracers.splice(i, 1); continue; }
      const head = Math.min(1, p * 1.25), tail = Math.max(0, head - tr.len);
      const x0 = tr.x0 + (tr.x1 - tr.x0) * tail, y0 = tr.y0 + (tr.y1 - tr.y0) * tail;
      const x1 = tr.x0 + (tr.x1 - tr.x0) * head, y1 = tr.y0 + (tr.y1 - tr.y0) * head;
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: tr.width * 2.6, color: tr.color, alpha: 0.18 * (1 - p * 0.5), cap: 'round' });
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: tr.width, color: tr.color, alpha: 0.95 * (1 - p * 0.4), cap: 'round' });
    }
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i];
      const p = (now - sh.t0) / sh.dur;
      if (p < 0) continue;
      if (p >= 1) { this.shells.splice(i, 1); this.explosion(sh.x1, sh.y1, 0.9, sh.color, 0); continue; }
      const arc = (q: number): [number, number] => [sh.x0 + (sh.x1 - sh.x0) * q, sh.y0 + (sh.y1 - sh.y0) * q - Math.sin(q * Math.PI) * 46];
      const pts: number[] = [];
      for (let k = 0; k <= 6; k++) { const q = Math.max(0, p - 0.18 + (k / 6) * 0.18); const [x, y] = arc(q); pts.push(x, y); }
      g.poly(pts, false).stroke({ width: 2.2, color: sh.color, alpha: 0.35, cap: 'round' });
      const [hx, hy] = arc(p);
      g.circle(hx, hy, 2).fill({ color: 0xfff2d0, alpha: 1 });
    }
    const rg = this.ringG;
    rg.clear();
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      const p = (now - r.t0) / r.dur;
      if (p < 0) continue;
      if (p > 1) { this.rings.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - p, 3);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      if (r.hex) rg.poly(hexCorners(r.x, r.y, rad)).fill({ color: r.color, alpha: r.alpha * (1 - p) });
      else rg.ellipse(r.x, r.y, rad, rad * TILT).stroke({ width: r.width * (1 - p * 0.6), color: r.color, alpha: r.alpha * (1 - p) });
    }
    for (const p of this.particles) {
      if (!p.active) continue;
      p.life += dt;
      if (p.life < 0) continue;
      if (p.life >= p.max) { p.active = false; p.s.visible = false; continue; }
      const q = p.life / p.max;
      p.vy += p.grav * dt;
      p.vx *= p.drag; p.vy *= p.drag;
      p.s.x += p.vx * dt; p.s.y += p.vy * dt;
      p.s.scale.set(p.s0 + (p.s1 - p.s0) * q);
      p.s.alpha = p.a0 * (1 - q) * (q < 0.08 ? q / 0.08 : 1);
    }
  }

  private drawOp(now: number): void {
    const g = this.opG;
    g.clear();
    if (!this.opRegion || !this.opEdges.length) return;
    const pulse = 0.55 + 0.35 * Math.sin(now / 420);
    const col = this.opInfo?.status === 'Running' ? 0xffd166 : 0xc8d0dc;
    for (let i = 0; i < this.opEdges.length; i += 4) {
      g.moveTo(this.opEdges[i], this.opEdges[i + 1]).lineTo(this.opEdges[i + 2], this.opEdges[i + 3]);
    }
    g.stroke({ width: 5, color: col, alpha: 0.08 * pulse });
    for (let i = 0; i < this.opEdges.length; i += 4) {
      // dashed: draw every other edge segment brighter, animated
      if (((i / 4 + Math.floor(now / 300)) % 3) === 0) continue;
      g.moveTo(this.opEdges[i], this.opEdges[i + 1]).lineTo(this.opEdges[i + 2], this.opEdges[i + 3]);
    }
    g.stroke({ width: 1.5, color: col, alpha: 0.75 * pulse });
  }

  private drawPlan(now: number): void {
    const g = this.planG;
    g.clear();
    const p = this.plan;
    if (!p) return;
    const col = factionColor(p.faction);
    if (this.overlays.danger) {
      for (const d of p.danger) {
        const r = 10 + d.conf * 30;
        g.ellipse(this.px[d.tile], this.py[d.tile], r, r * TILT).fill({ color: 0xff3b3b, alpha: 0.06 + d.conf * 0.12 }).stroke({ width: 1, color: 0xff5d5d, alpha: 0.35 });
      }
    }
    if (!this.overlays.plans || p.target < 0) return;
    // candidate targets considered at the last review
    for (const c of p.candidates) {
      if (c.chosen) continue;
      g.ellipse(this.px[c.tile], this.py[c.tile], 9, 9 * TILT).stroke({ width: 1, color: col, alpha: 0.35 });
    }
    let cx = 0, cy = 0, n = 0;
    for (const id of p.group) { const u = this.units.get(id); if (u) { cx += u.x; cy += u.y; n++; } }
    const tx = this.px[p.target], ty = this.py[p.target];
    const tr = 14 + Math.sin(now / 250) * 2;
    g.ellipse(tx, ty, tr, tr * TILT).stroke({ width: 2, color: col, alpha: 0.9 });
    g.ellipse(tx, ty, tr * 0.45, tr * 0.45 * TILT).fill({ color: col, alpha: 0.35 });
    if (!n) return;
    cx /= n; cy /= n;
    const mx = (cx + tx) / 2, my = (cy + ty) / 2 - Math.hypot(tx - cx, ty - cy) * 0.18;
    const pts: number[] = [];
    const steps = 28;
    const off = (now / 600) % 1;
    for (let k = 0; k <= steps; k++) {
      const q = k / steps;
      const x = (1 - q) * (1 - q) * cx + 2 * (1 - q) * q * mx + q * q * tx;
      const y = (1 - q) * (1 - q) * cy + 2 * (1 - q) * q * my + q * q * ty;
      pts.push(x, y);
    }
    g.poly(pts, false).stroke({ width: 5, color: col, alpha: 0.12 });
    for (let k = 0; k < steps; k += 2) {
      const i0 = Math.floor(k + off * 2) % steps;
      if (i0 + 1 > steps) continue;
      g.moveTo(pts[i0 * 2], pts[i0 * 2 + 1]).lineTo(pts[(i0 + 1) * 2], pts[(i0 + 1) * 2 + 1]);
    }
    g.stroke({ width: 2, color: mix(col, 0xffffff, 0.3), alpha: 0.9, cap: 'round' });
    // arrowhead
    const ax = pts[pts.length - 2], ay = pts[pts.length - 1], bx = pts[pts.length - 6], by = pts[pts.length - 5];
    const ang = Math.atan2(ay - by, ax - bx);
    g.poly([ax, ay, ax - Math.cos(ang - 0.45) * 10, ay - Math.sin(ang - 0.45) * 10, ax - Math.cos(ang + 0.45) * 10, ay - Math.sin(ang + 0.45) * 10]).fill({ color: mix(col, 0xffffff, 0.3), alpha: 0.95 });
  }

  private drawWeather(now: number, dt: number): void {
    this.weatherLayer.visible = this.overlays.weather;
    for (const c of this.clouds) {
      const st = this.storms[c.storm];
      if (!st) continue;
      c.ang += c.spd * dt * 0.001;
      c.s.position.set(this.px[st.tile] + Math.cos(c.ang) * c.rad, this.py[st.tile] + Math.sin(c.ang) * c.rad * TILT);
    }
    if (this.storms.length && Math.random() < dt / 2400) {
      const st = this.storms[Math.floor(Math.random() * this.storms.length)];
      const x = this.px[st.tile] + (Math.random() - 0.5) * 120, y = this.py[st.tile] + (Math.random() - 0.5) * 70;
      const pts: number[] = [x, y - 90];
      for (let k = 1; k <= 6; k++) pts.push(x + (Math.random() - 0.5) * 18, y - 90 + k * 15);
      this.lightning.push({ pts, t0: now });
      this.spawn(this.tex.glow, x, y, 0, 0, 260, 1.2, 1.8, 0.28, 0xbfd4ff, 0, 1, true, 0);
    }
    const g = this.ringG;
    for (let i = this.lightning.length - 1; i >= 0; i--) {
      const l = this.lightning[i];
      const age = now - l.t0;
      if (age > 220) { this.lightning.splice(i, 1); continue; }
      g.poly(l.pts, false).stroke({ width: 1.6, color: 0xdfe9ff, alpha: 1 - age / 220 });
    }
  }

  // ------------------------------------------------------------------ camera
  setCameraMode(m: CameraMode): void { this.cam.mode = m; this.cam.lastDirector = 0; this.onCameraMode(m); }

  focusTile(tile: number, zoom?: number): void {
    if (tile < 0 || tile >= this.px.length) return;
    this.cam.tx = this.px[tile]; this.cam.ty = this.py[tile];
    if (zoom) this.cam.tz = zoom;
  }

  focusWorld(x: number, y: number): void { this.cam.tx = x; this.cam.ty = y; }

  private updateCamera(dt: number, now: number): void {
    const c = this.cam;
    if (c.mode === 'follow' && this.selectedOwner >= 0) {
      let x = 0, y = 0, n = 0;
      for (const u of this.units.values()) if (u.owner === this.selectedOwner) { x += u.x; y += u.y; n++; }
      if (n) { c.tx = x / n; c.ty = y / n; }
    } else if (c.mode === 'operation' && this.opInfo && this.opInfo.center >= 0) {
      c.tx = this.px[this.opInfo.center]; c.ty = this.py[this.opInfo.center];
      if (now - c.lastDirector > 1e9) c.tz = 1.25;
    } else if (c.mode === 'director' && now - c.lastDirector > 6500) {
      c.lastDirector = now;
      const b = this.battles[0];
      if (b) { c.tx = this.px[b.tile]; c.ty = this.py[b.tile]; c.tz = 1.35; }
      else if (this.opInfo) { c.tx = this.px[this.opInfo.center]; c.ty = this.py[this.opInfo.center]; c.tz = 1.2; }
    }
    const k = 1 - Math.exp(-dt / 220);
    c.x += (c.tx - c.x) * k;
    c.y += (c.ty - c.y) * k;
    c.zoom += (c.tz - c.zoom) * (1 - Math.exp(-dt / 140));
    c.x = Math.max(0, Math.min(this.worldW, c.x));
    c.y = Math.max(0, Math.min(this.worldH, c.y));
    let sx = 0, sy = 0;
    if (c.shake > 0.1) { sx = (Math.random() - 0.5) * c.shake; sy = (Math.random() - 0.5) * c.shake; c.shake *= Math.exp(-dt / 160); }
    const w = this.app.screen.width, h = this.app.screen.height;
    this.world.scale.set(c.zoom);
    this.world.position.set(w / 2 - c.x * c.zoom + sx, h / 2 - c.y * c.zoom + sy);
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.world.position.x) / this.cam.zoom, (sy - this.world.position.y) / this.cam.zoom];
  }

  viewRect(): { x: number; y: number; w: number; h: number } {
    const [x0, y0] = this.screenToWorld(0, 0);
    const [x1, y1] = this.screenToWorld(this.app.screen.width, this.app.screen.height);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  private bindInput(): void {
    const el = this.app.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      this.dragging = true; this.dragMoved = false;
      this.lastPointer = { x: e.offsetX, y: e.offsetY };
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (p) { p.x = e.offsetX; p.y = e.offsetY; }
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist > 0) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / this.pinchDist);
        this.pinchDist = d;
        this.dragMoved = true;
        return;
      }
      if (this.dragging) {
        const dx = e.offsetX - this.lastPointer.x, dy = e.offsetY - this.lastPointer.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.dragMoved = true;
        if (this.dragMoved) {
          if (this.cam.mode !== 'free') this.setCameraMode('free');
          this.cam.tx -= dx / this.cam.zoom; this.cam.ty -= dy / this.cam.zoom;
          this.cam.x -= dx / this.cam.zoom; this.cam.y -= dy / this.cam.zoom;
        }
        this.lastPointer = { x: e.offsetX, y: e.offsetY };
      } else {
        const now = performance.now();
        if (now - this.hoverAt > 60) { this.hoverAt = now; this.onHover(this.pick(e.offsetX, e.offsetY)); }
      }
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
      if (this.dragging && !this.dragMoved && this.pointers.size === 0) this.onPick(this.pick(e.offsetX, e.offsetY));
      if (this.pointers.size === 0) this.dragging = false;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', () => this.onHover(null));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0016));
    }, { passive: false });
    el.addEventListener('dblclick', (e) => {
      const [wx, wy] = this.screenToWorld(e.offsetX, e.offsetY);
      this.setCameraMode('free');
      this.cam.tx = wx; this.cam.ty = wy; this.cam.tz = Math.min(2.6, this.cam.tz * 1.6);
    });
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const c = this.cam;
    const nz = Math.max(0.3, Math.min(3, c.tz * factor));
    const [wx, wy] = this.screenToWorld(sx, sy);
    const w = this.app.screen.width, h = this.app.screen.height;
    // keep the world point under the cursor fixed
    c.tx = wx - (sx - w / 2) / nz;
    c.ty = wy - (sy - h / 2) / nz;
    if (c.mode !== 'free' && c.mode !== 'follow') this.setCameraMode('free');
    c.tz = nz;
  }

  zoomBy(f: number): void { this.zoomAt(this.app.screen.width / 2, this.app.screen.height / 2, f); }

  pick(sx: number, sy: number): PickInfo {
    const [wx, wy] = this.screenToWorld(sx, sy);
    const none: PickInfo = { kind: 'none', id: -1, owner: -1, faction: -1, tile: -1, cls: -1, structKind: -1, hp: 0, supply: 0, morale: 0, flags: 0, screenX: sx, screenY: sy };
    if (!this.ready) return none;
    let best: UnitVis | null = null, bd = 13 / Math.max(0.6, this.cam.zoom) + 4;
    for (const u of this.units.values()) {
      const d = Math.hypot(u.x - wx, (u.y - wy) / TILT);
      if (d < bd) { bd = d; best = u; }
    }
    if (best) return { ...none, kind: 'unit', id: best.id, owner: best.owner, faction: best.faction, tile: best.tile, cls: best.cls, hp: best.hp, supply: best.supply, morale: best.morale, flags: best.flags };
    let bs: StructVis | null = null, bsd = 16;
    for (const s of this.structs.values()) {
      const d = Math.hypot(s.x - wx, (s.y - wy) / TILT);
      if (d < bsd) { bsd = d; bs = s; }
    }
    if (bs) return { ...none, kind: 'struct', id: bs.id, owner: bs.owner, faction: bs.faction, tile: bs.tile, structKind: bs.kind, hp: bs.hp };
    // nearest tile centre
    const r = Math.max(0, Math.min(this.map.h - 1, Math.round((wy - HEX_SIZE) / ROW_H)));
    let bt = -1, btd = 1e9;
    for (let rr = Math.max(0, r - 2); rr <= Math.min(this.map.h - 1, r + 2); rr++) {
      const c0 = Math.max(0, Math.floor(wx / HEX_W) - 2), c1 = Math.min(this.map.w - 1, c0 + 4);
      for (let cc = c0; cc <= c1; cc++) {
        const t = rr * this.map.w + cc;
        const d = Math.hypot(this.px[t] - wx, (this.py[t] - wy) / TILT);
        if (d < btd) { btd = d; bt = t; }
      }
    }
    if (bt < 0 || btd > HEX_SIZE * 1.2) return none;
    return { ...none, kind: 'tile', tile: bt, faction: this.territory[bt] ?? -1, owner: this.owner[bt] ?? -1 };
  }

  setOverlays(o: Overlays): void {
    const changedT = o.territory !== this.overlays.territory || o.fronts !== this.overlays.fronts;
    const changedS = o.supply !== this.overlays.supply;
    const changedF = o.fog !== this.overlays.fog;
    this.overlays = { ...o };
    if (changedT) this.territoryDirty = true;
    if (changedS) this.supplyDirty = true;
    if (changedF) { if (o.fog < 0) this.fog = null; this.fogDirty = true; }
  }
}

export { FACTIONS, NEUTRAL };
