import { useEffect, useRef, useState } from 'preact/hooks';
import { FACTIONS, STRUCTS, TERRAIN, UNITS } from '../shared/config.ts';
import { UF } from '../shared/protocol.ts';
import type { UiSnapshot } from '../shared/protocol.ts';
import type { CameraMode } from '../render/renderer.ts';
import { fcss, num, pct, realEta, simDur } from './format.ts';
import { FactionGlyph, Icon } from './icons.tsx';
import { store, useHover } from './store.ts';
import { camera } from './cameraBridge.ts';

export function MapHud({ ui }: { ui: UiSnapshot }) {
  return (
    <>
      <OpBanner ui={ui} />
      <Toolbar />
      <Minimap />
      <Ticker ui={ui} />
      <ZoomControls />
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
    <div class={`op-banner st-${op.status.toLowerCase()}`} onClick={() => { camera.setMode('operation'); camera.focusTile(op.regionCenter, 1.3); }}>
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

function Toolbar() {
  const o = store.overlays;
  const cam = store.camera;
  const [open, setOpen] = useState(false);
  const layers: { k: 'territory' | 'fronts' | 'supply' | 'plans' | 'danger' | 'labels' | 'weather'; label: string; hint: string }[] = [
    { k: 'territory', label: 'Territory', hint: 'faction tint' },
    { k: 'fronts', label: 'Front lines', hint: 'borders, contested edges' },
    { k: 'supply', label: 'Supply network', hint: 'per-faction coverage' },
    { k: 'plans', label: 'Agent plan', hint: 'selected commander intent' },
    { k: 'danger', label: 'Agent memory', hint: 'route failures, danger' },
    { k: 'labels', label: 'Labels', hint: 'sites and commanders' },
    { k: 'weather', label: 'Weather', hint: 'published storms' },
  ];
  const onCount = layers.filter((l) => o[l.k]).length;
  const camBtn = (m: CameraMode, icon: string, label: string, key: string) => (
    <button class={`tb ${cam === m ? 'on' : ''}`} title={`${label} camera (${key})`} onClick={() => camera.setMode(m)}><Icon name={icon} size={13} /><span>{label}</span></button>
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
          {layers.map((l) => (
            <label key={l.k} class="layer">
              <input type="checkbox" checked={o[l.k]} onChange={() => store.setOverlays({ [l.k]: !o[l.k] })} />
              <span class="sw" />
              <span class="ln">{l.label}<em>{l.hint}</em></span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    let raf = 0, last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 120) return;
      last = now;
      const r = camera.renderer();
      if (!r || !r.ready) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = cv.clientWidth, H = cv.clientHeight;
      if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sx = W / r.worldW, sy = H / r.worldH;
      ctx.fillStyle = '#080b10';
      ctx.fillRect(0, 0, W, H);
      const n = r.px.length;
      const cw = Math.max(2, 31 * sx), ch = Math.max(2, 22 * sy);
      for (let t = 0; t < n; t++) {
        const tt = r.map.terrain[t];
        const f = r.territory[t];
        ctx.fillStyle = f >= 0 ? FACTIONS[f].css : tt === 6 || tt === 7 ? '#12304a' : tt === 2 ? '#3a3e46' : tt === 1 ? '#1d2b25' : '#232830';
        ctx.globalAlpha = f >= 0 ? 0.55 : 1;
        ctx.fillRect(r.px[t] * sx - cw / 2, r.py[t] * sy - ch / 2, cw, ch);
      }
      ctx.globalAlpha = 1;
      for (const s of r.structs.values()) {
        if (!STRUCTS[s.kind].capturable && s.kind !== 0) continue;
        ctx.fillStyle = s.faction >= 0 ? FACTIONS[s.faction].css : '#c8d0dc';
        const sz = s.kind === 0 ? 3.4 : 2.2;
        ctx.fillRect(s.x * sx - sz / 2, s.y * sy - sz / 2, sz, sz);
        if (s.kind === 0) { ctx.strokeStyle = '#000'; ctx.lineWidth = 0.8; ctx.strokeRect(s.x * sx - sz / 2, s.y * sy - sz / 2, sz, sz); }
      }
      for (const u of r.units.values()) {
        ctx.fillStyle = u.faction >= 0 ? FACTIONS[u.faction].css : '#fff';
        ctx.fillRect(u.x * sx - 0.9, u.y * sy - 0.9, 1.8, 1.8);
      }
      if (r.opRegion && r.opInfo) {
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.arc(r.px[r.opInfo.center] * sx, r.py[r.opInfo.center] * sy, 6.5 * 31 * sx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const b of r.battles.slice(0, 4)) {
        ctx.strokeStyle = 'rgba(255,106,85,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(r.px[b.tile] * sx, r.py[b.tile] * sy, 3 + (now / 200) % 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      const v = r.viewRect();
      ctx.strokeStyle = 'rgba(230,235,242,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(v.x * sx, v.y * sy, v.w * sx, v.h * sy);
    };
    raf = requestAnimationFrame(draw);
    const click = (e: MouseEvent) => {
      const r = camera.renderer();
      if (!r) return;
      const rect = cv.getBoundingClientRect();
      camera.setMode('free');
      r.focusWorld(((e.clientX - rect.left) / rect.width) * r.worldW, ((e.clientY - rect.top) / rect.height) * r.worldH);
    };
    cv.addEventListener('click', click);
    return () => { cancelAnimationFrame(raf); cv.removeEventListener('click', click); };
  }, []);
  return <div class="minimap"><canvas ref={ref} /><span class="mm-label">Theatre · 64×64</span></div>;
}

function Ticker({ ui }: { ui: UiSnapshot }) {
  const lines = ui.narrative.slice(-2).reverse();
  if (!lines.length) return null;
  return (
    <div class="ticker">
      {lines.map((l, i) => <div key={l + i} class={`tk ${i === 0 ? 'new' : 'old'}`}>{l}</div>)}
    </div>
  );
}

function ZoomControls() {
  return (
    <div class="zoomctl">
      <button title="Zoom in (+)" onClick={() => camera.zoomBy(1.3)}><Icon name="plus" size={13} /></button>
      <button title="Zoom out (-)" onClick={() => camera.zoomBy(1 / 1.3)}><Icon name="minus" size={13} /></button>
      <button title="Fit theatre" onClick={() => camera.fit()}><Icon name="fit" size={13} /></button>
    </div>
  );
}

function Tooltip({ ui }: { ui: UiSnapshot }) {
  useHover();
  const h = store.hover;
  const r = camera.renderer();
  if (!h || h.kind === 'none' || !r) return null;
  const c = ui.commanders.find((x) => x.id === h.owner);
  let body: preact.ComponentChildren = null;
  if (h.kind === 'unit') {
    const def = UNITS[h.cls];
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
    const site = store.map?.sites.find((s) => s.id === h.id);
    body = (
      <>
        <div class="tt-h"><i style={{ background: fcss(h.faction) }} />{site?.name ?? def.name}<em>{h.faction >= 0 ? (c?.name ?? FACTIONS[h.faction].name) : 'neutral'}</em></div>
        <div class="tt-f">{def.name}{def.destructible ? ` · integrity ${pct(h.hp)}` : ' · capturable'}{def.supplyRadius ? ` · supply radius ${def.supplyRadius}` : ''}{def.sight ? ` · sight ${def.sight}` : ''}</div>
      </>
    );
  } else {
    const tt = store.map ? TERRAIN[store.map.terrain[h.tile]] : null;
    body = (
      <>
        <div class="tt-h"><i style={{ background: fcss(h.faction) }} />{tt?.name ?? 'Tile'}<em>{h.faction >= 0 ? (c?.name ?? FACTIONS[h.faction].name) : 'unclaimed'}</em></div>
        {tt && <div class="tt-f">move {tt.cost ? `${tt.cost / 10}×` : 'impassable'} · cover {tt.def}% · elevation {store.map?.elev[h.tile]}{tt.blocks ? ' · blocks sight' : ''}</div>}
      </>
    );
  }
  const host = r.host.getBoundingClientRect();
  const flipX = h.screenX > host.width - 300, flipY = h.screenY > host.height - 150;
  const style = { left: flipX ? undefined : `${h.screenX + 16}px`, right: flipX ? `${host.width - h.screenX + 12}px` : undefined, top: flipY ? undefined : `${h.screenY + 14}px`, bottom: flipY ? `${host.height - h.screenY + 10}px` : undefined };
  return <div class="tooltip" style={style}>{body}</div>;
}

export function eta(ticks: number, ui: UiSnapshot): string { return realEta(ticks, ui.speed, ui.paused); }
