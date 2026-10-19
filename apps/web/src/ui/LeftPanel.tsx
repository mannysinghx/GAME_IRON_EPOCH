import { Fragment } from 'preact';
import { CHUNK, FACTIONS, FRONTIER, MAP_H, MAP_W, UNITS } from '../shared/config.ts';
import type { CommanderView, RivalryView, UiSnapshot } from '../shared/protocol.ts';
import { Bar, Spark } from './charts.tsx';
import { FRONTIER_CSS, compact, fcss, fname, kindText, num, pct, planText, realEta, simClock, simDur } from './format.ts';
import { FactionGlyph, Icon, ResIcon, UnitIcon } from './icons.tsx';
import { Empty, KV, Pill, Section, Stat, Tabs, statusTone } from './primitives.tsx';
import { store } from './store.ts';

export function LeftPanel({ ui }: { ui: UiSnapshot }) {
  return (
    <div class="col-scroll">
      <Theatre ui={ui} />
      <Factions ui={ui} />
      <Diplomacy ui={ui} />
      <Commanders ui={ui} />
      <Teams ui={ui} />
      <Schedule ui={ui} />
      <Rivalries ui={ui} />
    </div>
  );
}

/** One head-to-head record: tug-of-war bar of the two scores plus the counts behind them. */
export function RivalRow({ r, ui, compact: small }: { r: RivalryView; ui: UiSnapshot; compact?: boolean }) {
  const tot = Math.max(1, r.scoreA + r.scoreB);
  const age = ui.clock.tick - r.last;
  return (
    <div class={`rv ${r.named ? 'named' : ''}`} style={{ '--fa': fcss(r.fa), '--fb': fcss(r.fb) }}>
      <div class="rv-top">
        <span class="rv-n a" onClick={() => store.select(r.a)}><i />{r.nameA}</span>
        <b class="mono">{r.scoreA}<em>–</em>{r.scoreB}</b>
        <span class="rv-n b" onClick={() => store.select(r.b)}>{r.nameB}<i /></span>
      </div>
      <div class="rv-bar"><span class="a" style={{ width: `${(r.scoreA / tot) * 100}%` }} /><span class="b" /></div>
      {!small && (
        <div class="rv-meta mono">
          <span title="clashes: contact separated by 30 s or more">{r.clashes} {r.clashes === 1 ? 'clash' : 'clashes'}</span>
          <span title="squads destroyed">K {r.kills[0]}–{r.kills[1]}</span>
          <span title="sites taken from the other">S {r.caps[0]}–{r.caps[1]}</span>
          {(r.cores[0] + r.cores[1]) > 0 && <span title="command cores felled">C {r.cores[0]}–{r.cores[1]}</span>}
          {(r.ops[0] + r.ops[1]) > 0 && <span title="operations finished ahead of the other">O {r.ops[0]}–{r.ops[1]}</span>}
          <span class="rv-last" title="since the last contact">{age < 150 ? 'live' : simDur(age)}</span>
        </div>
      )}
    </div>
  );
}

export function Rivalries({ ui }: { ui: UiSnapshot }) {
  const st = ui.story;
  const list = st?.rivalries ?? [];
  return (
    <Section id="rivalries" index="10" title="Rivalries" meta={<span class="dim">{st ? `${st.stats.named} named · ${st.stats.pairs} pairs` : ''}</span>} accent="#ff4f9a">
      {list.length === 0 ? <Empty>Head-to-head records start with the first exchange of fire between two commanders. A rivalry is named once it is mutual: three clashes and each side holding at least a quarter of the score.</Empty> : list.slice(0, 8).map((r) => <RivalRow key={`${r.a}-${r.b}`} r={r} ui={ui} />)}
      <div class="foot-note">Score = squads destroyed + 4 × sites taken from the other + 15 × command cores felled + 6 × operations finished ahead. Ranked by recent heat; records never affect the war.</div>
    </Section>
  );
}

export function Theatre({ ui }: { ui: UiSnapshot }) {
  const c = ui.clock;
  const totalT = ui.factions.reduce((a, f) => a + f.territory, 0);
  const passable = totalT / Math.max(0.0001, ui.factions.reduce((a, f) => a + f.territoryPct, 0)) || 1;
  const active = ui.commanders.filter((x) => x.status === 'active').length;
  const reserve = ui.commanders.filter((x) => x.status === 'reserve' || x.status === 'awaiting').length;
  const sites = ui.factions.reduce((a, f) => a + f.sites, 0);
  const heat = ui.battles.reduce((a, b) => a + b.intensity, 0);
  return (
    <Section id="theatre" index="01" title="Theatre status" meta={<span class="mono">{simClock(c.tick)}</span>}>
      <div class="theatre-clock">
        <div>
          <div class="tc-label">Chapter {roman(c.chapter)} · Campaign {c.campaign}</div>
          <div class="tc-big mono">T+{simClock(c.tick)}</div>
        </div>
        <div class="tc-right">
          <div class="tc-label">Tick</div>
          <div class="mono tc-mid">{num(c.tick)}</div>
        </div>
      </div>
      <div class="prog-row" title="Campaign windows: musters, team charters, treaty notices, campaign merit">
        <span>Campaign</span><Bar value={c.campaignProgress} color="#5aa9ff" h={4} /><span class="mono">{realEta(c.nextCampaignTick - c.tick, ui.speed, ui.paused)}</span>
      </div>
      <div class="prog-row" title="Chapter boundary: standings, chapter festival cohort">
        <span>Chapter</span><Bar value={c.chapterProgress} color="#c08cff" h={4} /><span class="mono">{realEta(c.nextChapterTick - c.tick, ui.speed, ui.paused)}</span>
      </div>
      <div class="share-bar" title="Territory share of passable hexes">
        {ui.factions.map((f) => <span key={f.id} style={{ width: `${f.territoryPct * 100}%`, background: f.css }} />)}
        <span class="neutral" style={{ flex: 1 }} />
      </div>
      <div class="share-legend">
        {ui.factions.map((f) => <span key={f.id}><i style={{ background: f.css }} />{f.name} <b class="mono">{pct(f.territoryPct)}</b></span>)}
        <span><i class="neutral" />Neutral <b class="mono">{pct(1 - totalT / passable)}</b></span>
      </div>
      <div class="stat-grid g3">
        <Stat label="Squads" value={num(ui.world.squads)} sub={`cap ${ui.commanders.filter((x) => x.status === 'active').length * 16}`} />
        <Stat label="Cmdrs" value={<>{active}<span class="dim">/{reserve}</span></>} sub="active / reserve" />
        <Stat label="Sites" value={sites} sub={`of ${(store.map?.sites.filter((s) => s.kind !== 4).length ?? 0)}`} />
        <Stat label="Heat" value={compact(heat)} sub={`${ui.battles.length} hotspots`} color={heat > 80 ? '#ff6a55' : undefined} />
        <Stat label="Structs" value={num(ui.world.structures)} sub="sites, bridges" />
        <Stat label="Max gen" value={`G${ui.world.generation}`} sub={`${ui.world.events} events`} />
      </div>
      <FrontierCard ui={ui} />
    </Section>
  );
}

/** Chunk states for the current theatre: 0 locked, 1 open, 2 opened by the latest expansion. */
export function chunkStates(): { cols: number; rows: number; cells: number[] } {
  const m = store.map;
  if (!m || !m.active) {
    // before the world loads: the published starting square
    const cols = MAP_W / CHUNK, rows = MAP_H / CHUNK, lo = FRONTIER.initialMin, hi = FRONTIER.initialMax;
    const cells: number[] = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) cells.push(i >= lo && i <= hi && j >= lo && j <= hi ? 1 : 0);
    return { cols, rows, cells };
  }
  const ch = m.chunk || 16, cols = Math.ceil(m.w / ch), rows = Math.ceil(m.h / ch);
  const fresh = new Set(store.newChunks);
  const cells: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const t = Math.min(m.h - 1, j * ch + (ch >> 1)) * m.w + Math.min(m.w - 1, i * ch + (ch >> 1));
    cells.push(m.active[t] ? (fresh.has(j * cols + i) ? 2 : 1) : 0);
  }
  return { cols, rows, cells };
}

/** Tiny chunk map of the launch theatre (north up), used by the Theatre panel and the strategy guide. */
export function ChunkGrid({ cell = 7, gap = 1.5 }: { cell?: number; gap?: number }) {
  const st = chunkStates();
  const W = st.cols * (cell + gap) - gap, H = st.rows * (cell + gap) - gap;
  return (
    <svg class="chunk-grid" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${st.cells.filter((c) => c > 0).length} of ${st.cells.length} frontier chunks open`}>
      {st.cells.map((c, k) => (
        <rect key={k} x={(k % st.cols) * (cell + gap)} y={Math.floor(k / st.cols) * (cell + gap)} width={cell} height={cell} rx={1.2} class={c === 2 ? 'cg-new' : c === 1 ? 'cg-open' : 'cg-locked'} />
      ))}
    </svg>
  );
}

function FrontierCard({ ui }: { ui: UiSnapshot }) {
  const f = ui.frontier;
  if (!f) return null;
  const left = Math.max(0, f.nextTick - ui.clock.tick);
  const toNext = f.done ? 1 : Math.max(0, Math.min(1, 1 - left / FRONTIER.interval));
  return (
    <div class="frontier-card" title={`The theatre opens one chunk per quadrant every ${Math.round(FRONTIER.interval / 300)} simulated minutes (mirrored for balance) up to the launch theatre. Locked land is visible but impassable.`}>
      <ChunkGrid />
      <div class="fr-body">
        <div class="fr-head"><Icon name="expand" size={12} /><span>Frontier</span><b class="mono">{f.open}<em>/{f.total}</em></b><span class="dim">chunks open</span></div>
        <Bar value={f.open} max={f.total} color={FRONTIER_CSS} h={4} />
        <div class="fr-kv">
          <span>Active cap</span><b class="mono">{f.activeCap}</b>
          <span>Per faction</span><b class="mono">{f.factionCap}</b>
        </div>
        {f.done ? <div class="fr-done">Launch theatre fully open</div> : (
          <div class="prog-row fr-next" title="Time to the next frontier expansion">
            <span>Next</span><Bar value={toNext} color={FRONTIER_CSS} h={4} /><span class="mono">{realEta(left, ui.speed, ui.paused)}</span>
          </div>
        )}
        {f.lastOpened.length > 0 && <div class="fr-last" title={f.lastOpened.join(', ')}>new: {f.lastOpened.slice(0, 4).join(' · ')}</div>}
      </div>
    </div>
  );
}

export function Factions({ ui }: { ui: UiSnapshot }) {
  const maxPower = Math.max(1, ...ui.factions.map((f) => f.power));
  return (
    <Section id="factions" index="02" title="Factions" meta={<span class="dim" title="World power measures territory, forces and logistics — not policy skill">power ≠ skill</span>}>
      {ui.factions.map((f) => {
        const def = FACTIONS[f.id];
        const kd = f.losses ? f.kills / f.losses : f.kills;
        const mods = Object.entries(def.mods).filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}${k === 'sight' || k === 'jam' ? '' : '%'}`).join(' · ');
        return (
          <div class="fcard" key={f.id} style={{ '--fc': f.css }}>
            <div class="fcard-head">
              <FactionGlyph f={f.id} size={16} />
              <div class="fcard-name">
                <b>{f.name}</b>
                <span>{def.identity}</span>
              </div>
              <div class="fcard-power">
                <Spark values={f.powerHist} color={f.css} w={64} h={20} />
                <div class="mono big">{num(f.power)}</div>
              </div>
            </div>
            <div class="pbar"><span style={{ width: `${(f.power / maxPower) * 100}%`, background: f.css }} /></div>
            <div class="fgrid">
              <KV k="Terr" v={<span class="mono">{pct(f.territoryPct, 1)}</span>} />
              <KV k="Sites" v={<span class="mono">{f.sites}</span>} />
              <KV k="Squads" v={<span class="mono">{f.squads}</span>} />
              <KV k="K/D" v={<span class="mono">{kd.toFixed(2)}</span>} title={`${f.kills} kills / ${f.losses} losses`} />
            </div>
            <div class="res-row">
              {(['alloy', 'energy', 'supply'] as const).map((k) => (
                <span key={k} class="res" title={`${k}: stock ${f.stock[k]}, income ${f.income[k]}/min`}>
                  <ResIcon k={k} /> <b class="mono">{compact(f.stock[k])}</b> <em class="mono">+{compact(f.income[k])}/m</em>
                </span>
              ))}
            </div>
            <div class="comp-row">
              {f.byClass.map((n, cls) => <span key={cls} class="comp" title={UNITS[cls].name}><UnitIcon cls={cls} color={f.css} size={12} /><b class="mono">{n}</b></span>)}
              <span class="comp-meta" title="Share of territory inside the supply network">supply {pct(f.inSupplyPct)}</span>
            </div>
            <div class="fmeta">
              <span>{f.active} active · {f.reserve} reserve{f.capBonus ? ` · +${f.capBonus} slot` : ''}</span>
              <span>upkeep {compact(f.upkeep)}/m</span>
              <span class="mods" title={`Published modifiers (budget-neutral by intent): ${mods}`}>mods</span>
            </div>
          </div>
        );
      })}
    </Section>
  );
}

const REL = ['WAR', 'NAP', 'NOTICE'];

export function Diplomacy({ ui }: { ui: UiSnapshot }) {
  const live = ui.treaties.filter((t) => t.status !== 'ended');
  return (
    <Section id="diplomacy" index="03" title="Diplomacy" meta={<span class="dim">{live.length} pacts</span>}>
      <div class="rel-matrix">
        <span />
        {FACTIONS.map((f) => <span key={f.id} class="rel-h"><FactionGlyph f={f.id} size={12} /></span>)}
        {FACTIONS.map((a) => (
          <Fragment key={`r${a.id}`}>
            <span class="rel-h"><FactionGlyph f={a.id} size={12} /></span>
            {FACTIONS.map((b) => {
              const r = ui.relations[a.id][b.id];
              return <span key={`${a.id}-${b.id}`} class={`rel-cell rel-${r < 0 ? 'self' : REL[r].toLowerCase()}`} title={r < 0 ? a.name : `${a.name} ↔ ${b.name}: ${REL[r]}`}>{r < 0 ? '' : REL[r]}</span>;
            })}
          </Fragment>
        ))}
      </div>
      {ui.treaties.length === 0 ? <Empty>No treaties yet. Non-aggression pacts can be proposed at campaign windows when one faction dominates.</Empty> : (
        <div class="list">
          {ui.treaties.slice().reverse().map((t) => (
            <div class="row" key={t.id}>
              <span class="dot" style={{ background: fcss(t.a) }} /><span class="dot" style={{ background: fcss(t.b) }} />
              <span class="grow">{fname(t.a)} ↔ {fname(t.b)} · {t.kind}</span>
              <Pill tone={t.status === 'active' ? 'good' : t.status === 'notice' ? 'warn' : 'muted'}>{t.status}</Pill>
              <span class="mono dim">{t.status === 'active' ? `exp ${simDur(t.expires - ui.clock.tick)}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function sortCmd(list: CommanderView[], by: string): CommanderView[] {
  const rankStatus = (c: CommanderView) => (c.status === 'active' ? 0 : c.status === 'awaiting' ? 1 : c.status === 'reserve' ? 2 : 3);
  const key = (c: CommanderView) => by === 'skill' ? c.elo : by === 'merit' ? c.merit : by === 'kd' ? (c.losses ? c.kills / c.losses : c.kills) : c.power;
  return list.slice().sort((a, b) => rankStatus(a) - rankStatus(b) || key(b) - key(a) || a.id - b.id);
}

export function Commanders({ ui }: { ui: UiSnapshot }) {
  const by = store.sortBy;
  const list = sortCmd(ui.commanders, by);
  return (
    <Section id="commanders" index="04" title="Commander standings" meta={<span class="dim">{list.length} identities</span>}>
      <Tabs size="sm" value={by} onChange={(v) => { store.sortBy = v; store.emit(); }} options={[
        { id: 'power', label: 'World power', title: 'Territory, infrastructure, forces, logistics' },
        { id: 'skill', label: 'Skill', title: 'Elo from equal-budget proving-ground duels only' },
        { id: 'merit', label: 'Merit', title: 'Treasury earned from validated objectives' },
        { id: 'kd', label: 'K/D' },
      ]} />
      <div class="ctable">
        <div class="ct-head"><span>#</span><span>Commander</span><span>Power</span><span>Skill</span><span>Merit</span><span>Rel</span></div>
        {list.map((c, i) => {
          const sel = store.selected === c.id;
          return (
            <div key={c.id} class={`ct-row ${sel ? 'sel' : ''} st-${c.status}`} onClick={() => store.select(c.id)} title={`${c.name} · ${c.policy} · plan ${c.plan ? planText(c.plan.kind, c.plan.target) : '—'} · plans ✔ ${c.rec.won}/${c.rec.closed}, best streak ${c.rec.best}`}>
              <span class="mono dim">{i + 1}</span>
              <span class="ct-name">
                <i style={{ background: fcss(c.faction) }} />
                <b>{c.name}</b>
                <em>G{c.gen}</em>
                {c.status !== 'active' && <Pill tone={statusTone(c.status)}>{c.status}</Pill>}
                {c.status === 'active' && c.rec.streak >= 3 && <span class="ct-streak up" title={`${c.rec.streak} successful plans in a row`}>▲{c.rec.streak}</span>}
                {c.status === 'active' && c.rec.streak <= -3 && <span class="ct-streak down" title={`${-c.rec.streak} failed plans in a row`}>▼{-c.rec.streak}</span>}
                {c.plan && c.status === 'active' && <span class="ct-plan">{kindText(c.plan.kind)}</span>}
              </span>
              <span class="mono">{c.status === 'active' ? num(c.power) : '—'}</span>
              <span class="mono" title={`${c.evalGames} games · win ${pct(c.winRate)} [${pct(c.winLo)}–${pct(c.winHi)}] 95% CI`}>{c.elo}<em class={c.provisional ? 'prov' : 'dim'}>{c.provisional ? 'P' : `±${c.eloCi}`}</em></span>
              <span class="mono">{num(c.merit)}</span>
              <span class="mono" style={{ color: c.reliability > 0.9 ? '#7ee2a8' : c.reliability > 0.75 ? '#ffd166' : '#ff5d5d' }}>{Math.round(c.reliability * 100)}</span>
            </div>
          );
        })}
      </div>
      <div class="foot-note">World power, skill, merit and reliability are separate records. P = provisional (fewer than 10 equal-budget evaluations).</div>
    </Section>
  );
}

export function Teams({ ui }: { ui: UiSnapshot }) {
  return (
    <Section id="teams" index="05" title="Team headquarters" meta={<span class="dim">{ui.teams.length} charters</span>}>
      {ui.teams.length === 0 ? <Empty>Teams form autonomously at campaign windows ({realEta(ui.clock.nextCampaignTick - ui.clock.tick, ui.speed, ui.paused)}). Each invited commander accepts or rejects the charter itself.</Empty> : ui.teams.map((t) => (
        <div class="tcard" key={t.id} style={{ '--fc': fcss(t.faction) }}>
          <div class="tcard-head"><FactionGlyph f={t.faction} size={13} /><b>{t.name}</b><span class="mono dim">exp {simDur(t.expires - ui.clock.tick)}</span></div>
          <div class="tcard-obj">Objective: {t.objective} · budget {t.budget}% · split {t.split}</div>
          <div class="tmembers">
            {t.members.map((m) => {
              const c = ui.commanders.find((x) => x.id === m.id);
              return (
                <span key={m.id} class={`tm ${m.accepted ? '' : 'rej'}`} onClick={() => store.select(m.id)} title={m.accepted ? 'accepted charter' : 'rejected charter'}>
                  {m.id === t.leader && <b class="lead">★</b>}{c?.name ?? m.id} <em>{m.role}</em>
                </span>
              );
            })}
          </div>
          <div class="tcard-rec mono dim">ops {t.record.ops} · captures {t.record.captures}</div>
        </div>
      ))}
    </Section>
  );
}

export function Schedule({ ui }: { ui: UiSnapshot }) {
  const t = ui.clock.tick;
  const next = ui.nextOperation;
  const rows: { label: string; at: number; note: string }[] = [];
  if (next) {
    rows.push({ label: `${next.code} market closes`, at: next.lockTick, note: next.name });
    rows.push({ label: `${next.code} deploys`, at: next.startTick, note: `${next.roster.length} commanders` });
  }
  if (ui.operation && ui.operation.status === 'Running') rows.push({ label: `${ui.operation.code} final tick`, at: ui.operation.endTick, note: ui.operation.name });
  if (ui.frontier && !ui.frontier.done) rows.push({ label: 'Frontier expansion', at: ui.frontier.nextTick, note: `+${FRONTIER.perEvent} chunks · ${ui.frontier.open}/${ui.frontier.total} open` });
  rows.push({ label: 'Campaign muster & charters', at: ui.clock.nextCampaignTick, note: 'treaty window' });
  rows.push({ label: 'Chapter boundary', at: ui.clock.nextChapterTick, note: 'festival cohort' });
  for (const w of ui.weather) if (w.end > t) rows.push({ label: w.active ? `${w.name} (active)` : w.name, at: w.active ? w.end : w.start, note: w.active ? 'clears' : 'arrives' });
  rows.sort((a, b) => a.at - b.at);
  return (
    <Section id="schedule" index="06" title="Published schedule" meta={<span class="dim">sim time</span>}>
      <div class="list">
        {rows.map((r, i) => (
          <div class="row" key={i}>
            <span class="grow">{r.label}<em class="dim"> · {r.note}</em></span>
            <span class="mono">{simDur(r.at - t)}</span>
            <span class="mono dim">{realEta(r.at - t, ui.speed, ui.paused)}</span>
          </div>
        ))}
      </div>
      <div class="foot-note">Countdowns derive from committed ticks and freeze when the world is paused. Sandbox clocks are compressed: operation 10 min, campaign 60 min, chapter 6 campaigns.</div>
    </Section>
  );
}

export function roman(n: number): string {
  const t: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}
