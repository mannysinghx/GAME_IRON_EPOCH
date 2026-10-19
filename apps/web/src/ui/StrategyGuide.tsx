// GAME STRATEGY: the player's guide to IRON EPOCH. Every number below is read from the published rules in
// shared/config.ts, so the guide stays accurate when tuning changes.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CHUNK, CLOCK, DMG_MATRIX, DOCTRINE, FACTIONS, FRONTIER, LEARN, MAP_H, MAP_W, POP, S, SIGNAL, STRUCTS, T, TERRAIN, U, UNITS, type FactionMods } from '../shared/config.ts';
import type { UiSnapshot } from '../shared/protocol.ts';
import { FRONTIER_CSS, num, realEta } from './format.ts';
import { FactionGlyph, Icon, ResIcon, UnitIcon } from './icons.tsx';
import { ChunkGrid } from './LeftPanel.tsx';

const SECTIONS: { id: string; title: string; icon: string; blurb: string }[] = [
  { id: 'idea', title: 'The idea', icon: 'bulb', blurb: 'Spectate, judge, predict' },
  { id: 'stakes', title: 'What they fight for', icon: 'flag', blurb: 'Factions, supply, operations, frontier' },
  { id: 'minds', title: 'How commanders think', icon: 'brain', blurb: 'Plans, doctrine, learning' },
  { id: 'know', title: 'What you need to know', icon: 'shield', blurb: 'Rules that protect you' },
  { id: 'predict', title: 'How to predict well', icon: 'target', blurb: 'Reading an operation' },
  { id: 'screen', title: 'Reading the screen', icon: 'layers', blurb: 'Panels, tabs, map legend' },
  { id: 'controls', title: '3D controls', icon: 'cube', blurb: 'Mouse, touch, keyboard' },
];

// rule-derived figures (5 ticks per simulated second, 300 per minute)
const MIN = 300;
const OP_MIN = CLOCK.OP_RUN / MIN;
const OPEN_LEAD_MIN = CLOCK.OP_OPEN_LEAD / MIN;
const LOCK_LEAD_S = CLOCK.OP_LOCK_LEAD / 5;
const VERIFY_S = CLOCK.OP_VERIFY / 5;
const REVIEW_MIN_S = CLOCK.STRATEGIC_MIN / 5, REVIEW_MAX_S = CLOCK.STRATEGIC_MAX / 5;
const FRONTIER_MIN = FRONTIER.interval / MIN;
const START_SIZE = (FRONTIER.initialMax - FRONTIER.initialMin + 1) * CHUNK;
const TOTAL_CHUNKS = (MAP_W / CHUNK) * (MAP_H / CHUNK);
const START_CHUNKS = (FRONTIER.initialMax - FRONTIER.initialMin + 1) ** 2;
const FULL_AFTER_H = (FRONTIER.firstAt + ((TOTAL_CHUNKS - START_CHUNKS) / FRONTIER.perEvent - 1) * FRONTIER.interval) / (MIN * 60);

const MOD_LABEL: Record<keyof FactionMods, [string, boolean]> = {
  speed: ['speed', true], sight: ['sight', true], structHp: ['structure HP', true], buildCost: ['build cost', false], prodTime: ['build time', false],
  income: ['income', true], supplyDrain: ['supply drain', false], dmgOut: ['damage dealt', true], dmgIn: ['damage taken', false],
  capture: ['capture speed', true], heal: ['recovery', true], jam: ['jamming', true],
};

const FACTION_STYLE = [
  'Digs in and recovers fast. Its home fronts are very hard to crack, but it is slow to reach new sites.',
  'Sees first and flanks wide. Expect early captures far from home, and a collapse when its supply line is cut.',
  'Out-produces everyone. Its depots, bridges and cores are the soft targets that hurt it most.',
  'Hard to hit and hard to pin down. It survives fights it should lose but lacks the punch to finish them.',
];

const PLAN_LABELS = [
  'capture a site', 'attack forces', 'assault a core', 'raid', 'defend', 'fortify', 'extend supply', 'repair',
  'sabotage a bridge', 'recon', 'operation objective', 'support a teammate', 'regroup',
];

export function StrategyGuide({ ui, onClose }: { ui: UiSnapshot | null; onClose: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [active, setActive] = useState(SECTIONS[0].id);

  useEffect(() => {
    // focus the scrolling pane, not the close button: Space / PageDown / arrows then scroll the guide natively
    // instead of "clicking" close (App stands its shortcuts down while a dialog is open)
    body.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  // phones: the section strip scrolls sideways, so keep the active chip in view
  useEffect(() => {
    const n = nav.current, b = n?.querySelector<HTMLElement>('button.on');
    if (n && b && n.scrollWidth > n.clientWidth + 1) n.scrollTo({ left: Math.max(0, b.offsetLeft - 12), behavior: 'smooth' });
  }, [active]);

  const spy = () => {
    const el = body.current;
    if (!el) return;
    let cur = SECTIONS[0].id;
    for (const s of SECTIONS) {
      const n = el.querySelector<HTMLElement>(`#sg-${s.id}`);
      if (n && n.offsetTop <= el.scrollTop + 90) cur = s.id;
    }
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) cur = SECTIONS[SECTIONS.length - 1].id;
    setActive((a) => (a === cur ? a : cur));
  };
  const go = (id: string) => {
    const el = body.current, n = el?.querySelector<HTMLElement>(`#sg-${id}`);
    if (el && n) el.scrollTo({ top: n.offsetTop - 14, behavior: 'smooth' });
    el?.focus({ preventScroll: true }); // keyboard scrolling continues from the section just opened
    setActive(id);
  };

  return (
    <div class="modal-back sg-back" onClick={() => close.current()}>
      <div class="modal sg" role="dialog" aria-modal="true" aria-labelledby="sg-title" onClick={(e) => e.stopPropagation()}>
        <header class="sg-head">
          <span class="sg-badge"><Icon name="bulb" size={20} /></span>
          <div class="sg-titles">
            <h2 id="sg-title">Game Strategy</h2>
            <p>How the endless war works, how its commanders think, and how to call the outcome.</p>
          </div>
          <button class="icon-btn" title="Close (Esc)" aria-label="Close the strategy guide" onClick={() => close.current()}><Icon name="close" /></button>
        </header>
        <div class="sg-body">
          <nav class="sg-nav" ref={nav} aria-label="Guide sections">
            {SECTIONS.map((s, i) => (
              <button key={s.id} class={active === s.id ? 'on' : ''} aria-current={active === s.id ? 'true' : undefined} onClick={() => go(s.id)}>
                <span class="sgn-idx mono">{String(i + 1).padStart(2, '0')}</span>
                <Icon name={s.icon} size={14} />
                <span class="sgn-text"><b>{s.title}</b><em>{s.blurb}</em></span>
              </button>
            ))}
            <div class="sg-nav-foot">Private browser sandbox. Signal credits are play money with no cash value.</div>
          </nav>
          <div class="sg-content" ref={body} tabIndex={-1} onScroll={spy}>
            <Idea />
            <Stakes ui={ui} />
            <Minds />
            <Know ui={ui} />
            <Predict ui={ui} />
            <Screen />
            <Controls />
            <div class="sg-end">
              <span>That is the whole game.</span> Pick a commander, open its dossier, and watch whether its plans survive contact.
              <button class="btn sm sg-cta" onClick={() => close.current()}>Back to the battlefield</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Sec({ id, n, title, lead, children }: { id: string; n: number; title: string; lead?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="sg-sec" id={`sg-${id}`}>
      <h3><span class="sg-num mono">{String(n).padStart(2, '0')}</span>{title}</h3>
      {lead && <p class="sg-lead">{lead}</p>}
      {children}
    </section>
  );
}

function Sub({ icon, title, children }: { icon: string; title: string; children: ComponentChildren }) {
  return (
    <div class="sg-sub">
      <h4><Icon name={icon} size={13} />{title}</h4>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ 01
function Idea() {
  return (
    <Sec id="idea" n={1} title="The idea" lead={<>IRON EPOCH is an <b>endless war fought entirely by AI commanders</b>. You do not command anything. You spectate, work out which commanders are genuinely good, and predict how their operations end using free play credits.</>}>
      <div class="sg-steps">
        <div class="sg-step"><span class="sgs-i"><Icon name="eye" size={18} /></span><b>Spectate</b><p>The battle runs on its own. Pause it, run it at up to 32×, and fly the 3D camera anywhere over the theatre.</p></div>
        <div class="sg-step"><span class="sgs-i"><Icon name="brain" size={18} /></span><b>Judge</b><p>Open a commander's dossier: its doctrine, every plan it considered and why it chose one, what it has learned, its lineage.</p></div>
        <div class="sg-step"><span class="sgs-i"><Icon name="coin" size={18} /></span><b>Predict</b><p>Stake Signal credits on operation outcomes before the market closes. Reading the battle better than the crowd is the game.</p></div>
      </div>
      <div class="sg-callout"><Icon name="shield" size={14} /><span>Nothing you do reaches the armies. Commanders never see bets, pools or crowd popularity, so the war you watch is the war they chose.</span></div>
    </Sec>
  );
}

// ------------------------------------------------------------------ 02
function modChips(m: FactionMods) {
  return (Object.keys(MOD_LABEL) as (keyof FactionMods)[]).filter((k) => m[k] !== 0).map((k) => {
    const v = m[k], [label, higher] = MOD_LABEL[k];
    const unit = k === 'sight' ? (Math.abs(v) === 1 ? ' tile' : ' tiles') : k === 'jam' ? '' : '%';
    return <span key={k} class={`sg-mod ${(v > 0) === higher ? 'good' : 'bad'}`}>{label} {v > 0 ? '+' : '−'}{Math.abs(v)}{unit}</span>;
  });
}

function Stakes({ ui }: { ui: UiSnapshot | null }) {
  const f = ui?.frontier;
  const core = STRUCTS[S.CORE], depot = STRUCTS[S.DEPOT], hub = STRUCTS[S.HUB], cit = STRUCTS[S.CITADEL];
  return (
    <Sec id="stakes" n={2} title="What they fight for" lead="Four factions with published, budget-neutral modifiers fight over one map. The map itself is the economy.">
      <div class="sg-factions">
        {FACTIONS.map((d) => (
          <div key={d.id} class="sg-fac" style={{ '--fc': d.css }}>
            <div class="sgf-head"><FactionGlyph f={d.id} size={22} /><div><b>{d.name}</b><span>{d.identity}</span></div></div>
            <div class="sgf-trade"><span class="good">+ {d.strength}</span><span class="bad">− {d.tradeoff}</span></div>
            <p>{FACTION_STYLE[d.id]}</p>
            <div class="sgf-mods">{modChips(d.mods)}</div>
          </div>
        ))}
      </div>

      <Sub icon="route" title="The map is the economy">
        <p>Mines, reactors, relays, fabrication hubs and the central citadel produce <ResIcon k="alloy" /> alloy, <ResIcon k="energy" /> energy and <ResIcon k="supply" /> supply. But territory only pays when it is <b>connected to the supply network</b> that radiates from command cores (radius {core.supplyRadius}) and supply depots (radius {depot.supplyRadius}); hubs ({hub.supplyRadius}) and the citadel ({cit.supplyRadius}) extend it. Squads cut off from supply weaken, slow down and retreat.</p>
        <SupplyDiagram />
      </Sub>

      <Sub icon="target" title="The war never ends, but operations do">
        <p>Every {OP_MIN} simulated minutes a contested front is <b>sealed</b>. Two or three named commanders fight inside it for objectives; every other force must leave the zone and no fire crosses its edge. Operations are what you predict.</p>
        <div class="sg-phases">
          <span class="p-open"><b>Open</b><em>market opens {OPEN_LEAD_MIN} min before deployment</em></span>
          <span class="p-lock"><b>Locked</b><em>betting closes {LOCK_LEAD_S} s before deployment</em></span>
          <span class="p-run"><b>Running</b><em>{OP_MIN} min of fighting for objectives</em></span>
          <span class="p-prov"><b>Provisional</b><em>{VERIFY_S} s evidence check</em></span>
          <span class="p-set"><b>Settled</b><em>payouts, seed revealed</em></span>
        </div>
      </Sub>

      <Sub icon="dna" title="The world remembers">
        <div class="sg-grid4">
          <div class="sg-mini"><Icon name="brain" size={14} /><b>Learning</b><p>Each commander learns from its own and its faction's plan outcomes; the learned correction measurably improves the sites and territory it holds.</p></div>
          <div class="sg-mini"><Icon name="eye" size={14} /><b>Memory</b><p>It remembers where it was hurt and which routes failed, and steers around them later.</p></div>
          <div class="sg-mini"><Icon name="dna" size={14} /><b>Lineage</b><p>Veterans ({POP.SPONSOR_PLANS} plans chosen, {POP.SPONSOR_MERIT} merit, at most one descendant per campaign) sponsor descendants with slightly mutated doctrine. Defeated commanders go to reserve.</p></div>
          <div class="sg-mini"><Icon name="shield" size={14} /><b>Pacts</b><p>Factions sign non-aggression pacts against a dominant power at campaign windows, and must give notice to break them.</p></div>
        </div>
      </Sub>

      <Sub icon="expand" title="The land expands">
        <div class="sg-frontier">
          <div class="sgfr-grid">
            <ChunkGrid cell={11} gap={2} />
            <div class="sgfr-legend"><span><i class="cg-open" />open</span><span><i class="cg-new" />just opened</span><span><i class="cg-locked" />locked</span></div>
          </div>
          <div>
            <p>The theatre starts at <b>{START_SIZE} × {START_SIZE}</b> hexes ({START_CHUNKS} chunks). Every {FRONTIER_MIN} simulated minutes a new frontier chunk opens in <b>each quadrant</b>, mirrored so no faction is favoured, until the <b>{MAP_W} × {MAP_H}</b> launch theatre ({TOTAL_CHUNKS} chunks) is open after about {FULL_AFTER_H.toFixed(0)} simulated hours.</p>
            <p>Each unlock brings new sites and room for new commanders: the active cap grows from {POP.ACTIVE_CAP} to {POP.ACTIVE_MAX}, and from {POP.FACTION_CAP} to {POP.FACTION_MAX} per faction. Locked land is visible but impassable behind an <span style={{ color: FRONTIER_CSS }}>amber boundary</span>. Beyond the theatre, uncharted land continues forever as scenery to fly over; it is not simulated.</p>
            {f && <div class="sg-live"><span class="sg-live-dot" />Live: <b class="mono">{f.open}/{f.total}</b> chunks open{f.done ? ' · fully open' : <> · next expansion <b class="mono">{realEta(f.nextTick - (ui?.clock.tick ?? 0), ui?.speed ?? 1, ui?.paused ?? false)}</b></>} · cap <b class="mono">{f.activeCap}</b> commanders</div>}
          </div>
        </div>
      </Sub>
    </Sec>
  );
}

function hexPts(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 3; return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
}

function SupplyDiagram() {
  return (
    <svg class="sg-diagram" viewBox="0 0 600 176" role="img" aria-label="A command core and a depot form the supply network. A mine inside it pays; a mine outside pays nothing; a squad outside weakens and retreats.">
      <circle cx="84" cy="96" r="72" class="sd-net" />
      <circle cx="206" cy="96" r="50" class="sd-net" />
      <line x1="84" y1="96" x2="206" y2="96" class="sd-link" />
      <polygon points={hexPts(84, 96, 17)} class="sd-core" />
      <rect x="198" y="88" width="16" height="16" rx="2" class="sd-depot" />
      <path d="M240 50l9 9-9 9-9-9z" class="sd-mine ok" />
      <path d="M392 76l9 9-9 9-9-9z" class="sd-mine off" />
      <path d="M387 80l10 10M397 80l-10 10" class="sd-x" />
      {[[506, 112], [500, 104], [500, 120], [494, 98], [494, 126]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3" class="sd-squad" />)}
      <text x="84" y="132" class="sd-t" text-anchor="middle">Command core</text>
      <text x="84" y="145" class="sd-s" text-anchor="middle">supply radius {STRUCTS[S.CORE].supplyRadius}</text>
      <text x="206" y="126" class="sd-t" text-anchor="middle">Depot</text>
      <text x="206" y="139" class="sd-s" text-anchor="middle">radius {STRUCTS[S.DEPOT].supplyRadius}</text>
      <text x="256" y="44" class="sd-t">Mine, connected</text>
      <text x="256" y="57" class="sd-s good">pays its owner</text>
      <text x="392" y="62" class="sd-t" text-anchor="middle">Mine, cut off</text>
      <text x="392" y="112" class="sd-s bad" text-anchor="middle">pays nothing</text>
      <text x="500" y="84" class="sd-t" text-anchor="middle">Squad out of supply</text>
      <text x="500" y="146" class="sd-s bad" text-anchor="middle">weakens · slows · retreats</text>
    </svg>
  );
}

// ------------------------------------------------------------------ 03
function Minds() {
  return (
    <Sec id="minds" n={3} title="How commanders think" lead={<>Every {REVIEW_MIN_S}–{REVIEW_MAX_S} s, or right after a major event, each commander runs a <b>strategic review</b>. Between reviews, squads follow the chosen plan with fast tactical rules.</>}>
      <div class="sg-flow">
        <div><span class="sgs-i"><Icon name="clock" size={16} /></span><b>Review</b><p>every {REVIEW_MIN_S}–{REVIEW_MAX_S} s, or early when its core is threatened, a plan succeeds or bleeds, or new land opens</p></div>
        <div><span class="sgs-i"><Icon name="search" size={16} /></span><b>List</b><p>4–8 legal plans, built only from what its own faction can see</p></div>
        <div><span class="sgs-i"><Icon name="chart" size={16} /></span><b>Score</b><p><span class="sg-formula mono">score = U + {LEARN.lambda} × L</span> doctrine utility plus learned correction</p></div>
        <div><span class="sgs-i"><Icon name="swords" size={16} /></span><b>Assign</b><p>assault group, reserve, scouts, artillery and engineers each get a role</p></div>
      </div>
      <div class="sg-chips">{PLAN_LABELS.map((p) => <span key={p} class="sg-chip">{p}</span>)}</div>

      <div class="sg-two">
        <Sub icon="dna" title="Doctrine: six dials, per commander">
          <div class="sg-doc">
            <div class="sgd-h"><span />{FACTIONS.map((f) => <FactionGlyph key={f.id} f={f.id} size={12} />)}</div>
            {DOCTRINE.map((axis, i) => (
              <div key={axis} class="sgd-row">
                <span>{axis}</span>
                {FACTIONS.map((f) => <span key={f.id} class="sgd-cell" title={`${f.name} founding ${axis}: ${f.doctrine[i]}`}><i style={{ width: `${f.doctrine[i]}%`, background: f.css }} /></span>)}
              </div>
            ))}
          </div>
          <p class="sg-small">Founding doctrine per faction (0–100). Descendants inherit a mean of their parents with small recorded mutations, so styles drift over generations.</p>
        </Sub>
        <Sub icon="brain" title="Inside a review (illustration)">
          <div class="sg-cands">
            <div class="sgc-h"><span>Candidate</span><span>U</span><span>L</span><span>Score</span></div>
            <div class="sgc chosen"><span><b>capture</b> a contested mine</span><span class="mono">0.71</span><span class="mono pos">+0.12</span><span class="mono">0.81</span></div>
            <div class="sgc"><span><b>attack</b> enemy rifles</span><span class="mono">0.64</span><span class="mono neg">−0.05</span><span class="mono">0.60</span></div>
            <div class="sgc"><span><b>fortify</b> the home ridge</span><span class="mono">0.52</span><span class="mono pos">+0.03</span><span class="mono">0.55</span></div>
          </div>
          <p class="sg-small">U = what its doctrine says, L = what experience says. The real list for any commander, every review, is in the <b>Agent dossier (09)</b>.</p>
        </Sub>
      </div>

      <Sub icon="arrow" title="A typical arc (measured over 3 simulated campaigns)">
        <div class="sg-arc">
          <span><b>1</b>Grab neutral land first: captures lead the opening minutes</span>
          <span><b>2</b>Push into weakly held enemy sites: attacks and raids are about a third of all plans</span>
          <span><b>3</b>Defend only under real pressure: about 3 plans in 10, down from more than half</span>
          <span><b>4</b>Drop everything for operation objectives: about a fifth</span>
        </div>
        <p class="sg-small">Taking an enemy-held site seizes its stockpile, and occupied sites pay half even before supply reaches them, so a well-chosen offensive pays. Badly chosen ones still bleed squads.</p>
      </Sub>

      <Sub icon="brain" title="Learning that counts">
        <p class="sg-small">After every plan a commander scores how much better or worse it went than its own average: sites, territory, value traded, operation points and its own world power. That advantage trains its value head (L), which learns which kinds of plan pay in which situations. Every commander in a faction also learns from its comrades' plans.</p>
        <p class="sg-small">Measured in paired forks of the same world on 12 maps: copies that kept their learned weights held <b>+0.42 sites</b>, <b>+11 hexes</b> and <b>+30 world power</b> more 13 simulated minutes later than identical copies with the weights wiped, with 95% intervals that exclude zero. The earlier learner showed no measurable effect on the same maps. Learning changes roughly 1 decision in 4.</p>
      </Sub>
    </Sec>
  );
}

// ------------------------------------------------------------------ 04
function Know({ ui }: { ui: UiSnapshot | null }) {
  return (
    <Sec id="know" n={4} title="What you need to know">
      <div class="sg-facts">
        <div class="sg-fact"><span class="sgs-i"><Icon name="shield" size={16} /></span><b>You never influence battles</b><p>Spectator commands only reach the camera and the ledger. Agents cannot see bets, prices or popularity.</p></div>
        <div class="sg-fact"><span class="sgs-i"><Icon name="coin" size={16} /></span><b>Credits are play money</b><p>{num(SIGNAL.initialGrant)} Signal at the start, +{SIGNAL.periodicGrant} claimable each campaign. They cannot be bought, sold or cashed out.{ui ? <> You hold <b class="mono">◈ {num(ui.wallet.available)}</b>.</> : null}</p></div>
        <div class="sg-fact"><span class="sgs-i"><Icon name="chart" size={16} /></span><b>Strength is not skill</b><p>World power is territory, forces and logistics. Skill is Elo from equal-budget, side-swapped duels in the proving ground. A big empire can have a mediocre commander.</p></div>
        <div class="sg-fact"><span class="sgs-i"><Icon name="lock" size={16} /></span><b>Fairness is checkable</b><p>Each operation's roster and a SHA-256 commitment to its seed lock before betting closes. The seed is revealed after settlement so you can verify it.</p></div>
      </div>
      <div class="sg-callout"><Icon name="coin" size={14} /><span>Stake cap per market: the smaller of {SIGNAL.stakeCapAbs} or {SIGNAL.stakeCapPct}% of your balance, fixed at your first entry. One outcome per market.</span></div>
    </Sec>
  );
}

// ------------------------------------------------------------------ 05
function Predict({ ui }: { ui: UiSnapshot | null }) {
  const op = ui?.operation ?? ui?.nextOperation ?? null;
  const cover = (t: number) => TERRAIN[t].def;
  const a = FACTIONS[0], b = FACTIONS[1];
  return (
    <Sec id="predict" n={5} title="How to predict well" lead={<>Objectives score <b>every second they are held</b>: the centre is worth 3, other objectives 2 or 1. So holding the centre early usually wins <b>Top score</b>, even after a late loss. The <b>Control</b> market is decided only at the final tick.</>}>
      <div class="sg-objs">
        <span class="sgo"><svg viewBox="0 0 32 32" width="30" height="30"><polygon points={hexPts(16, 16, 13)} class="sgo-c" /></svg><b>×3</b><em>centre</em></span>
        <span class="sgo"><svg viewBox="0 0 32 32" width="26" height="26"><polygon points={hexPts(16, 16, 11)} class="sgo-s" /></svg><b>×2</b><em>site</em></span>
        <span class="sgo"><svg viewBox="0 0 32 32" width="22" height="22"><polygon points={hexPts(16, 16, 9)} class="sgo-p" /></svg><b>×1</b><em>control point</em></span>
        <span class="sgo-note">points per second held</span>
      </div>
      <div class="sg-race">
        <div class="sgr-label">Illustration: who holds the centre over a {OP_MIN}-minute operation</div>
        <div class="sgr-bar"><span style={{ width: '60%', background: a.css }}>A holds 0–6 min</span><span style={{ width: '40%', background: b.css }}>B takes it 6–10</span></div>
        <div class="sgr-out">
          <span><b>Top score</b> A {num(3 * 360)} vs B {num(3 * 240)} → <b style={{ color: a.css }}>A wins</b></span>
          <span><b>Control at the final tick</b> → <b style={{ color: b.css }}>B's faction wins</b></span>
        </div>
      </div>

      <div class="sg-two">
        <Sub icon="check" title="At the cutoff, check">
          <ul class="sg-check">
            <li>Who holds each objective right now (07 Featured operation)</li>
            <li>Which squads are nearby, and what kind</li>
            <li>Whose supply reaches the zone (<b>Supply</b> layer)</li>
            <li>Nearby command cores and hubs that can reinforce</li>
            <li>Storms in the published schedule; they cut sight</li>
            <li>Pacts in 03 Diplomacy: partners will not shoot each other</li>
          </ul>
        </Sub>
        <Sub icon="swords" title="What wins fights">
          <div class="sg-units">
            {[U.WALKER, U.RIFLE, U.ARTILLERY, U.SCOUT, U.ENGINEER].map((c) => (
              <div key={c} class="sgu"><UnitIcon cls={c} color="#e1e6ee" size={16} /><b>{UNITS[c].name}</b><span>{UNITS[c].role}{UNITS[c].capture ? ` · capture ${UNITS[c].capture}` : ''}</span></div>
            ))}
          </div>
          <p class="sg-small">Walkers break lines: rifles deal only {DMG_MATRIX[U.RIFLE][U.WALKER]}% to them. Artillery deals {DMG_MATRIX[U.ARTILLERY][5]}% to structures but needs a spotter. High ground: <b>+15% damage</b>. Cover: forest {cover(T.FOREST)}%, ridge {cover(T.RIDGE)}%, ruins {cover(T.RUIN)}%, plus bunkers; marsh and crossings expose ({cover(T.MARSH)}%).</p>
        </Sub>
      </div>

      <div class="sg-two">
        <Sub icon="coin" title="How payouts work">
          <div class="sg-pay">
            <span class="mono">payout ≈ total pool ÷ pool on your pick</span>
            <em>Pool {num(1200)}, with {num(300)} on your pick → about <b>×4.00</b>: a 50 stake returns ~200.</em>
          </div>
          <p class="sg-small">Pari-mutuel, no house cut. The multiple on each outcome is an estimate at the current pool; the final one uses the pool at cutoff. The simulated crowd ({SIGNAL.npcCount} NPC bettors) tends to back the biggest empire, so a well-placed underdog can be value.</p>
        </Sub>
        <Sub icon="eye" title="Read intent, not just size">
          <p>Use the <b>fog buttons</b> on the map toolbar to see exactly what one side can observe, including last-known enemy ghosts. Turn on the <b>Agent plan</b> and <b>Agent memory</b> layers to see where the selected commander is heading and which tiles it fears.</p>
          <p>Every commitment is public: a <b>pulsing ring and name chip</b> mark a fresh target, the ticker says what the plan was chosen over, and the <b>Story</b> tab's plan board lists every live intent with its next review. Watch for converging intents on one site, a commander on a long ▲ streak, and the success rate of each plan kind (attacks on held sites fail far more often than captures of neutral ones). <b>Rivalries (10)</b> show who has the upper hand in a pairing before an operation even starts.</p>
          {op && <div class="sg-live"><span class="sg-live-dot" />Now: <b class="mono">{op.code}</b> {op.name} · {op.status} · {op.objectives.length} objectives</div>}
        </Sub>
      </div>
    </Sec>
  );
}

// ------------------------------------------------------------------ 06
const PANELS: [string, string, string][] = [
  ['01', 'Theatre status', 'clocks, territory share, squads, frontier expansion'],
  ['02', 'Factions', 'power trend, resources and income, unit mix, supply coverage'],
  ['03', 'Diplomacy', 'war / pact matrix and treaty notices'],
  ['04', 'Commander standings', 'world power, skill, merit and reliability, kept separate'],
  ['05', 'Team headquarters', 'same-faction charters, roles, objectives'],
  ['06', 'Published schedule', 'next operation, frontier, campaign, weather'],
  ['07', 'Featured operation', 'phase, live objective race, seed commitment'],
  ['08', 'Prediction desk', 'wallet, markets, stakes, receipts'],
  ['09', 'Agent dossier', 'plan, candidates (U / L / score), plan record and rivals, doctrine, memory, lineage'],
  ['10', 'Rivalries', 'head-to-head scores, clashes, named rivalries by recent heat'],
];
const TABS: [string, string][] = [
  ['Chronicle', 'searchable, append-only history with filters'],
  ['Story', 'plan board of every live intent, ranked moments, plan success by kind'],
  ['Analytics', 'territory, power, learning curve and Elo charts'],
  ['Proving ground', 'equal-budget duels that produce skill ratings'],
  ['Engine', 'tick budget, determinism hash, snapshots'],
  ['Ledger', 'double-entry invariants and recent postings'],
];
const SITE_KINDS = [S.CORE, S.DEPOT, S.TOWER, S.BUNKER, S.BRIDGE, S.RELAY, S.MINE, S.REFINERY, S.HUB, S.CITADEL];

function Screen() {
  return (
    <Sec id="screen" n={6} title="Reading the screen">
      <div class="sg-two">
        <div class="sg-panels">
          {PANELS.map(([n, t, d]) => <div key={n} class="sgp"><span class="mono">{n}</span><b>{t}</b><em>{d}</em></div>)}
        </div>
        <div>
          <div class="sg-panels">
            {TABS.map(([t, d]) => <div key={t} class="sgp"><span class="mono">tab</span><b>{t}</b><em>{d}</em></div>)}
          </div>
        </div>
      </div>
      <Sub icon="map" title="Map legend">
        <div class="sg-legend">
          {[U.SCOUT, U.RIFLE, U.WALKER, U.ENGINEER, U.ARTILLERY].map((c) => <span key={c}><UnitIcon cls={c} color="#e1e6ee" size={15} />{UNITS[c].name}</span>)}
        </div>
        <div class="sg-legend">
          {SITE_KINDS.map((k) => <span key={k}><SiteGlyph kind={k} />{STRUCTS[k].name}</span>)}
        </div>
        <div class="sg-legend">
          <span><i class="lg-front" />Front lines: where territories meet</span>
          <span><i class="lg-op" />Sealed operation zone</span>
          <span><i class="lg-frontier" />Frontier boundary: locked land beyond</span>
          <span><Icon name="eye" size={13} />Fog view: unseen land darkens, ghosts mark last-known enemies</span>
          <span><i class="lg-intent" />Intent ring: a commander's announced target (pulses and names itself when new)</span>
        </div>
        <p class="sg-small">Units and structures take their owner's colour; neutral sites are pale grey. Hover anything for details, click a squad to open its commander's dossier.</p>
      </Sub>
    </Sec>
  );
}

function SiteGlyph({ kind }: { kind: number }) {
  const c = kind === S.MINE || kind === S.REFINERY || kind === S.RELAY || kind === S.HUB || kind === S.CITADEL ? '#c8d0dc' : FACTIONS[0].css;
  const p = { width: 15, height: 15, viewBox: '0 0 16 16', class: 'uicon' };
  switch (kind) {
    case S.CORE: return <svg {...p}><polygon points={hexPts(8, 8, 6.5)} fill="none" stroke={c} stroke-width="1.8" /><polygon points={hexPts(8, 8, 3)} fill={c} /></svg>;
    case S.DEPOT: return <svg {...p}><rect x="3" y="3" width="10" height="10" rx="1.5" fill={c} /></svg>;
    case S.TOWER: return <svg {...p}><path d="M8 2 12 14H4z" fill={c} /></svg>;
    case S.BUNKER: return <svg {...p}><path d="M2 13a6 6 0 0 1 12 0z" fill={c} /></svg>;
    case S.BRIDGE: return <svg {...p}><path d="M1.5 9h13M3 9V6.5M13 9V6.5M3 6.5c2 2 8 2 10 0" stroke={c} stroke-width="1.6" fill="none" /></svg>;
    case S.RELAY: return <svg {...p}><path d="M8 14V6M5 3.5a4 4 0 0 1 6 0M3.2 1.8a6.5 6.5 0 0 1 9.6 0" stroke={c} stroke-width="1.5" fill="none" stroke-linecap="round" /></svg>;
    case S.CITADEL: return <svg {...p}><path d="M8 1 15 8 8 15 1 8z" fill="none" stroke="#ffd166" stroke-width="1.6" /><path d="M8 4.5 11.5 8 8 11.5 4.5 8z" fill="#ffd166" /></svg>;
    default: return <svg {...p}><path d="M8 2.5 13.5 8 8 13.5 2.5 8z" fill={kind === S.MINE ? '#c9a27a' : kind === S.REFINERY ? '#7fe7ff' : c} /></svg>;
  }
}

// ------------------------------------------------------------------ 07
const KEYS: [string, string][] = [
  ['← ↑ → ↓', 'Pan'], ['Q / E', 'Rotate left / right'], ['Z / C', 'Tilt up / down'], ['+ / −', 'Zoom in / out'],
  ['0', 'Fit the theatre'], ['N', 'North up'], ['F', 'Follow selected commander'], ['O', 'Operation camera'],
  ['D', 'Director: biggest story, else hottest battle'], ['G', 'Free camera'], ['Space', 'Pause / resume'], ['1 – 6', 'Speed 1× … 32×'],
  ['[ / ]', 'Previous / next commander'], ['V', 'Cycle fog-of-war view'], ['?', 'Help and shortcuts'], ['Esc', 'Close dialogs'],
];

function Controls() {
  return (
    <Sec id="controls" n={7} title="3D controls" lead="The battlefield is a full 3D theatre. Fly anywhere, at any angle, including out over the endless land past the frontier.">
      <div class="sg-two">
        <Sub icon="mouse" title="Mouse and touch">
          <div class="sg-keys">
            <span><kbd>Drag</kbd></span><em>Pan</em>
            <span><kbd>Right-drag</kbd> <kbd>Shift-drag</kbd></span><em>Rotate and tilt</em>
            <span><kbd>Wheel</kbd> <kbd>Pinch</kbd></span><em>Zoom</em>
            <span><kbd>Double-click</kbd></span><em>Fly to that point</em>
            <span><kbd>Click</kbd></span><em>Select a squad and its commander</em>
            <span><kbd>Minimap</kbd></span><em>Click or drag to move there</em>
          </div>
          <div class="sg-hud">
            <span class="sgh-rose"><Icon name="compass" size={18} /></span>
            <p>The <b>camera dial</b> at the bottom right shows which way is north; click it to face north. Its buttons rotate by 22.5°, tilt, zoom, fit the theatre, and switch between <b>Top</b>, <b>Oblique</b> and <b>Low</b> views.</p>
          </div>
        </Sub>
        <Sub icon="keyboard" title="Keyboard">
          <div class="sg-keys">
            {KEYS.map(([k, v]) => [<span key={`k${k}`}><kbd>{k}</kbd></span>, <em key={`v${k}`}>{v}</em>])}
          </div>
        </Sub>
      </div>
    </Sec>
  );
}
