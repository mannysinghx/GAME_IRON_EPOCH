import { useState } from 'preact/hooks';
import { DOCTRINE, FACTIONS, POP, UNITS } from '../shared/config.ts';
import type { Dossier, MarketView, OperationView, UiSnapshot } from '../shared/protocol.ts';
import { Bar, Lines, Radar, Spark, WeightBars } from './charts.tsx';
import { fcss, fname, num, pct, realEta, shortHash, signed, simClock, simDur } from './format.ts';
import { FactionGlyph, Icon, ResIcon, UnitIcon } from './icons.tsx';
import { Empty, KV, Pill, Section, Stat, statusTone } from './primitives.tsx';
import { idem, store } from './store.ts';
import { camera } from './cameraBridge.ts';

export function RightPanel({ ui }: { ui: UiSnapshot }) {
  return (
    <div class="col-scroll">
      <Operation ui={ui} />
      <Predictions ui={ui} />
      <DossierPanel ui={ui} d={store.dossier} />
    </div>
  );
}

const PHASES = ['Open', 'Locked', 'Running', 'Provisional', 'Settled'];

function phaseInfo(op: OperationView, tick: number): { label: string; left: number } {
  switch (op.status) {
    case 'Open': return { label: 'Market closes in', left: op.lockTick - tick };
    case 'Locked': return { label: 'Deploys in', left: op.startTick - tick };
    case 'Running': return { label: 'Final tick in', left: op.endTick - tick };
    case 'Provisional': return { label: 'Evidence check', left: op.settleTick - tick };
    default: return { label: op.status, left: 0 };
  }
}

export function Operation({ ui }: { ui: UiSnapshot }) {
  const op = ui.operation ?? ui.nextOperation;
  const name = (id: number) => ui.commanders.find((c) => c.id === id);
  return (
    <Section id="operation" index="07" title="Featured operation" meta={op ? <Pill tone={statusTone(op.status)}>{op.status}</Pill> : null} accent="#ffd166">
      {!op ? <Empty>The scheduler opens an operation on a contested front once two factions meet. Its roster, region and seed commitment lock before predictions close.</Empty> : (
        <>
          <div class="op-title">
            <div>
              <div class="op-code mono">{op.code}</div>
              <div class="op-name">{op.name}</div>
            </div>
            <div class="op-timer">
              <span>{phaseInfo(op, ui.clock.tick).label}</span>
              <b class="mono">{simDur(phaseInfo(op, ui.clock.tick).left)}</b>
              <em class="mono">{realEta(phaseInfo(op, ui.clock.tick).left, ui.speed, ui.paused)}</em>
            </div>
          </div>
          <div class="phases">
            {PHASES.map((p) => {
              const idx = PHASES.indexOf(op.status), me = PHASES.indexOf(p);
              return <span key={p} class={`ph ${me < idx ? 'done' : me === idx ? 'cur' : ''}`}>{p}</span>;
            })}
          </div>
          <div class="race">
            {op.scores.slice().sort((a, b) => b.score - a.score).map((s) => {
              const c = name(s.id);
              const max = Math.max(1, ...op.scores.map((x) => x.score));
              const held = op.objectives.filter((o) => o.holder === s.id).length;
              return (
                <div class="race-row" key={s.id} onClick={() => store.select(s.id)}>
                  <span class="race-name"><i style={{ background: fcss(c?.faction ?? -1) }} />{c?.name ?? s.id}</span>
                  <span class="race-bar"><span style={{ width: `${(s.score / max) * 100}%`, background: fcss(c?.faction ?? -1) }} /></span>
                  <b class="mono">{num(s.score)}</b>
                  <span class="mono dim" title="objectives held now">{held}/{op.objectives.length}</span>
                </div>
              );
            })}
          </div>
          <div class="objs">
            {op.objectives.map((o) => {
              const c = name(o.holder);
              return (
                <span class="obj" key={o.tile} onClick={() => camera.focusTile(o.tile)} title={`${o.points} pts per second held`}>
                  <i style={{ background: c ? fcss(c.faction) : '#3a4150' }} />{o.name}<em>×{o.points}</em>
                </span>
              );
            })}
          </div>
          <div class="kv-grid">
            <KV k="Region" v={<span class="mono">r{op.radius} sealed</span>} title="Non-roster forces evacuate; no fire crosses the boundary" />
            <KV k="Seed commit" v={<span class="mono" title={op.seedCommit}>{shortHash(op.seedCommit, 12)}</span>} />
            <KV k="Seed reveal" v={<span class="mono">{op.seedReveal ?? 'after settlement'}</span>} />
            <KV k="Result" v={<span>{op.result ?? '—'}</span>} />
          </div>
          <div class="btn-row">
            <button class="btn" onClick={() => camera.setMode('operation')}><Icon name="target" size={13} /> Watch region</button>
            <button class="btn ghost" onClick={() => { const lead = op.scores.slice().sort((a, b) => b.score - a.score)[0]; if (lead) { store.select(lead.id); camera.setMode('follow'); } }}><Icon name="follow" size={13} /> Follow leader</button>
          </div>
        </>
      )}
      {ui.recentOps.length > 0 && (
        <div class="recent-ops">
          <div class="mini-head">Recent results</div>
          {ui.recentOps.slice(0, 4).map((o) => {
            const w = name(o.winner);
            return (
              <div class="row" key={o.id} onClick={() => camera.focusTile(o.regionCenter)}>
                <span class="mono dim">{o.code}</span>
                <span class="grow">{o.name}</span>
                {w ? <span><i class="dot" style={{ background: fcss(w.faction) }} /> {w.name}</span> : <span class="dim">{o.result ?? '—'}</span>}
                <span class="mono dim">{o.merit.map((m) => `+${m.amount}`).join(' ')}</span>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

export function Predictions({ ui }: { ui: UiSnapshot }) {
  const wlt = ui.wallet;
  const decided = wlt.wins + wlt.losses;
  return (
    <Section id="predict" index="08" title="Prediction desk" meta={<span class="mono sig">◈ {num(wlt.available)}</span>} accent="#7fe7ff">
      <div class="wallet">
        <Stat label="Available" value={<span class="mono">{num(wlt.available)}</span>} sub="Signal credits" />
        <Stat label="In escrow" value={<span class="mono">{num(wlt.escrow)}</span>} sub={`${wlt.bets} stakes`} />
        <Stat label="Net P/L" value={<span class="mono" style={{ color: wlt.net > 0 ? '#7ee2a8' : wlt.net < 0 ? '#ff5d5d' : undefined }}>{signed(wlt.net)}</span>} sub={`${wlt.wins}W ${wlt.losses}L ${wlt.refunds}R`} />
        <Stat label="Hit rate" value={<span class="mono">{decided ? pct(wlt.wins / decided) : '—'}</span>} sub={`n = ${decided}`} />
      </div>
      <div class="grant-row">
        {wlt.grantReady
          ? <button class="btn sm" onClick={() => store.send({ type: 'claimGrant', idem: idem() })}><Icon name="bolt" size={12} /> Claim campaign grant +100</button>
          : <span class="dim">Next grant at campaign {Math.floor(wlt.nextGrantTick / 18000) + 1} ({realEta(wlt.nextGrantTick - ui.clock.tick, ui.speed, ui.paused)})</span>}
        <span class="dim push-right">nonredeemable · no cash value</span>
      </div>
      {ui.markets.length === 0 ? <Empty>Markets open three minutes (sim) before an operation deploys and close 30 s before deployment.</Empty> : ui.markets.slice(0, 4).map((m) => <MarketCard key={m.id} m={m} ui={ui} />)}
      {wlt.receipts.length > 0 && (
        <details class="receipts">
          <summary>Receipts ({wlt.receipts.length})</summary>
          {wlt.receipts.map((r) => (
            <div class="row" key={r.id}>
              <span class="mono dim">{simClock(r.tick)}</span>
              <span class="grow">{r.text}</span>
              <span class="mono" style={{ color: r.kind === 'payout' || r.kind === 'grant' || r.kind === 'refund' ? '#7ee2a8' : r.kind === 'loss' ? '#ff5d5d' : undefined }}>{r.amount > 0 ? '+' : ''}{r.amount}</span>
            </div>
          ))}
        </details>
      )}
      <div class="foot-note">Pari-mutuel pools, no house cut. Estimates assume the current pool; final returns use the pool at cutoff with integer largest-remainder apportionment. Agents never see stakes, prices or popularity.</div>
    </Section>
  );
}

function MarketCard({ m, ui }: { m: MarketView; ui: UiSnapshot }) {
  const [pick, setPick] = useState<string | null>(null);
  const [stake, setStake] = useState(10);
  const open = m.status === 'Open';
  const chosen = m.myOutcome ?? pick;
  const remaining = Math.max(0, m.myCap - m.myStake);
  const left = m.cutoffTick - ui.clock.tick;
  return (
    <div class={`market st-${m.status.toLowerCase()}`}>
      <div class="m-head">
        <Pill tone={statusTone(m.status)}>{m.status}</Pill>
        <span class="m-q">{m.question}</span>
      </div>
      <div class="m-sub mono dim">
        {open ? `closes in ${simDur(left)} (${realEta(left, ui.speed, ui.paused)})` : m.status === 'Settled' || m.status === 'Voided' ? (m.note ?? '') : `locked · resolves at ${simClock(m.endTick)}`} · pool {num(m.total)} · spec {shortHash(m.specHash, 8)}
      </div>
      <div class="outcomes">
        {m.outcomes.map((o) => {
          const share = m.total ? o.pool / m.total : 0;
          const est = o.pool ? m.total / o.pool : 0;
          const isRes = m.result === o.id;
          return (
            <button key={o.id} class={`oc ${chosen === o.id ? 'pick' : ''} ${isRes ? 'res' : ''}`} disabled={!open || (m.myOutcome !== null && m.myOutcome !== o.id)} onClick={() => setPick(o.id)} style={{ '--oc': o.css }}>
              <span class="oc-label"><i />{o.label}{isRes && <b class="win">RESULT</b>}</span>
              <span class="oc-bar"><span style={{ width: `${share * 100}%` }} /></span>
              <span class="mono oc-pool">{num(o.pool)}</span>
              <span class="mono oc-est" title="Estimated gross return multiple if this outcome wins, at the current pool">{est ? `×${est.toFixed(2)}` : '—'}</span>
              {o.mine > 0 && <span class="mono oc-mine">you {o.mine}</span>}
            </button>
          );
        })}
      </div>
      {open && chosen && remaining > 0 && (
        <div class="stake-row">
          <input type="number" min={1} max={remaining} value={Math.min(stake, remaining)} onInput={(e) => setStake(Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value) || 1)))} />
          {[10, 25, 50].map((v) => <button key={v} class="chip" onClick={() => setStake(Math.min(v, remaining))}>{v}</button>)}
          <button class="chip" onClick={() => setStake(remaining)}>max {remaining}</button>
          <button class="btn sm primary" onClick={() => store.send({ type: 'bet', marketId: m.id, outcomeId: chosen, stake: Math.min(stake, remaining), idem: idem() })}>Stake</button>
        </div>
      )}
      {open && <div class="m-cap dim">Cap {m.myCap} (fixed at first entry: smaller of 100 or 10% of balance){m.myStake ? ` · staked ${m.myStake}` : ''}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ dossier
export function DossierPanel({ ui, d }: { ui: UiSnapshot; d: Dossier | null }) {
  const cv = ui.commanders.find((c) => c.id === store.selected);
  if (!d || !cv) return <Section id="dossier" index="09" title="Agent dossier"><Empty>Select a commander in the standings or click a squad on the map.</Empty></Section>;
  const col = fcss(d.faction);
  const deltas: Record<string, number> = {};
  for (const m of d.mutation) deltas[m.param] = m.delta;
  const lastDec = d.decisions[0];
  const names = [...d.featureNames, ...d.planNames.map((p) => p.toLowerCase().replace('_', ' ')), 'bias'];
  const top = d.weights.map((w, i) => ({ w, i })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 10);
  return (
    <Section id="dossier" index="09" title="Agent dossier" meta={<span class="mono dim">{d.key}</span>} accent={col}>
      <div class="dos-head" style={{ '--fc': col }}>
        <FactionGlyph f={d.faction} size={30} />
        <div class="dos-id">
          <div class="dos-name">{d.name}</div>
          <div class="dos-sub">{fname(d.faction)} · generation {d.gen} · {d.birthKind} · born {simClock(d.born)}</div>
          <div class="dos-tags">
            <Pill tone={statusTone(d.status)}>{d.status}</Pill>
            <Pill tone="info" title={`policy hash ${d.policyHash}`}>policy {d.policy}</Pill>
            {d.team && <Pill tone="muted">{cv.role}</Pill>}
          </div>
        </div>
        <div class="dos-btns">
          <button class="icon-btn" title="Follow on map" onClick={() => camera.setMode('follow')}><Icon name="follow" /></button>
          <button class="icon-btn" title="View battlefield as this faction (fog of war)" onClick={() => store.setOverlays({ fog: store.overlays.fog === d.faction ? -1 : d.faction })}><Icon name="eye" /></button>
        </div>
      </div>

      <div class="records">
        <div class="rec" title="Territory, infrastructure, forces and logistics. Not a skill measure.">
          <span>World power</span><b class="mono">{num(cv.power)}</b>
          <Spark values={d.hist.power} color={col} w={84} h={18} />
        </div>
        <div class="rec" title="Elo from equal-budget, side-swapped proving-ground duels only">
          <span>Skill rating</span><b class="mono">{cv.elo}<em> ±{cv.eloCi}</em></b>
          <em class="mono dim">{cv.evalGames} games · {pct(cv.winRate)} [{pct(cv.winLo)}–{pct(cv.winHi)}]{cv.provisional ? ' · provisional' : ''}</em>
        </div>
        <div class="rec" title="Merit treasury from validated objectives">
          <span>Merit</span><b class="mono">{num(cv.merit)}</b>
          <em class="mono dim">earned {num(cv.meritGross)} · spent {num(cv.meritSpent)}</em>
        </div>
        <div class="rec" title="Valid-action rate and baseline-fallback frequency">
          <span>Reliability</span><b class="mono">{pct(cv.reliability, 1)}</b>
          <em class="mono dim">{d.stats.ordersRejected}/{d.stats.ordersIssued} rejected · {d.stats.fallbacks} fallbacks</em>
        </div>
        <div class="rec">
          <span>Operations</span><b class="mono">{cv.opsWon}/{cv.opsPlayed}</b>
          <em class="mono dim">won / played · {cv.plans} plans</em>
        </div>
        <div class="rec">
          <span>Combat</span><b class="mono">{cv.kills}<em>/{cv.losses}</em></b>
          <em class="mono dim">kills / losses · {d.stats.captures} captures</em>
        </div>
      </div>

      {d.plan && (
        <div class="plan-card" style={{ '--fc': col }}>
          <div class="plan-top">
            <span class="plan-kind">{d.plan.kind.replace('_', ' ')}</span>
            <span class="plan-target" onClick={() => camera.focusTile(d.plan!.targetTile)}>{d.plan.target}</span>
          </div>
          <div class="plan-meta">
            <Pill tone={d.plan.reason.startsWith('LEARNED') ? 'info' : d.plan.explored ? 'warn' : 'muted'}>{d.plan.reason}</Pill>
            <span>{d.plan.posture.toLowerCase()} · reserve {d.plan.reserve}% · {d.plan.group.length} squads assigned · age {simDur(ui.clock.tick - d.plan.started)}</span>
          </div>
        </div>
      )}

      {lastDec && (
        <div class="cands">
          <div class="mini-head">Last strategic review <span class="mono dim">{lastDec.id} · obs {lastDec.obsHash} · {lastDec.candidates.length} legal plans</span></div>
          <div class="cand-h"><span>Candidate</span><span title="Doctrine utility baseline">U</span><span title="Learned value correction">L</span><span>Score</span></div>
          {lastDec.candidates.map((c, i) => {
            const max = Math.max(...lastDec.candidates.map((x) => x.score)), min = Math.min(...lastDec.candidates.map((x) => x.score));
            return (
              <div class={`cand ${c.chosen ? 'chosen' : ''}`} key={i} onClick={() => camera.focusTile(c.tile)} title={d.featureNames.map((f, k) => `${f} ${c.feats[k]}`).join('\n')}>
                <span class="cand-name"><b>{c.kind.replace('_', ' ').toLowerCase()}</b> {c.target}</span>
                <span class="mono">{c.U.toFixed(2)}</span>
                <span class={`mono ${c.L >= 0 ? 'pos' : 'neg'}`}>{signed(c.L, 2)}</span>
                <span class="cand-score"><Bar value={c.score - min + 0.05} max={max - min + 0.05} color={c.chosen ? col : '#4a5466'} h={4} /><em class="mono">{c.score.toFixed(2)}</em></span>
              </div>
            );
          })}
        </div>
      )}

      <div class="dos-split">
        <div>
          <div class="mini-head">Doctrine</div>
          <Radar values={d.doctrine} labels={[...DOCTRINE]} color={col} size={156} deltas={deltas} />
          {d.mutation.length > 0 && <div class="mut mono dim">mutation: {d.mutation.map((m) => `${m.param} ${m.delta > 0 ? '+' : ''}${m.delta}`).join(', ')}</div>}
        </div>
        <div class="learn">
          <div class="mini-head"><Icon name="brain" size={12} /> Online learning</div>
          <KV k="Updates" v={<span class="mono">{d.updates}</span>} />
          <KV k="Explore ε" v={<span class="mono">{d.epsilon.toFixed(3)}</span>} />
          <KV k="|error| EMA" v={<span class="mono">{d.errEma.toFixed(3)}</span>} />
          <KV k="Reward EMA" v={<span class="mono" style={{ color: d.rewardEma >= 0 ? '#7ee2a8' : '#ff5d5d' }}>{signed(d.rewardEma, 3)}</span>} />
          <div class="learn-chart"><Lines series={[d.hist.err]} colors={['#9aa7ff']} h={40} min={0} /></div>
          <div class="dim tiny">prediction error per sample · lower = better calibrated</div>
        </div>
      </div>

      <div class="mini-head">Learned value head <span class="dim">top terms by magnitude · linear, per agent, online</span></div>
      <WeightBars weights={top.map((t) => t.w)} names={top.map((t) => names[t.i])} />

      <div class="mini-head">Memory <span class="dim">{d.memory.length}/24 facts · provenance, age, confidence</span></div>
      <div class="memory">
        {d.memory.length === 0 ? <Empty>No facts yet.</Empty> : d.memory.slice(0, 10).map((m, i) => (
          <div class={`mem mem-${m.kind.toLowerCase()}`} key={i} onClick={() => m.tile >= 0 && camera.focusTile(m.tile)}>
            <span class="mem-k">{m.kind.replace('_', ' ')}</span>
            <span class="mem-t">{m.kind === 'OPP_TENDENCY' ? `${m.src} ×${m.value}` : `${m.place}${m.kind === 'PLAN_OUTCOME' ? ` · ${m.value >= 0 ? '+' : ''}${m.value}` : ''}`}<em>{m.kind === 'OPP_TENDENCY' ? '' : m.src}</em></span>
            <span class="mem-c"><Bar value={m.conf} color={m.kind === 'DANGER' ? '#ff5d5d' : m.kind === 'LESSON' ? '#c08cff' : '#7fe7ff'} h={3} /></span>
            <span class="mono dim">{simDur(m.age)}</span>
          </div>
        ))}
      </div>

      <div class="mini-head">Decision log</div>
      <div class="declog">
        {d.decisions.map((x) => (
          <div class="dec" key={x.id}>
            <span class="mono dim">{simClock(x.tick)}</span>
            <span class="grow"><b>{x.chosen.replace('_', ' ').toLowerCase()}</b> {x.target}<em> · {x.reason}{x.explored ? ' · explore' : ''}</em></span>
            <span class="mono" style={{ color: x.reward === null ? '#5b6576' : x.reward >= 0 ? '#7ee2a8' : '#ff5d5d' }}>{x.reward === null ? 'active' : signed(x.reward, 2)}</span>
          </div>
        ))}
      </div>

      <div class="dos-split">
        <div>
          <div class="mini-head"><Icon name="dna" size={12} /> Lineage</div>
          <div class="lineage">
            {d.lineage.ancestors.slice().reverse().map((a) => <span key={a.id} class="lin" onClick={() => store.select(a.id)}>{a.name} <em>G{a.gen}</em></span>)}
            <span class="lin self">{d.name} <em>G{d.gen}</em></span>
            {d.lineage.children.map((c) => <span key={c.id} class="lin child" onClick={() => store.select(c.id)}>↳ {c.name} <em>G{c.gen} · {c.status}</em></span>)}
            {d.lineage.ancestors.length === 0 && d.lineage.children.length === 0 && <span class="dim tiny">Founding identity, no descendants yet. Sponsoring one needs {POP.SPONSOR_PLANS} plans chosen and {POP.SPONSOR_MERIT} merit, at most once per campaign.</span>}
          </div>
        </div>
        <div>
          <div class="mini-head">Forces & economy</div>
          <div class="forces">
            {[0, 1, 2, 3, 4].map((cls) => {
              const n = d.squads.filter((s) => s.cls === cls).length;
              return <span key={cls} class="comp" title={UNITS[cls].name}><UnitIcon cls={cls} color={col} size={12} /><b class="mono">{n}</b></span>;
            })}
            <span class="mono dim">{d.squads.length}/{d.stats.squadCap}</span>
          </div>
          <div class="res-row">
            {(['alloy', 'energy', 'supply'] as const).map((k) => <span key={k} class="res"><ResIcon k={k} /><b class="mono">{num(d.res[k])}</b></span>)}
          </div>
          <div class="queue mono dim">queue: {d.queue.length ? d.queue.map((q) => `${UNITS[q.cls].short} ${simDur(q.left)}`).join(' · ') : 'idle'}</div>
        </div>
      </div>

      {d.policyHistory.length > 0 && (
        <details class="phist">
          <summary>Policy versions ({d.policyHistory.length})</summary>
          {d.policyHistory.map((p, i) => <div class="row" key={i}><span class="mono">{p.version}</span><span class="grow dim">{p.note}</span><span class="mono dim">{simClock(p.tick)}</span></div>)}
        </details>
      )}
      <div class="foot-note">Strategic layer: doctrine utility baseline plus a per-agent online linear value learner (no language model, no remote inference). Explanations are generated from accepted plan IDs and observation features, not from private reasoning.</div>
    </Section>
  );
}

export { FACTIONS };
