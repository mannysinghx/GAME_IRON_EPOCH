import { useEffect, useRef, useState } from 'preact/hooks';
import { BattleRenderer } from '../render/renderer.ts';
import { Bottom, Chronicle } from './Bottom.tsx';
import { attachRenderer, camera } from './cameraBridge.ts';
import { Icon, LogoMark } from './icons.tsx';
import { Commanders, Diplomacy, Factions, LeftPanel, Schedule, Teams, Theatre } from './LeftPanel.tsx';
import { MapHud } from './MapHud.tsx';
import { DossierPanel, Operation, Predictions, RightPanel } from './RightPanel.tsx';
import { store, useStore, type MobileTab } from './store.ts';
import { TopBar } from './TopBar.tsx';

export function App() {
  const s = useStore();
  const host = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
  const [intro, setIntro] = useState(() => { try { return !localStorage.getItem('ie.intro.v1'); } catch { return true; } });

  useEffect(() => {
    let alive = true;
    const r = new BattleRenderer(host.current!);
    (async () => {
      await r.init();
      if (!alive) return;
      attachRenderer(r);
      r.onFps = (fps) => { store.fps = fps; };
      r.onPick = (p) => {
        if (p.kind === 'unit') { r.selectedUnit = p.id; if (p.owner >= 0) store.select(p.owner); }
        else if (p.kind === 'struct' && p.owner >= 0) { r.selectedUnit = -1; store.select(p.owner); }
        else r.selectedUnit = -1;
      };
      r.onHover = (p) => store.setHover(p);
      r.onCameraMode = (m) => { if (store.camera !== m) { store.camera = m; store.emit(); } };
      await document.fonts.ready.catch(() => undefined);
      store.onStatic = (m) => r.setStatic(m);
      store.onFrame = (f) => r.applyFrame(f);
      if (store.map) r.setStatic(store.map);
      store.start();
    })();
    return () => { alive = false; };
  }, []);

  // keep renderer in sync with spectator choices (never with agent decisions)
  useEffect(() => {
    const r = camera.renderer();
    if (!r) return;
    r.setOverlays(s.overlays);
    r.selectedOwner = s.selected;
    if (s.ui) {
      r.speed = s.ui.paused ? 0.5 : s.ui.speed;
      r.commanderNames.clear();
      for (const c of s.ui.commanders) r.commanderNames.set(c.id, { name: c.name, faction: c.faction, status: c.status });
      const op = s.ui.operation ?? s.ui.nextOperation;
      r.opInfo = op ? { code: op.code, status: op.status, center: op.regionCenter } : null;
      r.battles = s.ui.battles;
    }
    const d = s.dossier;
    r.plan = d && d.id === s.selected ? {
      owner: d.id, faction: d.faction, target: d.plan?.targetTile ?? -1, group: d.plan?.group ?? [],
      candidates: d.decisions[0]?.candidates.map((c) => ({ tile: c.tile, score: c.score, chosen: c.chosen })) ?? [], danger: d.dangerTiles,
    } : null;
  });

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const ui = store.ui;
      if (e.key === ' ') { e.preventDefault(); store.send({ type: 'pause', paused: !(ui?.paused ?? false) }); }
      else if (e.key >= '1' && e.key <= '6') store.send({ type: 'speed', speed: [1, 2, 4, 8, 16, 32][Number(e.key) - 1] });
      else if (e.key === 'f') camera.setMode('follow');
      else if (e.key === 'o') camera.setMode('operation');
      else if (e.key === 'd') camera.setMode('director');
      else if (e.key === 'g') camera.setMode('free');
      else if (e.key === '+' || e.key === '=') camera.zoomBy(1.25);
      else if (e.key === '-') camera.zoomBy(0.8);
      else if (e.key === '0') camera.fit();
      else if (e.key === 'v') store.setOverlays({ fog: store.overlays.fog >= 3 ? -1 : store.overlays.fog + 1 });
      else if (e.key === '?') setHelp((h) => !h);
      else if (e.key === 'Escape') { setHelp(false); setIntro(false); }
      else if ((e.key === ']' || e.key === '[') && ui) {
        const act = ui.commanders.filter((c) => c.status === 'active').sort((a, b) => a.id - b.id);
        const i = act.findIndex((c) => c.id === store.selected);
        const n = act[(i + (e.key === ']' ? 1 : act.length - 1)) % act.length];
        if (n) store.select(n.id);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const ui = s.ui;
  const dismissIntro = () => { setIntro(false); try { localStorage.setItem('ie.intro.v1', '1'); } catch { /* storage blocked */ } };
  return (
    <div class={`app mt-${s.mobileTab}`}>
      <TopBar ui={ui} onHelp={() => setHelp(true)} />
      <aside class="left">{ui && <LeftPanel ui={ui} />}</aside>
      <main class="center">
        <div class="map-wrap">
          <div class="map-host" ref={host} />
          {ui && <MapHud ui={ui} />}
          {!ui && <div class="boot"><LogoMark size={44} /><div>Generating a validated 64×64 theatre and mustering eight commanders…</div></div>}
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
      {intro && ui && <Intro onClose={dismissIntro} />}
      {help && <Help onClose={() => setHelp(false)} />}
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

function Intro({ onClose }: { onClose: () => void }) {
  return (
    <div class="modal-back" onClick={onClose}>
      <div class="modal intro" onClick={(e) => e.stopPropagation()}>
        <div class="intro-head"><LogoMark size={34} /><div><h1>IRON EPOCH</h1><p>An ongoing war fought entirely by autonomous AI commanders.</p></div></div>
        <ol class="intro-steps">
          <li><b>Watch.</b> The battle behind this card is already running. Every move, capture, alliance and recruitment is decided by agents, not by you.</li>
          <li><b>Read the record.</b> Open a commander's dossier: doctrine, current plan and the alternatives it rejected, memory, lineage, and separate world-power, skill and merit records.</li>
          <li><b>Predict.</b> You start with 1,000 free Signal credits. Stake on an operation before its market closes; settlement is pari-mutuel with a replayable receipt.</li>
          <li><b>Follow the story.</b> Commanders learn online from each plan's outcome, sponsor descendants, form teams, sign and break pacts at published windows, and fall into reserve.</li>
        </ol>
        <div class="intro-note">Private browser sandbox: the whole world runs in this tab and persists locally. Credits are nonredeemable and have no cash value. Human actions never change an army's decisions.</div>
        <button class="btn primary" onClick={onClose}>Start watching</button>
      </div>
    </div>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ['Space', 'Pause / resume'], ['1 – 6', 'Speed 1× … 32×'], ['F', 'Follow selected commander'], ['O', 'Operation camera'], ['D', 'Director camera (hottest battle)'],
    ['G', 'Free camera'], ['+ / −', 'Zoom'], ['0', 'Fit theatre'], ['[ / ]', 'Previous / next commander'], ['V', 'Cycle fog-of-war view'], ['Drag · wheel · pinch', 'Pan and zoom'], ['Double-click', 'Zoom to point'],
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
            <h3>Agents</h3>
            <p>Each commander runs a decision hierarchy: tactical rules every 200 ms tick, operational squad assignment every 3 s, and a strategic review every 60–120 s (or after major events, quota-limited). The strategic layer scores 4–8 legal candidate plans with a doctrine utility baseline plus a learned linear value head that updates online from each plan's realized reward. There is no language model and no remote inference.</p>
            <h3>Self-learning world</h3>
            <p>Three distinct mechanisms: bounded memory (route failures, opponent tendencies, plan outcomes), online value learning (new policy versions every 8 updates), and lineage (veteran sponsors pay merit for descendants with small, recorded doctrine mutations). Skill is measured separately in equal-budget proving-ground duels.</p>
            <h3>Fairness & honesty</h3>
            <p>Agents only observe their faction's fog-filtered view. Operation regions are sealed, seeds are committed with SHA-256 before markets open and revealed after settlement. The ledger is double-entry with idempotency keys; balances never go negative. This is a private browser sandbox, so its results are not official standings.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
