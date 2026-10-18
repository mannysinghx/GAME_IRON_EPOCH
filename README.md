# IRON EPOCH — browser sandbox

An ongoing science-fiction war fought entirely by autonomous AI commanders, built from
[`IRON_EPOCH_Complete_Game_Design.md`](IRON_EPOCH_Complete_Game_Design.md). Humans spectate, study
commanders, and predict operation outcomes with free, nonredeemable virtual credits. No human input can
change an army's decisions.

This is the design doc's **private browser sandbox**: the whole authoritative world runs in a Web Worker in
your tab and persists to IndexedDB. Nothing calls an external service at runtime (fonts, scripts and workers
are bundled and served by the host).

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
| Left column | 01 Theatre status (clocks, territory share, squads, commanders, sites, combat heat) · 02 Factions (power trend, territory, sites, squads, K/D, stock & income per minute, unit mix, supply coverage, upkeep, published modifiers) · 03 Diplomacy (4×4 relation matrix, pacts) · 04 Commander standings (world power, skill Elo ± CI, merit, reliability — sortable, kept separate) · 05 Team headquarters · 06 Published schedule & weather |
| Battlefield | 2.5D extruded hex map, territory tint, glowing front lines, sealed operation region, tracers, artillery arcs, explosions, scorch marks, storms; fog-of-war view per faction with last-known enemy ghosts; selected agent's plan arrow, considered targets and danger memory; minimap; narrative ticker; hover tooltips |
| Right column | 07 Featured operation (phase machine, live objective race, objectives, seed commitment/reveal, recent results) · 08 Prediction desk (wallet, pari-mutuel markets with pools, shares and estimated returns, stake caps, receipts) · 09 Agent dossier (separate records, current plan, last review's candidate plans with doctrine U / learned L / score, doctrine radar with mutations, online-learning stats and learned weights, memory facts, decision log, lineage, forces, policy versions) |
| Bottom strip | Chronicle (filter + search) · Analytics (territory share, faction power, learning curve, Elo) · Proving ground (equal-budget ratings with Wilson intervals, recent duels) · Engine (tick p50/p95/p99 against the 200 ms budget, bounded caches, state hash history, snapshot, new world) · Ledger (invariants, totals, recent postings) |

Keys: `Space` pause · `1–6` speed · `F` follow · `O` operation camera · `D` director (hottest battle) ·
`G` free · `+/−` zoom · `0` fit · `[ ]` cycle commanders · `V` cycle fog view · `?` help.

## What the agents actually do

Decision hierarchy per the doc (§5.2): tactical rules every 200 ms tick → operational squad assignment every
3 s → strategic review every 60–120 s or after major events (quota-limited).

- **Strategic layer** = doctrine utility baseline (aggression, caution, logistics, expansion, loyalty,
  deception) **plus a per-agent online linear value head**. Each review scores 4–8 legal candidate plans from
  fog-filtered features; when a plan closes, its realized reward (sites, territory, value traded, operation
  score, goal achieved) updates the weights. Every 8 updates produces a new policy version. Exploration is
  ε-greedy with a decaying ε. There is **no language model** and no remote inference; the generative
  SmolLM2/wllama layer from §5.4–5.6 is not implemented.
- **Memory**: bounded facts (route failures, plan outcomes, opponent tendencies, inherited lessons) with
  provenance, age and decaying confidence.
- **Lineage**: veterans with 200 merit and 20 completed plans sponsor descendants (integer doctrine mean, at
  most two mutations of ±10, at most two inherited lessons, no inherited rating). Defeated commanders enter
  reserve; reconstruction costs merit; emergency reconstruction and citadel awakening follow §6.1.
- **Teams and diplomacy**: same-faction charters with roles, accepted or rejected by each invitee;
  non-aggression pacts between factions at campaign windows, terminated only with one operation of notice.
- **Skill vs power**: a second worker runs equal-budget, side-swapped duels with frozen policies on a small
  arena; Elo comes only from those.

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

`npm test` (6,000 ticks): identical state hashes for identical seeds; save → restore → +500 ticks yields an
identical hash; ledger balances after every tick; stake cap, idempotency and one-outcome rules enforced;
apportionment conserves pools; populations and memory bounded; 0 validator-rejected orders. Tick cost on
this machine: p50 ≈ 0.1 ms, p95 ≈ 0.6 ms against a 200 ms budget.

## Layout

```
apps/web/src/
  shared/   config (published rules), hex math, seeded RNG + SHA-256, worker protocol
  sim/      world (tick loop, combat, LOS, supply, economy), agents (planner, learning, memory),
            society (musters, lineage, teams, treaties, weather), operations, market, ledger,
            view builders, persistence, world worker, proving-ground worker, selftest
  render/   PixiJS renderer and procedural textures
  ui/       Preact panels, charts, store, styles
```
