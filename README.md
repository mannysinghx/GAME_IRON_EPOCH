# IRON EPOCH — browser sandbox

An ongoing science-fiction war fought entirely by autonomous AI commanders, built from
[`IRON_EPOCH_Complete_Game_Design.md`](IRON_EPOCH_Complete_Game_Design.md). Humans spectate, study
commanders, and predict operation outcomes with free, nonredeemable virtual credits. No human input can
change an army's decisions.

This is the design doc's **private browser sandbox**: the whole authoritative world runs in a Web Worker in
your tab and persists to IndexedDB. Nothing calls an external service at runtime (fonts, scripts, workers and
three.js are bundled and served by the host).

- **3D battlefield** (three.js): zoom, yaw, tilt and pan anywhere; presets Top / Oblique / Low; bloom and soft
  shadows (toggle in Layers).
- **Expanding frontier**: the simulated theatre starts as the central 64 × 64 of a 128 × 128 map and opens four
  mirrored 16 × 16 chunks every 20 simulated minutes, each with new sites and a founding wave of commanders,
  until the 128 × 128 launch budget is reached (design §3.4). Beyond it the land continues forever as streamed,
  non-simulated scenery generated from the same terrain field, so there is no seam.
- **Game Strategy** button (top bar) opens a guide to how the war works and how to read and predict it.

## Run

```bash
cd apps/web && npm install && npm run dev
```

Open http://127.0.0.1:5317. Other scripts: `npm test` (headless simulation checks), `npm run typecheck`,
`npm run build` (static bundle in `apps/web/dist`, ~1.7 MB including fonts).

## What is on screen

| Area | Contents |
| --- | --- |
| Top bar | Live/paused state, chapter · campaign · operation phase, simulation clock, speed (pause, 1×–32×), tick + rolling state hash, sim ticks/s and render FPS, Signal balance |
| Left column | 01 Theatre status (clocks, territory share, squads, commanders, sites, combat heat) · 02 Factions (power trend, territory, sites, squads, K/D, stock & income per minute, unit mix, supply coverage, upkeep, published modifiers) · 03 Diplomacy (4×4 relation matrix, pacts) · 04 Commander standings (world power, skill Elo ± CI, merit, reliability — sortable, kept separate) · 05 Team headquarters · 06 Published schedule & weather · 10 Rivalries (head-to-head scores with kills, sites, cores and operations behind them; named rivalries ranked by recent heat) |
| Battlefield | 2.5D extruded hex map, territory tint, glowing front lines, sealed operation region, tracers, artillery arcs, explosions, scorch marks, storms; fog-of-war view per faction with last-known enemy ghosts; selected agent's plan arrow, considered targets and danger memory; every commander's announced target (ring, plus a pulse and name chip when new); story headline banner; story ticker; minimap; hover tooltips |
| Right column | 07 Featured operation (phase machine, live objective race, objectives, seed commitment/reveal, recent results) · 08 Prediction desk (wallet, pari-mutuel markets with pools, shares and estimated returns, stake caps, receipts) · 09 Agent dossier (separate records, current plan with the plan it was chosen over and its next review, plan record and streak, top rivals, last review's candidate plans with doctrine U / learned L / score, doctrine radar with mutations, online-learning stats and learned weights, memory facts, decision log, lineage, forces, policy versions) |
| Bottom strip | Chronicle (filter + search) · Story (plan board of every live intent, ranked moments, plan success by kind) · Analytics (territory share, faction power, learning curve, Elo) · Proving ground (equal-budget ratings with Wilson intervals, recent duels) · Engine (tick p50/p95/p99 against the 200 ms budget, bounded caches, state hash history, snapshot, new world) · Ledger (invariants, totals, recent postings) |

Camera: drag to pan, right-drag or shift-drag to rotate and tilt, wheel or pinch to zoom, double-click to fly to
a point. Keys: arrows pan · `Q/E` rotate · `Z/C` tilt · `+/−` zoom · `0` fit · `N` north · `F` follow ·
`O` operation · `D` director (biggest fresh story moment, else hottest battle) · `G` free · `Space` pause · `1–6` speed · `[ ]` cycle commanders · `V` fog view ·
`?` help.

## Story layer (spectator presentation)

`sim/story.ts` turns committed events into three things a watcher can follow. It only reads simulation state and writes its
own bounded records: no RNG, no agent input, no effect on combat, economy or markets (the selftest runs one seed with it on and
off and gets bit-identical hashes). Texts state accepted plan ids, observed facts and results only (design §15.4).

- **Plan announcements**: every strategic review is announced with the runner-up it was chosen over and the score margin;
  the next review stamps a verdict (✔ objective met with positive reward, ≈ met at a net cost, ✘ not met) next to the
  learner's own reward. Per-commander records and streaks, and success rates per plan kind (in test runs captures of
  neutral sites succeed about 60% of the time, attacks on held sites about 35%).
- **Moments**: rule-based detectors with a weight (how big the story is): core falls and revenge (including a parent's),
  last stands, ordered core assaults, sites changing hands again and again, retakes, upsets against the pool, photo
  finishes and lead changes in operations, faction lead changes and comebacks, pacts, notices and the first blood after
  a pact ends, long streaks and slumps, rivalries. Moments go to the chronicle under `story`; weight 60+ flashes on the
  map; the Director camera cuts to the best fresh one (falling back to the hottest battle).
- **Rivalries**: head-to-head score per commander pair (kills + 4 × sites taken + 15 × cores felled + 6 × operations
  finished ahead), counted in clashes; named once mutual. Shown in section 10, the dossier and the featured operation.

Snapshots carry the story records as an optional field; worlds saved before it resume with an empty story (no save
version bump, so no world is discarded).

## What the agents actually do

Decision hierarchy per the doc (§5.2): tactical rules every 200 ms tick → operational squad assignment every
3 s → strategic review every 60–120 s or after major events (quota-limited).

- **Strategic layer** = doctrine utility baseline (aggression, caution, logistics, expansion, loyalty,
  deception) **plus an online linear value head**. Each review scores 4–8 legal candidate plans from
  fog-filtered features. When a plan closes, its *advantage* (reward minus the commander's own running mean;
  reward counts sites, territory, value traded, operation points and the commander's own world power, per
  90 s of plan time) updates the head; every commander in the faction replays the update at a fraction of the
  rate. Every 8 updates produces a new policy version; exploration is ε-greedy with a decaying ε. There is
  **no language model** and no remote inference (the SmolLM2/wllama layer of §5.4–5.6 is not implemented).
- **Measured behaviour** (headless, 3 seeds × one campaign): DEFEND fell from 53% of decisions to about 29%,
  offensive plans (attack, raid, core assault, sabotage) rose from about 11% to 36%, and enemy-held sites changed
  hands about 3× as often. Learning effect, in paired forks of the same world with one commander's learned weights
  wiped (12 maps, 141 pairs, seed-level 95% intervals): +0.42 sites [0.22, 0.62], +11 hexes [5.1, 16.9],
  +30 world power [7.0, 53.7] 4,000 ticks later; the previous learner measured −5 power [−22, 12] on the same maps.
- **Memory**: bounded facts (route failures, plan outcomes, opponent tendencies, inherited lessons) with
  provenance, age and decaying confidence.
- **Lineage**: veterans with 200 merit and 20 completed plans sponsor descendants (integer doctrine mean, at
  most two mutations of ±10, at most two inherited lessons, no inherited rating). Defeated commanders enter
  reserve; reconstruction costs merit; emergency reconstruction and citadel awakening follow §6.1.
- **Teams and diplomacy**: same-faction charters with roles, accepted or rejected by each invitee;
  non-aggression pacts between factions at campaign windows, terminated only with one operation of notice.
- **Skill vs power**: a second worker runs equal-budget, side-swapped duels with frozen policies on a small
  arena; Elo comes only from those. Both sides of a duel run on an identical decision schedule, so a commander's id cannot
  tilt its rating. Operation rosters (at most three factions) go to the factions with the most presence at the
  front, with ties to whoever has had fewer recent places — never to faction id.

## Honest scope

Implemented in TypeScript for the browser: deterministic integer combat and economy (seeded sfc32, stable id
order), line of sight, logistics and supply networks, five unit classes, structures and bridges, operations
with sealed regions and SHA-256 seed commitments, double-entry ledger, pari-mutuel settlement with
largest-remainder apportionment and refund rules, persistence.

Not implemented (later phases of the design): the Rust sim-core/WASM, Axum + PostgreSQL authoritative host,
multi-user accounts, 10 s delayed public feed, generative policy, Kokoro narration. Clocks are compressed
for the sandbox (operation 10 min, campaign 60 min, chapter 6 campaigns of simulation time). Balance numbers
are tuning parameters, not measured claims. Simulated spectators (36 NPC bettors using public information
only) create pools so markets have depth; they are labelled as such in code.

## Verified

`npm test` (12,000 ticks): identical state hashes for identical seeds; the story layer leaves the hash unchanged and its records survive save → restore; every decision is announced and every verdict carries the learner's reward; head-to-head kills reconcile with commander kill counts; each detector fires on a scripted event; save → restore → +500 ticks yields an
identical hash, including after a frontier opening; ledger balances after every tick; stake cap, idempotency
and one-outcome rules enforced; apportionment conserves pools; populations and memory bounded; frontier opens
on schedule with every site instantiated exactly once and no squad ever on closed land; 0 validator-rejected
orders. Tick cost on this machine: p50 0.20 / p95 0.71 / p99 1.09 ms; at the 24-commander launch load
(~315 squads) p95 ≈ 1.6 ms, against a 200 ms budget.

## Layout

```
apps/web/src/
  shared/   config (published rules), hex math, seeded RNG + SHA-256, worker protocol
  sim/      world (tick loop, combat, LOS, supply, economy), agents (planner, learning, memory),
            society (musters, lineage, teams, treaties, weather), operations, market, ledger,
            view builders, persistence, world worker, proving-ground worker, selftest
  render/   api.ts (renderer contract) and three/ (3D renderer: terrain, endless scenery, units,
            structures, effects, overlays, labels, camera rig)
  ui/       Preact panels, charts, store, styles
```
