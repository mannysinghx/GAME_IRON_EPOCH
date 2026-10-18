import type { UiSnapshot } from '../shared/protocol.ts';
import { num, simClock } from './format.ts';
import { Icon, LogoMark } from './icons.tsx';
import { roman } from './LeftPanel.tsx';
import { store } from './store.ts';

const SPEEDS = [1, 2, 4, 8, 16, 32];

export function TopBar({ ui, onHelp }: { ui: UiSnapshot | null; onHelp: () => void }) {
  const paused = ui?.paused ?? false;
  const speed = ui?.speed ?? 2;
  const op = ui?.operation ?? ui?.nextOperation ?? null;
  return (
    <header class="topbar">
      <div class="brand">
        <LogoMark />
        <div>
          <div class="brand-name">IRON EPOCH</div>
          <div class="brand-sub">Autonomous AI war · private sandbox</div>
        </div>
      </div>
      <div class={`live ${paused ? 'paused' : ''}`}><i />{paused ? 'PAUSED' : 'LIVE'}</div>
      {ui && (
        <div class="clock">
          <span class="clk-seg">CH {roman(ui.clock.chapter)}</span>
          <span class="clk-seg">CAMPAIGN {ui.clock.campaign}</span>
          {op && <span class="clk-seg op">{op.code} · {op.status.toUpperCase()}</span>}
          <span class="clk-time mono">T+{simClock(ui.clock.tick)}</span>
        </div>
      )}
      <div class="speed" role="group" aria-label="Playback speed">
        <button class={paused ? 'on' : ''} title="Pause (Space)" onClick={() => store.send({ type: 'pause', paused: !paused })}><Icon name={paused ? 'play' : 'pause'} size={12} /></button>
        {SPEEDS.map((s, i) => (
          <button key={s} class={!paused && speed === s ? 'on' : ''} title={`${s}× simulation speed (${i + 1})`} onClick={() => store.send({ type: 'speed', speed: s })}>{s}×</button>
        ))}
      </div>
      <div class="top-right">
        {ui && (
          <>
            <div class="tr-item" title="Committed tick and rolling state hash"><span>tick</span><b class="mono">{num(ui.clock.tick)}</b><em class="mono">{ui.perf.stateHash}</em></div>
            <div class="tr-item" title="Simulation ticks per second vs target / render frames per second"><span>sim</span><b class="mono" style={{ color: ui.perf.lagging ? '#ff5d5d' : undefined }}>{ui.perf.tps}/{ui.perf.targetTps}</b><em class="mono">{store.fps.toFixed(0)} fps</em></div>
            <div class="tr-item wallet-chip" title="Signal credits: nonredeemable, no cash value"><span>◈</span><b class="mono">{num(ui.wallet.available)}</b><em class="mono">{ui.wallet.escrow ? `${num(ui.wallet.escrow)} escrow` : 'signal'}</em></div>
          </>
        )}
        <button class="icon-btn" title="About & shortcuts (?)" onClick={onHelp}><Icon name="help" /></button>
      </div>
    </header>
  );
}
