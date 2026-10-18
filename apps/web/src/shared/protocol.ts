// Messages between the authoritative world worker and the spectator client (main thread).
// The client only ever receives committed public views; it never submits outcomes or balances
// (design doc §9.1). Spectator commands cannot reach agent decisions.

export const UNIT_STRIDE = 12; // id, cls, faction, owner, tile, next, t, hp, supply, morale, flags, target
export const STRUCT_STRIDE = 8; // id, kind, tile, faction, owner, hp, build, flags
export const FX_STRIDE = 6; // kind, a, b, faction, p1, p2
export const STRUCT_ID_BASE = 1_000_000;

export const UF = { RETREAT: 1, COMBAT: 2, BUILDING: 4, SUPPLIED: 8, SETUP: 16, VETERAN: 32, EVAC: 64 } as const;
export const SF = { BROKEN: 1, CONSTRUCTING: 2, OBJECTIVE: 4 } as const;
export const FX = { SHOT: 1, SHELL: 2, IMPACT: 3, DEATH: 4, CAPTURE: 5, BUILT: 6, DESTROYED: 7, SPAWN: 8, CORE_FALL: 9 } as const;

export interface SiteInfo { id: number; kind: number; tile: number; name: string }

/**
 * Static theatre description. Inside [0,w) x [0,h) use these arrays. Outside the theatre, the renderer draws
 * endless non-simulated scenery from shared/terrain.ts: sampleBaseTerrain(seed, c, r) and
 * isRiver(riverParams(seed, w, h), c, r) — the generator uses the same functions, so there is no seam.
 * `active` marks unlocked frontier chunks (1 = open to play); locked tiles are visible land but impassable.
 */
export interface MapStatic {
  w: number; h: number; seed: number; worldId: string; rulesVersion: string;
  terrain: Uint8Array; elev: Uint8Array; variant: Uint8Array;
  sites: SiteInfo[];
  active: Uint8Array;
  chunk: number;
}

/** Sent when frontier chunks open: the new active mask and the full current site list (new sites appear). */
export interface FrontierMsg { type: 'frontier'; active: Uint8Array; sites: SiteInfo[]; opened: number[]; version: number }

export interface FrontierView {
  open: number; total: number; nextTick: number; done: boolean; lastOpened: string[];
  activeCap: number; factionCap: number;
}

export interface FrameMsg {
  type: 'frame';
  tick: number;
  units: Float32Array;
  structs: Float32Array;
  fx: Float32Array;
  territory?: Int8Array; // faction per tile, -1 neutral
  owner?: Int16Array; // commander id per tile, -1
  supply?: Uint8Array; // bitmask of factions supplying each tile
  fog?: Uint8Array; // for the chosen viewing faction: 0 unseen, 1 remembered, 2 visible
  ghosts?: Float32Array; // last-known enemies: tile, cls, faction, age
  opRegion?: Int32Array | null;
  storms?: { tile: number; radius: number }[];
}

// ------------------------------------------------------------------ UI snapshot
export interface Res { alloy: number; energy: number; supply: number }

export interface FactionView {
  id: number; name: string; css: string;
  territory: number; territoryPct: number; sites: number; squads: number; byClass: number[];
  power: number; stock: Res; income: Res; upkeep: number;
  kills: number; losses: number; active: number; reserve: number; structures: number;
  powerHist: number[]; inSupplyPct: number; capBonus: number;
}

export interface PlanView {
  kind: string; target: string; targetTile: number; posture: string; reserve: number; reason: string;
  started: number; score: number; explored: boolean;
}

export interface CommanderView {
  id: number; key: string; name: string; faction: number; status: string; gen: number;
  power: number; territory: number; squads: number; sites: number;
  elo: number; eloCi: number; evalGames: number; provisional: boolean; winRate: number; winLo: number; winHi: number;
  merit: number; meritGross: number; meritSpent: number;
  kills: number; losses: number; reliability: number; fallbackRate: number;
  opsPlayed: number; opsWon: number; plans: number;
  policy: string; plan: PlanView | null; team: number; role: string;
  res: Res; errEma: number; updates: number; parents: number[]; children: number[];
  powerHist: number[];
}

export interface TeamView {
  id: number; faction: number; name: string; leader: number; members: { id: number; role: string; accepted: boolean }[];
  objective: string; budget: number; formed: number; expires: number; split: string; record: { ops: number; captures: number };
}

export interface TreatyView {
  id: number; a: number; b: number; kind: string; status: string; effective: number; expires: number; noticeAt: number;
}

export interface OpObjectiveView { tile: number; name: string; points: number; holder: number }

export interface OperationView {
  id: number; code: string; name: string; status: string; regionCenter: number; radius: number;
  roster: number[]; scores: { id: number; score: number; efficiency: number; supply: number }[];
  objectives: OpObjectiveView[];
  openTick: number; lockTick: number; startTick: number; endTick: number; settleTick: number;
  seedCommit: string; seedReveal: string | null; result: string | null; winner: number;
  merit: { id: number; amount: number }[];
}

export interface OutcomeView { id: string; label: string; css: string; pool: number; bettors: number; mine: number }

export interface MarketView {
  id: string; opId: number; question: string; kind: string; status: string;
  outcomes: OutcomeView[]; total: number; cutoffTick: number; endTick: number; specHash: string;
  myOutcome: string | null; myStake: number; myCap: number; result: string | null; resultLabel: string | null;
  note: string | null;
}

export interface ReceiptView {
  id: string; tick: number; marketId: string; kind: string; amount: number; text: string; opId: number;
}

export interface WalletView {
  name: string; available: number; escrow: number; bets: number; wins: number; losses: number; refunds: number;
  net: number; grantReady: boolean; nextGrantTick: number; receipts: ReceiptView[]; netHist: number[];
}

export interface LedgerView {
  txCount: number; balanced: boolean; minted: number; escrow: number; paid: number; refunded: number; retired: number;
  meritMinted: number; meritSpent: number; recent: { id: number; type: string; ref: string; tick: number; postings: [string, number][] }[];
}

export interface ChronEvent {
  id: number; tick: number; cat: string; text: string; f: number; a: number[]; tile: number;
}

export interface PerfView {
  tickP50: number; tickP95: number; tickP99: number; tps: number; targetTps: number; lagging: boolean;
  visMs: number; agentMs: number; flowFields: number; flowHits: number; flowMisses: number;
  frameBytes: number; entities: number; memoryFacts: number; decisions: number; lastSaveTick: number; saveBytes: number;
  stateHash: string; hashHist: { tick: number; hash: string }[];
}

export interface SeriesView {
  version: number; ticks: number[];
  territory: number[][]; power: number[][]; squads: number[][]; kills: number[][];
  learnErr: number[]; reward: number[]; elo: Record<number, number[]>;
}

export interface WeatherView { id: number; name: string; tile: number; radius: number; start: number; end: number; active: boolean }

export interface ProvingView {
  matches: number; running: boolean; recent: { id: number; a: number; b: number; seed: number; result: string; ticks: number; scoreA: number; scoreB: number; swapped: boolean }[];
}

export interface ClockView {
  tick: number; simSeconds: number; chapter: number; campaign: number; opIndex: number;
  campaignProgress: number; chapterProgress: number; nextCampaignTick: number; nextChapterTick: number;
}

export interface UiSnapshot {
  clock: ClockView; speed: number; paused: boolean;
  world: { id: string; seed: number; rules: string; squads: number; structures: number; events: number; generation: number };
  factions: FactionView[];
  relations: number[][]; // 0 war, 1 non-aggression, 2 notice given
  commanders: CommanderView[];
  teams: TeamView[];
  treaties: TreatyView[];
  operation: OperationView | null;
  nextOperation: OperationView | null;
  recentOps: OperationView[];
  markets: MarketView[];
  wallet: WalletView;
  ledger: LedgerView;
  chronicle: ChronEvent[]; // events newer than lastChronId sent
  perf: PerfView;
  series: SeriesView | null; // only when changed
  weather: WeatherView[];
  proving: ProvingView;
  battles: { tile: number; intensity: number }[];
  narrative: string[];
  frontier: FrontierView;
}

// ------------------------------------------------------------------ dossier
export interface MemoryView { kind: string; tile: number; place: string; value: number; conf: number; age: number; src: string }
export interface CandidateView { kind: string; target: string; tile: number; U: number; L: number; score: number; feats: number[]; chosen: boolean }
export interface DecisionView {
  id: string; tick: number; obsHash: string; obsSize: number; policy: string; chosen: string; target: string;
  reason: string; posture: string; reserve: number; explored: boolean; fallback: boolean; candidates: CandidateView[];
  reward: number | null;
}

export interface Dossier {
  id: number; key: string; name: string; faction: number; status: string; gen: number; born: number; birthKind: string;
  doctrine: number[]; mutation: { param: string; delta: number }[];
  policy: string; policyHash: string; policyHistory: { tick: number; version: string; note: string }[];
  weights: number[]; featureNames: string[]; planNames: string[];
  updates: number; errEma: number; rewardEma: number; epsilon: number;
  memory: MemoryView[]; decisions: DecisionView[];
  plan: (PlanView & { group: number[] }) | null;
  lineage: { ancestors: { id: number; name: string; gen: number; status: string }[]; children: { id: number; name: string; gen: number; status: string }[] };
  hist: { power: number[]; merit: number[]; elo: number[]; err: number[] };
  squads: { id: number; cls: number; hp: number; task: string }[];
  stats: Record<string, number>;
  team: TeamView | null;
  res: Res; queue: { cls: number; left: number }[];
  dangerTiles: { tile: number; conf: number }[];
}

// ------------------------------------------------------------------ commands to the world worker
export type ClientCmd =
  | { type: 'init'; resume: boolean; seed?: number }
  | { type: 'speed'; speed: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'select'; id: number }
  | { type: 'viewFaction'; f: number }
  | { type: 'bet'; marketId: string; outcomeId: string; stake: number; idem: string }
  | { type: 'claimGrant'; idem: string }
  | { type: 'rename'; name: string }
  | { type: 'newWorld'; seed: number }
  | { type: 'save' }
  | { type: 'evalResult'; result: EvalResult };

export interface PolicySnapshot {
  id: number; name: string; doctrine: number[]; weights: number[]; policy: string;
}

export interface EvalMatch { id: number; seed: number; a: PolicySnapshot; b: PolicySnapshot; swapped: boolean }
export interface EvalResult { id: number; a: number; b: number; seed: number; swapped: boolean; winner: 'a' | 'b' | 'draw'; scoreA: number; scoreB: number; ticks: number; hash: string }

export type WorkerMsg =
  | { type: 'static'; map: MapStatic }
  | FrameMsg
  | { type: 'ui'; ui: UiSnapshot }
  | { type: 'dossier'; d: Dossier | null }
  | { type: 'toast'; level: 'ok' | 'warn' | 'err' | 'info'; text: string }
  | { type: 'evalRequest'; match: EvalMatch }
  | FrontierMsg
  | { type: 'ready'; resumed: boolean };
