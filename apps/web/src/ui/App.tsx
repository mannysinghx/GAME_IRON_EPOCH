import { useEffect, useRef, useState } from 'preact/hooks';
import type { BattleView, Overlays } from '../render/api.ts';
import { ThreeRenderer } from '../render/three/ThreeRenderer.ts';
import { Bottom, Chronicle } from './Bottom.tsx';
import { attachRenderer, camera } from './cameraBridge.ts';
import { Icon, LogoMark } from './icons.tsx';
import { Commanders, Diplomacy, Factions, LeftPanel, Schedule, Teams, Theatre } from './LeftPanel.tsx';
import { MapHud } from './MapHud.tsx';
import { DossierPanel, Operation, Predictions, RightPanel } from './RightPanel.tsx';
import { store, useStore, type MobileTab } from './store.ts';
import { StrategyGuide } from './StrategyGuide.tsx';
import { TopBar } from './TopBar.tsx';

const STRATEGY_KEY = 'ie.strategy.seen.v1';

// held-key camera motion (per second): arrows pan a fraction of the camera distance, Q/E yaw, Z/C pitch
const PAN_RATE = 0.85;
const YAW_RATE = Math.PI / 2;
const PITCH_RATE = Math.PI / 5;
const HELD = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'q', 'e', 'z', 'c']);
const TAP_S = 0.12; // a single tap moves as much as this many seconds of holding

const INTRO_KEY = 'ie.intro.v1';
function saveIntroSeen(): void { try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* storage blocked */ } }

// toggles keep no keyboard of their own worth protecting: a focused (hidden) Layers checkbox must not swallow the
// map shortcuts. Text, number and range inputs do use the keys, so they still count as typing.
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);
function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export function App() {
  const s = useStore();
  const host = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
  const [guide, setGuide] = useState(false);
  const [intro, setIntro] = useState(() => { try { return !localStorage.getItem(INTRO_KEY); } catch { return true; } });
  const [guideSeen, setGuideSeen] = useState(() => { try { return !!localStorage.getItem(STRATEGY_KEY); } catch { return false; } });
  // while a dialog is open it owns the keyboard (scrolling, Escape); map shortcuts stand down
  const modalOpen = useRef(false);
  const introOpen = useRef(false); // the intro only shows once the first snapshot exists
  introOpen.current = intro && !!s.ui;
  modalOpen.current = help || guide || introOpen.current;
  const lastOverlays = useRef<Overlays | null>(null);

  const openGuide = () => {
    setHelp(false);
    setGuide(true);
    if (!guideSeen) { setGuideSeen(true); try { localStorage.setItem(STRATEGY_KEY, '1'); } catch { /* storage blocked */ } }
  };

  useEffect(() => {
    let alive = true, attached: BattleView | null = null;
    (async () => {
      let r: BattleView | null = null;
      try {
        const created: BattleView = new ThreeRenderer();
        r = created;
        await created.init(host.current!);
      } catch (e) {
        console.error('3D renderer failed to start', e);
        try { r?.dispose(); } catch { /* partially initialised; nothing else to release */ }
        r = null;
        if (alive) store.toast('err', `The 3D battlefield could not start (${e instanceof Error ? e.message : String(e)}). Panels, markets and dossiers keep working.`);
      }
      if (!alive) { r?.dispose(); return; }
      if (r) {
        const v = r;
        attached = v;
        v.onFps = (fps) => { store.fps = fps; };
        v.onPick = (p) => {
          if (p.kind === 'unit') { v.selectedUnit = p.id; if (p.owner >= 0) store.select(p.owner); }
          else if (p.kind === 'struct' && p.owner >= 0) { v.selectedUnit = -1; store.select(p.owner); }
          else v.selectedUnit = -1;
        };
        v.onHover = (p) => store.setHover(p);
        v.onCameraMode = (m) => { if (store.camera !== m) { store.camera = m; store.emit(); } };
        await document.fonts.ready.catch(() => undefined);
        if (!alive) return;
        attachRenderer(v);
        store.onStatic = (m) => v.setStatic(m);
        store.onFrame = (f) => v.applyFrame(f);
        store.onFrontier = (f) => v.setFrontier(f.active, f.sites, f.opened);
        // anything that arrived before the renderer was ready: static first, then the latest frontier
        if (store.map) v.setStatic(store.map);
        if (store.frontier) v.setFrontier(store.frontier.active, store.frontier.sites, store.frontier.opened);
        lastOverlays.current = null;
      }
      if (!store.worker) store.start();
      store.emit();
    })();
    return () => {
      alive = false;
      if (attached) {
        store.onStatic = () => {}; store.onFrame = () => {}; store.onFrontier = () => {};
        attachRenderer(null);
        attached.dispose();
      }
    };
  }, []);

  // keep the renderer in sync with spectator choices (never with agent decisions)
  useEffect(() => {
    const r = camera.renderer();
    if (!r) return;
    if (lastOverlays.current !== s.overlays) { lastOverlays.current = s.overlays; r.setOverlays(s.overlays); }
    r.selectedOwner = s.selected;
    if (s.ui) {
      r.speed = s.ui.paused ? 0.5 : s.ui.speed;
      r.commanderNames.clear();
      for (const c of s.ui.commanders) r.commanderNames.set(c.id, { name: c.name, faction: c.faction, status: c.status });
      const op = s.ui.operation ?? s.ui.nextOperation;
      r.opInfo = op ? { code: op.code, status: op.status, center: op.regionCenter, radius: op.radius } : null;
      r.battles = s.ui.battles;
    }
    const d = s.dossier;
    r.plan = d && d.id === s.selected ? {
      owner: d.id, faction: d.faction, target: d.plan?.targetTile ?? -1, group: d.plan?.group ?? [],
      candidates: d.decisions[0]?.candidates.map((c) => ({ tile: c.tile, score: c.score, chosen: c.chosen })) ?? [], danger: d.dangerTiles,
    } : null;
  });

  useEffect(() => {
    const held = new Set<string>();
    let raf = 0, last = 0;
    const move = (k: string, dt: number) => {
      const r = camera.renderer();
      if (!r) return;
      if (k.startsWith('Arrow')) {
        const p = r.getCameraState().distance * PAN_RATE * dt;
        camera.panBy(k === 'ArrowLeft' ? -p : k === 'ArrowRight' ? p : 0, k === 'ArrowUp' ? p : k === 'ArrowDown' ? -p : 0);
      } else if (k === 'q' || k === 'e') camera.rotateBy((k === 'q' ? -1 : 1) * YAW_RATE * dt, 0);
      else camera.rotateBy(0, (k === 'z' ? 1 : -1) * PITCH_RATE * dt);
    };
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      for (const k of held) move(k, dt);
      raf = held.size ? requestAnimationFrame(loop) : 0;
    };
    const press = (k: string) => {
      if (held.has(k)) return;
      held.add(k);
      move(k, TAP_S);
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
    };
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === 'Escape') {
        setHelp(false); setGuide(false);
        // Escape is a real dismissal of the visible intro (same as its button); before it shows, leave it pending
        if (introOpen.current) { setIntro(false); saveIntroSeen(); }
        return;
      }
      if (e.key === '?') { setGuide(false); setHelp((h) => !h); return; }
      if (modalOpen.current) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (HELD.has(k)) { e.preventDefault(); press(k); return; }
      const ui = store.ui;
      switch (k) {
        case ' ': {
          e.preventDefault();
          if (e.repeat) break; // holding Space must not flicker pause on and off
          // a focused button or toggle would also activate on Space; drop focus so the shortcut is the only action
          const tg = e.target as HTMLElement | null;
          if (tg && (tg.tagName === 'BUTTON' || tg.tagName === 'INPUT')) tg.blur();
          store.send({ type: 'pause', paused: !(ui?.paused ?? false) });
          break;
        }
        case '1': case '2': case '3': case '4': case '5': case '6': store.send({ type: 'speed', speed: [1, 2, 4, 8, 16, 32][Number(k) - 1] }); break;
        case 'f': camera.setMode('follow'); break;
        case 'o': camera.setMode('operation'); break;
        case 'd': camera.setMode('director'); break;
        case 'g': camera.setMode('free'); break;
        case '+': case '=': camera.zoomBy(1.25); break;
        case '-': case '_': camera.zoomBy(0.8); break;
        case '0': camera.fit(); break;
        case 'n': camera.resetNorth(); break;
        case 'v': store.setOverlays({ fog: store.overlays.fog >= 3 ? -1 : store.overlays.fog + 1 }); break;
        case '[': case ']': {
          if (!ui) break;
          const act = ui.commanders.filter((c) => c.status === 'active').sort((a, b) => a.id - b.id);
          const i = act.findIndex((c) => c.id === store.selected);
          const n = act[(i + (k === ']' ? 1 : act.length - 1)) % act.length];
          if (n) store.select(n.id);
          break;
        }
      }
    };
    const up = (e: KeyboardEvent) => { held.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); };
    const reset = () => held.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', reset);
      cancelAnimationFrame(raf);
    };
  }, []);

  const ui = s.ui;
  const dismissIntro = () => { setIntro(false); saveIntroSeen(); };
  return (
    <div class={`app mt-${s.mobileTab}`}>
      <TopBar ui={ui} onHelp={() => { setGuide(false); setHelp(true); }} onStrategy={openGuide} strategySeen={guideSeen} />
      <aside class="left">{ui && <LeftPanel ui={ui} />}</aside>
      <main class="center">
        <div class="map-wrap">
          <div class="map-host" ref={host} />
          {ui && <MapHud ui={ui} />}
          {!ui && <div class="boot"><LogoMark size={44} /><div>Generating a validated theatre and mustering the first commanders…</div></div>}
        </div>
        {ui && <div class="bottom-wrap"><Bottom ui={ui} /></div>}
      </main>
      <aside class="right">{ui && <RightPanel ui={ui} />}</aside>
      {ui && <MobileSheet ui={ui} tab={s.mobileTab} />}
      <nav class="mobile-tabs">
        {(['map', 'theatre', 'commanders', 'operation', 'predict', 'dossier', 'chronicle'] as MobileTab[]).map((t) => (
          <button key={t} class={s.mobileTab === t ? 'on' : ''} onClick={() => { store.mobileTab = t; store.emit(); }}>{t}</button>
        ))}
      </nav>
      <div class="toasts">
        {s.toasts.map((t) => <div key={t.id} class={`toast t-${t.level}`}>{t.text}</div>)}
      </div>
      {intro && ui && <Intro onClose={dismissIntro} onGuide={() => { dismissIntro(); openGuide(); }} />}
      {help && <Help onClose={() => setHelp(false)} onGuide={openGuide} />}
      {guide && <StrategyGuide ui={ui} onClose={() => setGuide(false)} />}
    </div>
  );
}

function MobileSheet({ ui, tab }: { ui: NonNullable<typeof store.ui>; tab: MobileTab }) {
  if (tab === 'map') return null;
  return (
    <div class="mobile-sheet">
      {tab === 'theatre' && <><Theatre ui={ui} /><Factions ui={ui} /><Diplomacy ui={ui} /><Schedule ui={ui} /></>}
      {tab === 'commanders' && <><Commanders ui={ui} /><Teams ui={ui} /></>}
      {tab === 'operation' && <Operation ui={ui} />}
      {tab === 'predict' && <Predictions ui={ui} />}
      {tab === 'dossier' && <DossierPanel ui={ui} d={store.dossier} />}
      {tab === 'chronicle' && <Chronicle ui={ui} />}
    </div>
  );
}

function Intro({ onClose, onGuide }: { onClose: () => void; onGuide: () => void }) {
  return (
    <div class="modal-back" onClick={onClose}>
      <div class="modal intro" onClick={(e) => e.stopPropagation()}>
        <div class="intro-head"><LogoMark size={34} /><div><h1>IRON EPOCH</h1><p>An ongoing war fought entirely by autonomous AI commanders.</p></div></div>
        <ol class="intro-steps">
          <li><b>Watch.</b> The battle behind this card is already running in 3D. Fly the camera anywhere: drag to pan, right-drag to rotate, wheel to zoom. Every move, capture, alliance and recruitment is decided by agents, not by you.</li>
          <li><b>Read the record.</b> Open a commander's dossier: doctrine, current plan and the alternatives it rejected, memory, lineage, and separate world-power, skill and merit records.</li>
          <li><b>Predict.</b> You start with 1,000 free Signal credits. Stake on an operation before its market closes; settlement is pari-mutuel with a replayable receipt.</li>
          <li><b>Follow the story.</b> Commanders learn online from each plan's outcome, sponsor descendants, form teams, sign and break pacts, and fall into reserve, while the frontier keeps opening new land.</li>
        </ol>
        <div class="intro-note">Private browser sandbox: the whole world runs in this tab and persists locally. Credits are nonredeemable and have no cash value. Human actions never change an army's decisions.</div>
        <div class="btn-row intro-btns">
          <button class="btn primary" onClick={onClose}>Start watching</button>
          <button class="btn strategy-inline" onClick={onGuide}><Icon name="bulb" size={13} /> Read the game strategy</button>
        </div>
      </div>
    </div>
  );
}

function Help({ onClose, onGuide }: { onClose: () => void; onGuide: () => void }) {
  const keys: [string, string][] = [
    ['Drag', 'Pan the map'], ['Right-drag · Shift-drag', 'Rotate and tilt'], ['Wheel · pinch', 'Zoom'], ['Double-click', 'Fly to point'],
    ['← ↑ → ↓', 'Pan'], ['Q / E', 'Rotate left / right'], ['Z / C', 'Tilt up / down'], ['+ / −', 'Zoom in / out'], ['0', 'Fit theatre'], ['N', 'North up'],
    ['F', 'Follow selected commander'], ['O', 'Operation camera'], ['D', 'Director camera (hottest battle)'], ['G', 'Free camera'],
    ['Space', 'Pause / resume'], ['1 – 6', 'Speed 1× … 32×'], ['[ / ]', 'Previous / next commander'], ['V', 'Cycle fog-of-war view'], ['?', 'Toggle this help'],
  ];
  return (
    <div class="modal-back" onClick={onClose}>
      <div class="modal help" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head"><h2>How IRON EPOCH works</h2><button class="icon-btn" onClick={onClose}><Icon name="close" /></button></div>
        <div class="help-grid">
          <div>
            <h3>Shortcuts</h3>
            {keys.map(([k, v]) => <div class="kv" key={k}><span class="k"><kbd>{k}</kbd></span><span class="v">{v}</span></div>)}
          </div>
          <div class="help-text">
            <h3>3D battlefield</h3>
            <p>The theatre is fully three-dimensional. Pan, rotate, tilt and zoom freely, from top-down to ground level; the camera dial at the bottom right shows north (click it to face north) and switches between top, oblique and low views. The land continues forever past the theatre as uncharted scenery that is not simulated.</p>
            <h3>Expanding frontier</h3>
            <p>The world opens at 64 × 64 hexes. Every 20 simulated minutes one chunk per quadrant unlocks, mirrored for balance, until the 128 × 128 launch theatre is open. Locked land sits behind an amber boundary; each unlock adds sites and room for more commanders.</p>
            <h3>Agents</h3>
            <p>Each commander runs a decision hierarchy: tactical rules every 200 ms tick, operational squad assignment every 3 s, and a strategic review every 60–120 s (or after major events, quota-limited). The strategic layer scores 4–8 legal candidate plans with a doctrine utility baseline plus a learned linear value head that updates online from each plan's advantage over the commander's own average, shared across its faction. In paired tests it measurably improves the sites and territory a commander holds. There is no language model and no remote inference.</p>
            <h3>Self-learning world</h3>
            <p>Three distinct mechanisms: bounded memory (route failures, opponent tendencies, plan outcomes), online value learning (new policy versions every 8 updates), and lineage (veteran sponsors pay merit for descendants with small, recorded doctrine mutations). Skill is measured separately in equal-budget proving-ground duels.</p>
            <h3>Fairness & honesty</h3>
            <p>Agents only observe their faction's fog-filtered view. Operation regions are sealed, seeds are committed with SHA-256 before markets open and revealed after settlement. The ledger is double-entry with idempotency keys; balances never go negative. This is a private browser sandbox, so its results are not official standings.</p>
            <button class="btn strategy-inline" onClick={onGuide}><Icon name="bulb" size={13} /> Open the full game strategy guide</button>
          </div>
        </div>
      </div>
    </div>
  );
}
