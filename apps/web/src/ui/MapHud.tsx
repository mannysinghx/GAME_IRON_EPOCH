import { useEffect, useRef, useState } from 'preact/hooks';
import { FACTIONS, STRUCTS, T, TERRAIN, UNITS } from '../shared/config.ts';
import { UF } from '../shared/protocol.ts';
import type { MomentView, PlanBeatView, UiSnapshot } from '../shared/protocol.ts';
import type { CameraMode, CameraPreset, MinimapData, Overlays } from '../render/api.ts';
import { BEAT_COLOR, BEAT_ICON, FRONTIER_CSS, fcss, momentStyle, num, pct, planText, realEta, signed, simDur, verdictText } from './format.ts';
import { FactionGlyph, Icon } from './icons.tsx';
import { store, useHover } from './store.ts';
import { camera } from './cameraBridge.ts';

export function MapHud({ ui }: { ui: UiSnapshot }) {
  return (
    <>
      <OpBanner ui={ui} />
      <div class="map-flashes">
        <Headline ui={ui} />
        <FrontierFlash ui={ui} />
      </div>
      <Toolbar />
      <Minimap ui={ui} />
      <Ticker ui={ui} />
      <CameraHud />
      <Tooltip ui={ui} />
      <div class="vignette" />
    </>
  );
}

function OpBanner({ ui }: { ui: UiSnapshot }) {
  const op = ui.operation ?? ui.nextOperation;
  if (!op) return null;
  const left = op.status === 'Open' ? op.lockTick - ui.clock.tick : op.status === 'Locked' ? op.startTick - ui.clock.tick : op.status === 'Running' ? op.endTick - ui.clock.tick : op.settleTick - ui.clock.tick;
  const scores = op.scores.slice().sort((a, b) => b.score - a.score);
  return (
    <div class={`op-banner st-${op.status.toLowerCase()}`} title="Operation camera (O)" onClick={() => camera.setMode('operation')}>
      <span class="ob-code mono">{op.code}</span>
      <span class="ob-name">{op.name}</span>
      <span class="ob-status">{op.status}</span>
      <span class="ob-time mono">{simDur(left)}</span>
      <span class="ob-scores">
        {scores.map((s) => {
          const c = ui.commanders.find((x) => x.id === s.id);
          return <span key={s.id} class="ob-score" style={{ '--fc': fcss(c?.faction ?? -1) }}><i />{c?.name ?? s.id} <b class="mono">{num(s.score)}</b></span>;
        })}
      </span>
    </div>
  );
}

const FLASH_MS = 9000;

/** Short-lived banner when frontier chunks open; clicking it frames the whole theatre. */
function FrontierFlash({ ui }: { ui: UiSnapshot }) {
  const at = store.frontierAt;
  const [, force] = useState(0);
  useEffect(() => {
    if (!at) return;
    const left = FLASH_MS - (performance.now() - at);
    if (left <= 0) return;
    const t = setTimeout(() => force((v) => v + 1), left + 30);
    return () => clearTimeout(t);
  }, [at]);
  const f = ui.frontier;
  if (!at || !f || performance.now() - at > FLASH_MS) return null;
  return (
    <div class="frontier-flash" role="status" onClick={() => camera.fit()} title="Frame the whole theatre (0)">
      <Icon name="expand" size={14} />
      <b>Frontier expanded</b>
      <span class="mono">+{store.newChunks.length} chunks · {f.open}/{f.total} open</span>
      {f.lastOpened.length > 0 && <em>{f.lastOpened.slice(0, 4).join(' · ')}</em>}
    </div>
  );
}

// ------------------------------------------------------------------ story headline
const HEADLINE_MS = 9000;
const HEADLINE_FRESH = 300; // ticks: only moments from the last simulated minute flash (none from before a reload)
let flashed = { world: '', id: 0 }; // module scope: survives HUD re-renders, resets with a new world

/** The strongest new headline-weight moment flashes over the map; clicking flies the camera there. */
function Headline({ ui }: { ui: UiSnapshot }) {
  const st = ui.story;
  const [cur, setCur] = useState<{ m: MomentView; at: number } | null>(null);
  useEffect(() => {
    if (!st) return;
    if (flashed.world !== ui.world.id) flashed = { world: ui.world.id, id: 0 };
    let best: MomentView | null = null, top = flashed.id;
    for (const m of st.moments) {
      top = Math.max(top, m.id);
      if (m.id <= flashed.id || m.weight < st.headline || ui.clock.tick - m.tick > HEADLINE_FRESH) continue;
      if (!best || m.weight > best.weight || (m.weight === best.weight && m.id > best.id)) best = m;
    }
    flashed.id = top;
    if (best) setCur({ m: best, at: performance.now() });
  });
  useEffect(() => {
    if (!cur) return;
    const t = setTimeout(() => setCur(null), HEADLINE_MS);
    return () => clearTimeout(t);
  }, [cur]);
  if (!cur) return null;
  const m = cur.m;
  const [label, color] = momentStyle(m.kind);
  const go = () => { if (m.tile >= 0) camera.focusTile(m.tile, 46); if (m.a[0] !== undefined) store.select(m.a[0]); };
  return (
    <div key={m.id} class="headline" role="status" style={{ '--mc': color }} onClick={go} title={m.tile >= 0 ? 'Fly the camera there and open the commander' : 'Open the commander'}>
      <span class="hl-chip">{label}</span>
      <span class="hl-text">{m.text}</span>
      {m.tile >= 0 && <span class="hl-go"><Icon name="target" size={12} /></span>}
      <span class="hl-bar" style={{ animationDuration: `${HEADLINE_MS}ms` }} />
    </div>
  );
}

type LayerKey ='territory' | 'fronts' | 'supply' | 'plans' | 'intents' | 'danger' | 'labels' | 'weather' | 'bloom' | 'shadows';

const MAP_LAYERS: { k: LayerKey; label: string; hint: string }[] = [
  { k: 'territory', label: 'Territory', hint: 'faction tint' },
  { k: 'fronts', label: 'Front lines', hint: 'borders, contested edges' },
  { k: 'supply', label: 'Supply network', hint: 'per-faction coverage' },
  { k: 'plans', label: 'Agent plan', hint: 'selected commander intent' },
  { k: 'intents', label: 'All intents', hint: 'every commander\'s announced target' },
  { k: 'danger', label: 'Agent memory', hint: 'route failures, danger' },
  { k: 'labels', label: 'Labels', hint: 'sites and commanders' },
  { k: 'weather', label: 'Weather', hint: 'published storms' },
];
const GFX_LAYERS: { k: LayerKey; label: string; hint: string }[] = [
  { k: 'bloom', label: 'Bloom', hint: 'glow on fire, fronts, beacons' },
  { k: 'shadows', label: 'Shadows', hint: 'dynamic sun shadows (GPU cost)' },
];

function Toolbar() {
  const o: Overlays = store.overlays;
  const cam = store.camera;
  const [open, setOpen] = useState(false);
  const onCount = MAP_LAYERS.filter((l) => o[l.k]).length;
  const camBtn = (m: CameraMode, icon: string, label: string, key: string) => (
    <button class={`tb ${cam === m ? 'on' : ''}`} title={`${label} camera (${key})`} onClick={() => camera.setMode(m)}><Icon name={icon} size={13} /><span>{label}</span></button>
  );
  const row = (l: { k: LayerKey; label: string; hint: string }) => (
    <label key={l.k} class="layer">
      <input type="checkbox" checked={o[l.k]} onChange={() => store.setOverlays({ [l.k]: !o[l.k] })} />
      <span class="sw" />
      <span class="ln">{l.label}<em>{l.hint}</em></span>
    </label>
  );
  return (
    <div class="toolbar">
      <div class="tb-group">
        {camBtn('free', 'hand', 'Free', 'G')}
        {camBtn('follow', 'follow', 'Follow', 'F')}
        {camBtn('operation', 'target', 'Op', 'O')}
        {camBtn('director', 'film', 'Director', 'D')}
      </div>
      <div class="tb-group">
        <span class="tb-label" title="Fog of war: see exactly what one faction's agents can observe (V)"><Icon name="eye" size={12} /></span>
        <button class={`tb ${o.fog < 0 ? 'on' : ''}`} onClick={() => store.setOverlays({ fog: -1 })} title="Spectator view (full map)">All</button>
        {FACTIONS.map((f) => (
          <button key={f.id} class={`tb fog ${o.fog === f.id ? 'on' : ''}`} style={{ '--fc': f.css }} onClick={() => store.setOverlays({ fog: o.fog === f.id ? -1 : f.id })} title={`View as ${f.name}: fog-filtered observations and last-known enemy positions`}>
            <FactionGlyph f={f.id} size={12} />
          </button>
        ))}
        <button class={`tb ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Map layers"><Icon name="layers" size={13} /><span>Layers</span><em class="mono">{onCount}</em></button>
      </div>
      {open && (
        <div class="layers-pop">
          <div class="lp-head">Map</div>
          {MAP_LAYERS.map(row)}
          <div class="lp-head">Graphics</div>
          {GFX_LAYERS.map(row)}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ minimap
// Draws from the renderer's minimap snapshot in world (x, z) space: theatre bounds plus a small margin of
// the endless land, north up. Locked chunks are dimmed and the open/locked edge is traced in amber.
const MM_MARGIN = 0.035;
const SQ3 = Math.sqrt(3);

// terrain colour lookup (3 bytes per terrain id), built once so the per-tile loop allocates nothing
const TERR_RGB = (() => {
  const a = new Uint8Array(256 * 3);
  const set = (t: number, r: number, g: number, b: number) => { a[t * 3] = r; a[t * 3 + 1] = g; a[t * 3 + 2] = b; };
  for (let t = 0; t < 256; t++) set(t, 35, 40, 48);
  set(T.RIVER, 18, 48, 74); set(T.CROSSING, 18, 48, 74); set(T.RIDGE, 58, 62, 70); set(T.FOREST, 29, 43, 37);
  set(T.MARSH, 32, 46, 46); set(T.ROAD, 48, 53, 61); set(T.RUIN, 46, 42, 39);
  return a;
})();
const FRGB = FACTIONS.map((f) => [(f.color >> 16) & 255, (f.color >> 8) & 255, f.color & 255] as const);
const MM_REPAINT_MS = 2000; // safety net: repaint tiles at least this often even if no array reference changed

interface MmView { ox: number; oz: number; s: number; W: number; H: number }

function Minimap({ ui }: { ui: UiSnapshot }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    const off = document.createElement('canvas');
    const octx = off.getContext('2d')!;
    let img: ImageData | null = null;
    let raf = 0, last = 0;
    let view: MmView | null = null;
    // the tile image only changes when territory or the frontier mask change; the renderer swaps in new arrays
    // for both (frame territory is a fresh worker copy, setFrontier slices), so reference equality detects it
    let pTerr: Uint8Array | null = null, pOwn: Int8Array | null = null, pAct: Uint8Array | null = null, pAt = 0;

    const paintTiles = (md: MinimapData, now: number) => {
      if (off.width !== md.w || off.height !== md.h) { off.width = md.w; off.height = md.h; img = null; } // resizing clears it
      if (img && md.terrain === pTerr && md.territory === pOwn && md.active === pAct && now - pAt < MM_REPAINT_MS) return;
      if (!img) img = octx.createImageData(md.w, md.h);
      const px = img.data, ter = md.terrain, own = md.territory, act = md.active;
      for (let t = 0, n = md.w * md.h; t < n; t++) {
        const q = ter[t] * 3;
        let r = TERR_RGB[q], g = TERR_RGB[q + 1], b = TERR_RGB[q + 2];
        const f = own[t];
        if (f >= 0 && f < FRGB.length) { const c = FRGB[f]; r = r * 0.45 + c[0] * 0.55; g = g * 0.45 + c[1] * 0.55; b = b * 0.45 + c[2] * 0.55; }
        if (!act[t]) { r *= 0.38; g *= 0.38; b *= 0.42; }
        const k = t * 4;
        px[k] = r; px[k + 1] = g; px[k + 2] = b; px[k + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      pTerr = ter; pOwn = own; pAct = act; pAt = now;
    };

    /**
     * Chunk edges where open land meets locked land are the live frontier (amber); where open land meets the
     * edge of the launch theatre, the boundary is final and drawn quietly.
     */
    const frontierEdges = (md: MinimapData, v: MmView) => {
      const ch = store.map?.chunk || 16;
      const cols = Math.ceil(md.w / ch), rows = Math.ceil(md.h / ch);
      const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < cols && j < rows;
      const open = (i: number, j: number) => inside(i, j) && !!md.active[Math.min(md.h - 1, j * ch + (ch >> 1)) * md.w + Math.min(md.w - 1, i * ch + (ch >> 1))];
      // chunk edges in world space: column edge c -> x = sqrt3 * (c - 0.25), row edge r -> z = 1.5 * r - 0.75
      const ex = (c: number) => v.ox + SQ3 * (c - 0.25) * v.s, ez = (rr: number) => v.oz + (1.5 * rr - 0.75) * v.s;
      const live = new Path2D(), rim = new Path2D();
      const seg = (i: number, j: number, x0: number, z0: number, x1: number, z1: number) => {
        if (open(i, j)) return;
        const p = inside(i, j) ? live : rim;
        p.moveTo(x0, z0); p.lineTo(x1, z1);
      };
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        if (!open(i, j)) continue;
        const x0 = ex(i * ch), x1 = ex(Math.min(md.w, (i + 1) * ch)), z0 = ez(j * ch), z1 = ez(Math.min(md.h, (j + 1) * ch));
        seg(i, j - 1, x0, z0, x1, z0);
        seg(i, j + 1, x0, z1, x1, z1);
        seg(i - 1, j, x0, z0, x0, z1);
        seg(i + 1, j, x1, z0, x1, z1);
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(160,175,200,0.35)';
      ctx.stroke(rim);
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = FRONTIER_CSS;
      ctx.shadowColor = FRONTIER_CSS; ctx.shadowBlur = 4;
      ctx.stroke(live);
      ctx.shadowBlur = 0;
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 140) return;
      last = now;
      const r = camera.renderer();
      if (!r) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const md = r.minimapData();
      if (!md.w || !md.h) return; // renderer up but no theatre yet (createImageData(0, 0) would throw)
      const b = r.theatreBounds();
      const bw = (b.maxX - b.minX) * (1 + 2 * MM_MARGIN), bh = (b.maxZ - b.minZ) * (1 + 2 * MM_MARGIN);
      const s = Math.min(W / bw, H / bh);
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      const v: MmView = { s, W, H, ox: W / 2 - cx * s, oz: H / 2 - cz * s };
      view = v;
      const X = (x: number) => v.ox + x * s, Z = (z: number) => v.oz + z * s;

      ctx.fillStyle = '#06080b';
      ctx.fillRect(0, 0, W, H);
      // tile image: column c spans x in [sqrt3 * (c - 0.25), sqrt3 * (c + 0.75)), row r spans z around 1.5 * r
      paintTiles(md, now);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, X(SQ3 * -0.25), Z(-0.75), md.w * SQ3 * s, md.h * 1.5 * s);
      frontierEdges(md, v);

      for (const st of md.structs) {
        const def = STRUCTS[st.kind];
        if (!def || (!def.capturable && st.kind !== 0)) continue;
        const [x, z] = r.tileXZ(st.tile);
        const sz = st.kind === 0 ? 3.6 : st.kind === 9 ? 3.2 : 2.2;
        ctx.fillStyle = st.faction >= 0 ? fcss(st.faction) : '#c8d0dc';
        ctx.fillRect(X(x) - sz / 2, Z(z) - sz / 2, sz, sz);
        if (st.kind === 0 || st.kind === 9) { ctx.strokeStyle = '#000'; ctx.lineWidth = 0.8; ctx.strokeRect(X(x) - sz / 2, Z(z) - sz / 2, sz, sz); }
      }
      for (const u of md.units) {
        ctx.fillStyle = fcss(u.faction);
        ctx.fillRect(X(u.x) - 0.9, Z(u.z) - 0.9, 1.8, 1.8);
      }
      if (md.opCenter >= 0 && md.opRadius > 0) {
        const [x, z] = r.tileXZ(md.opCenter);
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.arc(X(x), Z(z), (md.opRadius + 0.5) * SQ3 * s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const bt of md.battles.slice(0, 5)) {
        const [x, z] = r.tileXZ(bt.tile);
        ctx.strokeStyle = 'rgba(255,106,85,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(X(x), Z(z), 3 + (now / 200) % 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      const fp = r.viewFootprint();
      if (fp.length >= 3) {
        ctx.beginPath();
        fp.forEach(([x, z], i) => (i ? ctx.lineTo(X(x), Z(z)) : ctx.moveTo(X(x), Z(z))));
        ctx.closePath();
        ctx.fillStyle = 'rgba(230,235,242,0.07)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(230,235,242,0.92)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);

    // click or drag to fly the camera there (inverse of the draw transform)
    let dragging = false;
    const go = (e: PointerEvent) => {
      const v = view;
      if (!v) return;
      const rect = cv.getBoundingClientRect();
      camera.focusXZ((e.clientX - rect.left - v.ox) / v.s, (e.clientY - rect.top - v.oz) / v.s);
    };
    const down = (e: PointerEvent) => { dragging = true; cv.setPointerCapture(e.pointerId); go(e); };
    const move = (e: PointerEvent) => { if (dragging) go(e); };
    const up = (e: PointerEvent) => { dragging = false; if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId); };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    return () => {
      cancelAnimationFrame(raf);
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
    };
  }, []);
  const m = store.map;
  const f = ui.frontier;
  return (
    <div class="minimap" title="Click or drag to move the camera">
      <canvas ref={ref} />
      <span class="mm-label"><span class="mm-head">Theatre{m ? ` · ${m.w}×${m.h}` : ''}</span>{f ? <em>{f.open}/{f.total} open</em> : null}</span>
    </div>
  );
}

// ------------------------------------------------------------------ story ticker
type TickerItem =
  | { key: string; tick: number; kind: 'beat'; b: PlanBeatView; prior: PlanBeatView | null }
  | { key: string; tick: number; kind: 'verdict'; b: PlanBeatView }
  | { key: string; tick: number; kind: 'moment'; m: MomentView };

/** Newest story beats: plan announcements (with the verdict on the plan they replace) and moments. */
export function storyFeed(ui: UiSnapshot, n: number): TickerItem[] {
  const st = ui.story;
  if (!st) return [];
  const items: TickerItem[] = [];
  const verdicts = new Map<string, PlanBeatView>(); // `${cmd}:${tick}` → closed beat
  for (const b of st.beats) if (b.status !== 'active' && b.closed >= 0) verdicts.set(`${b.cmd}:${b.closed}`, b);
  for (const b of st.beats) {
    const k = `${b.cmd}:${b.tick}`;
    const prior = verdicts.get(k) ?? null;
    if (prior) verdicts.delete(k);
    items.push({ key: `b${b.id}`, tick: b.tick, kind: 'beat', b, prior });
  }
  for (const b of verdicts.values()) items.push({ key: `v${b.id}`, tick: b.closed, kind: 'verdict', b });
  for (const m of st.moments) items.push({ key: `m${m.id}`, tick: m.tick, kind: 'moment', m });
  // newest first; at equal ticks a moment outranks a routine plan beat
  return items.sort((a, b) => b.tick - a.tick || (a.kind === 'moment' ? -1 : 0) - (b.kind === 'moment' ? -1 : 0)).slice(0, n);
}

function Verdict({ b }: { b: PlanBeatView }) {
  const ok = b.status === 'success' || b.status === 'costly';
  return (
    <span class="tk-verdict" style={{ color: BEAT_COLOR[b.status] }}>
      {BEAT_ICON[b.status]} {b.status === 'aborted' ? `abandoned ${planText(b.kind, b.target)} (core fell)` : verdictText(b.kind, b.target, ok)}
      {b.reward !== null && <em class="mono"> {signed(b.reward, 2)}</em>}
    </span>
  );
}

export function TickerLine({ it }: { it: TickerItem }) {
  if (it.kind === 'moment') {
    const [label, color] = momentStyle(it.m.kind);
    return <><span class="tk-chip" style={{ '--mc': color }}>{label}</span><span class="tk-text">{it.m.text}</span></>;
  }
  const b = it.b;
  const who = <><i class="tk-dot" style={{ background: fcss(b.f) }} /><b>{b.name}</b> </>;
  if (it.kind === 'verdict') return <>{who}<Verdict b={b} /></>;
  return (
    <>
      {who}
      {it.prior && <><Verdict b={it.prior} /><span class="tk-arrow"> → </span></>}
      <span class="tk-commit">{b.explored ? 'tries' : 'commits to'} <b>{planText(b.kind, b.target)}</b></span>
      {b.alt && <em class="tk-alt"> over {planText(b.alt.kind, b.alt.target)} <span class="mono">{b.score.toFixed(2)}/{b.alt.score.toFixed(2)}</span></em>}
    </>
  );
}

function Ticker({ ui }: { ui: UiSnapshot }) {
  const lines = storyFeed(ui, 2);
  if (!lines.length) return null;
  return (
    <div class="ticker">
      {lines.map((it, i) => <div key={it.key} class={`tk ${i === 0 ? 'new' : 'old'}`}><TickerLine it={it} /></div>)}
    </div>
  );
}

// ------------------------------------------------------------------ camera HUD
const ROT_STEP = Math.PI / 8; // 22.5 degrees
const TILT_STEP = Math.PI / 24; // 7.5 degrees
const ZOOM_STEP = 1.3;

// Hold-to-repeat timers live at module scope: the HUD re-renders with every UI snapshot, and a timer kept in a
// per-render closure would survive its own pointerup and keep turning the camera.
let holdDelay = 0, holdRepeat = 0;
function stopHold(): void { clearTimeout(holdDelay); clearInterval(holdRepeat); holdDelay = holdRepeat = 0; }

/** Click = one step; hold = repeat after a short delay. Keyboard activation (detail 0) also steps once. */
function hold(fn: () => void) {
  return {
    onPointerDown: (e: PointerEvent) => { if (e.button !== 0) return; stopHold(); fn(); holdDelay = window.setTimeout(() => { holdRepeat = window.setInterval(fn, 110); }, 360); },
    onPointerUp: stopHold, onPointerLeave: stopHold, onPointerCancel: stopHold,
    onClick: (e: MouseEvent) => { if (e.detail === 0) fn(); },
  };
}

/** Nearest preset by pitch (renderer presets sit near 88°, 44° and 19°), for highlighting only. */
function presetOf(pitch: number): CameraPreset { return pitch > 1.15 ? 'top' : pitch < 0.55 ? 'low' : 'oblique'; }

function CameraHud() {
  const rose = useRef<HTMLSpanElement>(null);
  const tilt = useRef<HTMLSpanElement>(null);
  const presets = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // poll the camera every frame and touch only these DOM nodes, so the app never re-renders for it
    let raf = 0, yaw = NaN, pdeg = NaN, pre = '';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const r = camera.renderer();
      if (!r) return;
      const s = r.getCameraState();
      if (s.yaw !== yaw && rose.current) { yaw = s.yaw; rose.current.style.transform = `rotate(${-yaw}rad)`; }
      const d = Math.round((s.pitch * 180) / Math.PI);
      if (d !== pdeg && tilt.current) { pdeg = d; tilt.current.textContent = `${d}°`; }
      const p = presetOf(s.pitch);
      if (p !== pre && presets.current) {
        pre = p;
        for (const b of Array.from(presets.current.children) as HTMLElement[]) b.classList.toggle('on', b.dataset.p === p);
      }
    };
    raf = requestAnimationFrame(loop);
    window.addEventListener('blur', stopHold);
    return () => { cancelAnimationFrame(raf); stopHold(); window.removeEventListener('blur', stopHold); };
  }, []);
  const preset = (p: CameraPreset, label: string, hint: string) => (
    <button data-p={p} title={hint} onClick={() => camera.setPreset(p)}>{label}</button>
  );
  return (
    <div class="camhud" aria-label="Camera controls">
      <div class="ch-row">
        <button class="ch-btn" title="Rotate left 22.5° (Q, hold to keep turning)" {...hold(() => camera.rotateBy(-ROT_STEP, 0))}><Icon name="rotl" size={14} /></button>
        <button class="ch-compass" title="North up (N)" onClick={() => camera.resetNorth()}>
          <span class="ch-rose" ref={rose}>
            <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
              <circle cx="20" cy="20" r="17.5" class="cr-ring" />
              {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <line key={a} x1="20" y1="3.5" x2="20" y2={a % 90 ? 6 : 7.5} class="cr-tick" transform={`rotate(${a} 20 20)`} />)}
              <path d="M20 6.5 24 20h-8z" class="cr-n" />
              <path d="M20 33.5 16 20h8z" class="cr-s" />
              <circle cx="20" cy="20" r="2" class="cr-hub" />
              <text x="20" y="15.6" class="cr-label">N</text>
            </svg>
          </span>
        </button>
        <button class="ch-btn" title="Rotate right 22.5° (E, hold to keep turning)" {...hold(() => camera.rotateBy(ROT_STEP, 0))}><Icon name="rotr" size={14} /></button>
      </div>
      <div class="ch-row">
        <button class="ch-btn" title="Tilt toward top-down (Z)" {...hold(() => camera.rotateBy(0, TILT_STEP))}><Icon name="tiltu" size={14} /></button>
        <span class="ch-read mono" title="Camera tilt above the ground"><em>tilt</em><span ref={tilt} /></span>
        <button class="ch-btn" title="Tilt toward the horizon (C)" {...hold(() => camera.rotateBy(0, -TILT_STEP))}><Icon name="tiltd" size={14} /></button>
      </div>
      <div class="ch-row">
        <button class="ch-btn" title="Zoom out (−)" {...hold(() => camera.zoomBy(1 / ZOOM_STEP))}><Icon name="minus" size={14} /></button>
        <button class="ch-btn ch-fit" title="Fit the theatre (0)" onClick={() => camera.fit()}><Icon name="fit" size={13} /></button>
        <button class="ch-btn" title="Zoom in (+)" {...hold(() => camera.zoomBy(ZOOM_STEP))}><Icon name="plus" size={14} /></button>
      </div>
      <div class="ch-presets" ref={presets} role="group" aria-label="Camera presets">
        {preset('top', 'Top', 'Top-down view')}
        {preset('oblique', 'Obl', 'Oblique war-table view')}
        {preset('low', 'Low', 'Low cinematic view')}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ hover tooltip
function Tooltip({ ui }: { ui: UiSnapshot }) {
  useHover();
  const h = store.hover;
  const r = camera.renderer();
  if (!h || h.kind === 'none' || !r) return null;
  const c = ui.commanders.find((x) => x.id === h.owner);
  let body: preact.ComponentChildren = null;
  if (h.kind === 'unit') {
    const def = UNITS[h.cls];
    if (!def) return null;
    const flags = [h.flags & UF.RETREAT ? 'retreating' : '', h.flags & UF.COMBAT ? 'in combat' : '', h.flags & UF.SUPPLIED ? 'supplied' : 'out of supply', h.flags & UF.VETERAN ? 'veteran' : '', h.flags & UF.EVAC ? 'evacuating op zone' : ''].filter(Boolean).join(' · ');
    body = (
      <>
        <div class="tt-h"><i style={{ background: fcss(h.faction) }} />{def.name}<em>{c?.name ?? ''}</em></div>
        <div class="tt-grid">
          <span>Strength</span><b class="mono">{pct(h.hp)}</b>
          <span>Supply</span><b class="mono">{pct(h.supply)}</b>
          <span>Morale</span><b class="mono">{pct(h.morale)}</b>
          <span>Range/sight</span><b class="mono">{def.range}/{def.sight}</b>
        </div>
        <div class="tt-f">{flags}</div>
      </>
    );
  } else if (h.kind === 'struct') {
    const def = STRUCTS[h.structKind];
    if (!def) return null;
    const site = store.map?.sites.find((s) => s.id === h.id);
    body = (
      <>
        <div class="tt-h"><i style={{ background: fcss(h.faction) }} />{site?.name ?? def.name}<em>{h.faction >= 0 ? (c?.name ?? FACTIONS[h.faction].name) : 'neutral'}</em></div>
        <div class="tt-f">{def.name}{def.destructible ? ` · integrity ${pct(h.hp)}` : ' · capturable'}{def.supplyRadius ? ` · supply radius ${def.supplyRadius}` : ''}{def.sight ? ` · sight ${def.sight}` : ''}</div>
      </>
    );
  } else {
    // tile < 0 is ground beyond the launch theatre. The current renderer reports that as kind 'none' (no tooltip);
    // this branch lights up if it returns kind 'tile' with tile -1 for off-theatre ground hits.
    const m = store.map;
    const inside = !!m && h.tile >= 0 && h.tile < m.w * m.h;
    const tt = inside ? TERRAIN[m!.terrain[h.tile]] : null;
    const locked = inside && m!.active && !m!.active[h.tile];
    body = (
      <>
        <div class="tt-h"><i style={{ background: fcss(h.faction) }} />{tt?.name ?? 'Uncharted land'}<em>{locked ? 'locked frontier' : h.faction >= 0 ? (c?.name ?? FACTIONS[h.faction].name) : 'unclaimed'}</em></div>
        {tt && <div class="tt-f">move {tt.cost ? `${tt.cost / 10}×` : 'impassable'} · cover {tt.def}% · elevation {m!.elev[h.tile]}{tt.blocks ? ' · blocks sight' : ''}{locked ? ' · opens with a later frontier expansion' : ''}</div>}
        {!tt && <div class="tt-f">Scenery beyond the launch theatre: not simulated.</div>}
      </>
    );
  }
  const host = r.hostRect();
  const flipX = h.screenX > host.width - 300, flipY = h.screenY > host.height - 150;
  const style = { left: flipX ? undefined : `${h.screenX + 16}px`, right: flipX ? `${host.width - h.screenX + 12}px` : undefined, top: flipY ? undefined : `${h.screenY + 14}px`, bottom: flipY ? `${host.height - h.screenY + 10}px` : undefined };
  return <div class="tooltip" style={style}>{body}</div>;
}

export function eta(ticks: number, ui: UiSnapshot): string { return realEta(ticks, ui.speed, ui.paused); }
