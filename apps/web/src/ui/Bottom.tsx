import { useState } from 'preact/hooks';
import { FACTIONS } from '../shared/config.ts';
import type { UiSnapshot } from '../shared/protocol.ts';
import { Bar, Gauge, Lines, StackArea } from './charts.tsx';
import { CAT_COLORS, compact, fcss, kindText, momentStyle, num, pct, planParts, planText, signed, simClock, simDur } from './format.ts';
import { Icon } from './icons.tsx';
import { Empty, Pill, Tabs } from './primitives.tsx';
import { store, type BottomTab } from './store.ts';
import { camera } from './cameraBridge.ts';

const FCOLORS = FACTIONS.map((f) => f.css);

export function Bottom({ ui }: { ui: UiSnapshot }) {
  const tab = store.bottomTab;
  return (
    <div class="bottom">
      <div class="bottom-tabs">
        <Tabs<BottomTab> value={tab} onChange={(v) => { store.bottomTab = v; store.emit(); }} options={[
          { id: 'chronicle', label: <>Chronicle <em class="mono">{compact(ui.world.events)}</em></> },
          { id: 'story', label: <>Story <em class="mono">{compact(ui.story?.stats.moments ?? 0)}</em></> },
          { id: 'analytics', label: 'Analytics' },
          { id: 'proving', label: <>Proving ground <em class="mono">{ui.proving.matches}</em></> },
          { id: 'engine', label: 'Engine' },
          { id: 'ledger', label: <>Ledger {ui.ledger.balanced ? <em class="ok">✓</em> : <em class="bad">!</em>}</> },
        ]} />
      </div>
      <div class="bottom-body">
        {tab === 'chronicle' && <Chronicle ui={ui} />}
        {tab === 'story' && <StoryTab ui={ui} />}
        {tab === 'analytics' && <Analytics ui={ui} />}
        {tab === 'proving' && <Proving ui={ui} />}
        {tab === 'engine' && <Engine ui={ui} />}
        {tab === 'ledger' && <LedgerTab ui={ui} />}
      </div>
    </div>
  );
}

const CATS = ['all', 'story', 'battle', 'territory', 'frontier', 'ops', 'market', 'lineage', 'diplomacy', 'team', 'policy', 'eval', 'build', 'chapter'];

// ------------------------------------------------------------------ story
/** Plan board (every active commander's announced intent) with plan outcomes by kind, and the moment feed. */
export function StoryTab({ ui }: { ui: UiSnapshot }) {
  const st = ui.story;
  if (!st) return <Empty>The story layer runs in the shared world only.</Empty>;
  const t = ui.clock.tick;
  const board = ui.commanders.filter((c) => c.status === 'active' && c.plan).sort((a, b) => b.plan!.started - a.plan!.started || a.id - b.id);
  const rate = st.stats.closed ? st.stats.won / st.stats.closed : 0;
  const kinds = st.kinds.filter((k) => k.n > 0).sort((a, b) => b.n - a.n);
  return (
    <div class="story">
      <div class="st-col">
        <div class="cc-head">Plan board <span class="dim">{board.length} live · newest first · verdict at next review</span></div>
        <div class="st-stats" title="Closed plans by kind: share whose objective was met with a positive reward (sample size after the dot)">
          <span class="mono"><b>{num(st.stats.announced)}</b> announced</span>
          <span class="mono"><b>{pct(rate)}</b> ✔ of {num(st.stats.closed)}</span>
          {kinds.map((k) => (
            <span key={k.kind} class="ok-chip" style={{ '--okc': k.won / k.n >= 0.5 ? '#7ee2a8' : '#ffb547' }}>{kindText(k.kind)} <b class="mono">{pct(k.won / k.n)}</b><em class="mono">·{k.n}</em></span>
          ))}
        </div>
        <div class="pb-h"><span>Commander</span><span>Committed to</span><span>Review</span><span>Record</span></div>
        <div class="st-scroll">
          {board.map((c) => {
            const p = c.plan!;
            const streak = c.rec.streak;
            const [verb, object] = planParts(p.kind, p.target);
            return (
              <div class={`pb-row ${store.selected === c.id ? 'sel' : ''}`} key={c.id} onClick={() => { store.select(c.id); camera.focusTile(p.targetTile); }}
                title={`${p.reason}${p.explored ? ' · exploratory pick' : ''} · score ${p.score.toFixed(2)}${p.alt ? ` vs ${p.alt.score.toFixed(2)}` : ''} · committed ${simDur(t - p.started)} ago`}>
                <span class="pb-name"><i style={{ background: fcss(c.faction) }} />{c.name}</span>
                <span class="pb-plan"><b>{verb}</b> {object}{p.explored && <em class="pb-x">explore</em>}{p.alt && <em class="pb-alt"> · over {planText(p.alt.kind, p.alt.target)} <span class="mono">{signed(p.score - p.alt.score, 2)}</span></em>}</span>
                <span class="mono">{simDur(Math.max(0, p.reviewAt - t))}</span>
                <span class="mono">{c.rec.won}/{c.rec.closed}{streak >= 3 ? <em class="pos"> ▲{streak}</em> : streak <= -3 ? <em class="neg"> ▼{-streak}</em> : null}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div class="st-col">
        <div class="cc-head">Moments <span class="dim">{st.stats.moments} detected · {st.stats.named} named rivalries · bar = weight</span></div>
        <div class="st-scroll">
          {st.moments.length === 0 ? <Empty>Moments appear as the war produces them: core falls, last stands, sites that keep changing hands, upsets, comebacks, streaks and rivalries.</Empty> : st.moments.map((m) => {
            const [label, color] = momentStyle(m.kind);
            return (
              <div class="mo-row" key={m.id} onClick={() => { if (m.tile >= 0) camera.focusTile(m.tile); if (m.a[0] !== undefined) store.select(m.a[0]); }}>
                <span class="mono dim">{simClock(m.tick)}</span>
                <span class="mo-chip" style={{ '--mc': color }} title={`weight ${m.weight}`}>{label}<i style={{ width: `${m.weight}%` }} /></span>
                <span class="mo-text" title={m.text}>{m.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function Chronicle({ ui }: { ui: UiSnapshot }) {
  const f = store.chronFilter, q = store.chronSearch.toLowerCase();
  const list = store.chronicle.filter((e) => (f === 'all' || e.cat === f) && (!q || e.text.toLowerCase().includes(q))).slice(-220).reverse();
  return (
    <div class="chron">
      <div class="chron-bar">
        <div class="chips">
          {CATS.map((c) => <button key={c} class={`chip ${f === c ? 'on' : ''}`} style={c !== 'all' ? { '--cc': CAT_COLORS[c] } : undefined} onClick={() => { store.chronFilter = c; store.emit(); }}>{c}</button>)}
        </div>
        <label class="search"><Icon name="search" size={12} /><input placeholder="Search history" value={store.chronSearch} onInput={(e) => { store.chronSearch = (e.target as HTMLInputElement).value; store.emit(); }} /></label>
      </div>
      <div class="chron-list">
        {list.length === 0 ? <Empty>No events match.</Empty> : list.map((e) => (
          <div key={e.id} class="ev" onClick={() => { if (e.tile >= 0) camera.focusTile(e.tile); if (e.a[0] !== undefined) store.select(e.a[0]); }}>
            <span class="mono dim">{simClock(e.tick)}</span>
            <span class="ev-cat" style={{ '--cc': CAT_COLORS[e.cat] ?? '#8a93a2' }}>{e.cat}</span>
            {e.f >= 0 && <i class="dot" style={{ background: fcss(e.f) }} />}
            <span class="ev-text">{e.text}</span>
          </div>
        ))}
      </div>
      <div class="chron-foot dim">{ui.world.events} events recorded · history is append-only; defeats and retirements are never erased</div>
    </div>
  );
}

export function Analytics({ ui }: { ui: UiSnapshot }) {
  const s = store.series;
  const eloIds = Object.keys(s?.elo ?? {}).map(Number);
  const eloSeries = eloIds.map((id) => s!.elo[id]);
  const eloColors = eloIds.map((id) => fcss(ui.commanders.find((c) => c.id === id)?.faction ?? -1));
  return (
    <div class="analytics">
      <div class="chart-card">
        <div class="cc-head">Territory share <span class="dim">stacked · 30 s samples</span></div>
        <StackArea series={s ? s.territory : [[]]} colors={FCOLORS} h={118} labels={FACTIONS.map((f) => f.name)} />
        <Legend />
      </div>
      <div class="chart-card">
        <div class="cc-head">World power <span class="dim">per faction</span></div>
        <Lines series={s ? s.power : [[]]} colors={FCOLORS} h={118} min={0} />
        <Legend />
      </div>
      <div class="chart-card">
        <div class="cc-head">Learning curve <span class="dim">mean |prediction error| · reward EMA (dashed)</span></div>
        <Lines series={s ? [s.learnErr, s.reward.map((r) => (r + 1) / 2)] : [[]]} colors={['#9aa7ff', '#7ee2a8']} dashed={[false, true]} h={118} min={0} max={1} />
        <div class="legend"><span><i style={{ background: '#9aa7ff' }} />error</span><span><i style={{ background: '#7ee2a8' }} />reward (rescaled)</span></div>
      </div>
      <div class="chart-card">
        <div class="cc-head">Skill ratings <span class="dim">Elo, equal-budget duels only</span></div>
        <Lines series={eloSeries.length ? eloSeries : [[]]} colors={eloColors.length ? eloColors : ['#8a93a2']} h={118} />
        <div class="legend">{ui.commanders.filter((c) => c.evalGames > 0).slice(0, 6).map((c) => <span key={c.id}><i style={{ background: fcss(c.faction) }} />{c.name} {c.elo}</span>)}</div>
      </div>
    </div>
  );
}

function Legend() {
  return <div class="legend">{FACTIONS.map((f) => <span key={f.id}><i style={{ background: f.css }} />{f.name}</span>)}</div>;
}

export function Proving({ ui }: { ui: UiSnapshot }) {
  const ranked = ui.commanders.filter((c) => c.evalGames > 0).sort((a, b) => b.elo - a.elo);
  const nm = (id: number) => ui.commanders.find((c) => c.id === id);
  return (
    <div class="proving">
      <div class="pv-left">
        <div class="cc-head">Equal-budget ratings <span class="dim">{ui.proving.running ? 'duel running…' : 'idle'} · frozen policies · mirrored arena · sides swapped</span></div>
        <div class="pv-table">
          <div class="pv-h"><span>Commander</span><span>Elo</span><span>Games</span><span>Win rate (95% CI)</span></div>
          {ranked.length === 0 ? <Empty>The proving ground starts after the first strategic reviews.</Empty> : ranked.map((c) => (
            <div class="pv-row" key={c.id} onClick={() => store.select(c.id)}>
              <span><i class="dot" style={{ background: fcss(c.faction) }} /> {c.name} {c.provisional && <Pill tone="warn">provisional</Pill>}</span>
              <span class="mono">{c.elo}</span>
              <span class="mono">{c.evalGames}</span>
              <span class="ci"><span class="ci-track"><span class="ci-range" style={{ left: `${c.winLo * 100}%`, width: `${(c.winHi - c.winLo) * 100}%`, background: fcss(c.faction) }} /><span class="ci-pt" style={{ left: `${c.winRate * 100}%` }} /></span><em class="mono">{pct(c.winRate)}</em></span>
            </div>
          ))}
        </div>
      </div>
      <div class="pv-right">
        <div class="cc-head">Recent duels</div>
        {ui.proving.recent.length === 0 ? <Empty>No duels yet.</Empty> : ui.proving.recent.map((m) => {
          const a = nm(m.a), b = nm(m.b);
          return (
            <div class="duel" key={m.id}>
              <span class="mono dim">#{m.id}</span>
              <span class={m.result === 'a' ? 'win' : ''}>{a?.name ?? m.a}</span>
              <span class="mono">{m.scoreA}–{m.scoreB}</span>
              <span class={m.result === 'b' ? 'win' : ''}>{b?.name ?? m.b}</span>
              <span class="dim mono">{m.swapped ? 'swap' : 'std'} · {m.ticks}t</span>
            </div>
          );
        })}
        <div class="foot-note">A single spectacular battle is a highlight, not a benchmark. Superiority claims need many paired games; intervals shown are Wilson 95%.</div>
      </div>
    </div>
  );
}

export function Engine({ ui }: { ui: UiSnapshot }) {
  const p = ui.perf;
  const [seed, setSeed] = useState('');
  return (
    <div class="engine">
      <div class="eng-col">
        <div class="cc-head">Tick budget <span class="dim">200 ms per tick at 5 Hz</span></div>
        <Gauge label="p50" value={p.tickP50} budget={200} />
        <Gauge label="p95 (target < 100)" value={p.tickP95} budget={200} />
        <Gauge label="p99 (target < 150)" value={p.tickP99} budget={200} />
        <div class="kvs">
          <span>Ticks/s</span><b class="mono" style={{ color: p.lagging ? '#ff5d5d' : undefined }}>{p.tps} / {p.targetTps}{p.lagging ? ' lag' : ''}</b>
          <span>Render FPS</span><b class="mono">{store.fps.toFixed(0)}</b>
          <span>Visibility</span><b class="mono">{p.visMs.toFixed(2)} ms</b>
          <span>Agents</span><b class="mono">{p.agentMs.toFixed(2)} ms</b>
        </div>
      </div>
      <div class="eng-col">
        <div class="cc-head">Bounded systems</div>
        <div class="kvs">
          <span>Entities</span><b class="mono">{num(p.entities)}</b>
          <span>Flow fields</span><b class="mono">{p.flowFields} cached</b>
          <span>Cache hit</span><b class="mono">{pct(p.flowHits / Math.max(1, p.flowHits + p.flowMisses))}</b>
          <span>Memory facts</span><b class="mono">{p.memoryFacts}</b>
          <span>Decisions</span><b class="mono">{num(p.decisions)}</b>
          <span>Frame payload</span><b class="mono">{(p.frameBytes / 1024).toFixed(1)} KB</b>
        </div>
      </div>
      <div class="eng-col">
        <div class="cc-head">Durability & determinism</div>
        <div class="kvs">
          <span>State hash</span><b class="mono">{p.stateHash}</b>
          <span>Last snapshot</span><b class="mono">tick {num(p.lastSaveTick)}</b>
          <span>Snapshot size</span><b class="mono">{(p.saveBytes / 1024).toFixed(0)} KB</b>
          <span>World</span><b class="mono">{ui.world.id}</b>
          <span>Rules</span><b class="mono">{ui.world.rules}</b>
        </div>
        <div class="hash-hist mono dim">{p.hashHist.slice(-5).map((h) => `${h.tick}:${h.hash.slice(0, 6)}`).join('  ')}</div>
        <div class="btn-row">
          <button class="btn sm" onClick={() => store.send({ type: 'save' })}><Icon name="save" size={12} /> Save snapshot</button>
          <input class="seed-in mono" placeholder="seed (optional)" value={seed} onInput={(e) => setSeed((e.target as HTMLInputElement).value)} />
          <button class="btn sm ghost" onClick={() => { if (confirm('Start a new world? The current persistent world and its ledger will be discarded.')) store.send({ type: 'newWorld', seed: seed ? (parseInt(seed, 16) || Number(seed) || 1) >>> 0 : (Math.random() * 0xffffffff) >>> 0 }); }}>New world</button>
        </div>
      </div>
    </div>
  );
}

export function LedgerTab({ ui }: { ui: UiSnapshot }) {
  const L = ui.ledger;
  return (
    <div class="ledger">
      <div class="eng-col">
        <div class="cc-head">Invariants</div>
        <div class={`inv ${L.balanced ? 'ok' : 'bad'}`}>{L.balanced ? <Icon name="check" size={14} /> : '!'} Postings balance per currency across {num(L.txCount)} transactions</div>
        <div class="kvs">
          <span>Signal minted</span><b class="mono">{num(L.minted)}</b>
          <span>In escrow</span><b class="mono">{num(L.escrow)}</b>
          <span>Paid out</span><b class="mono">{num(L.paid)}</b>
          <span>Refunded</span><b class="mono">{num(L.refunded)}</b>
          <span>Retired</span><b class="mono">{num(L.retired)}</b>
          <span>Merit minted</span><b class="mono">{num(L.meritMinted)}</b>
          <span>Merit spent</span><b class="mono">{num(L.meritSpent)}</b>
        </div>
        <div class="foot-note">Two isolated currencies: Signal (spectators) and Merit (agents). No exchange rate, no withdrawal path, no purchase route.</div>
      </div>
      <div class="ledger-tx">
        <div class="cc-head">Recent transactions</div>
        {L.recent.map((t) => (
          <div class="tx" key={t.id}>
            <span class="mono dim">#{t.id}</span>
            <Pill tone={t.type === 'payout' || t.type === 'grant' ? 'good' : t.type === 'refund' ? 'info' : t.type.startsWith('merit') ? 'muted' : 'warn'}>{t.type}</Pill>
            <span class="mono dim">{simClock(t.tick)}</span>
            <span class="tx-post mono">{t.postings.slice(0, 4).map(([a, v], i) => <span key={i} class={v >= 0 ? 'pos' : 'neg'}>{a} {v > 0 ? '+' : ''}{v}</span>)}{t.postings.length > 4 ? <span class="dim">+{t.postings.length - 4} more</span> : null}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export { Bar };
