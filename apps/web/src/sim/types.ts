// Authoritative simulation state. Plain data so the whole world can be serialized for persistence.

export const TASK = {
  IDLE: 0, MOVE: 1, ATTACK_MOVE: 2, HOLD: 3, RETREAT: 4, BUILD: 5, REPAIR: 6, SCOUT: 7, EVACUATE: 8, ATTACK_STRUCT: 9,
} as const;
export const TASK_NAMES = ['idle', 'move', 'attack-move', 'hold', 'retreat', 'build', 'repair', 'scout', 'evacuate', 'attack-structure'];

export interface Squad {
  id: number; cls: number; owner: number; faction: number;
  tile: number; next: number; prog: number;
  hp: number; maxHp: number; supply: number; morale: number; supp: number;
  cd: number; task: number; tgt: number; tgtStruct: number; buildKind: number;
  retreat: boolean; combatT: number; kills: number; born: number; lastTarget: number; setup: number;
  stuck: number; group: number; // 0 none, 1 assault, 2 reserve, 3 scout, 4 engineer, 5 artillery
  hitBy: number; engageT: number;
}

export interface Struct {
  id: number; kind: number; tile: number; owner: number; faction: number;
  hp: number; maxHp: number; built: number; need: number; name: string; cd: number; broken: boolean; hitBy: number;
}

export interface MemoryFact {
  kind: 'DANGER' | 'PLAN_OUTCOME' | 'OPP_TENDENCY' | 'TREATY' | 'LESSON';
  tile: number; subject: number; value: number; conf: number; tick: number; src: string;
}

export interface Candidate {
  kind: number; tile: number; struct: number; name: string;
  feats: number[]; U: number; L: number; score: number;
}

export interface DecisionRecord {
  id: string; tick: number; obsHash: string; obsSize: number; policy: string;
  chosen: number; candidates: Candidate[]; reason: string; posture: string; reserve: number;
  explored: boolean; fallback: boolean; reward: number | null;
}

export interface PlanBase { sites: number; territory: number; valueKilled: number; valueLost: number; opScore: number; hp: number; supplied: number; power?: number }

export interface Plan {
  kind: number; tile: number; struct: number; name: string;
  posture: string; reserve: number; reason: string; started: number;
  psi: number[]; score: number; decisionId: string; explored: boolean;
  base: PlanBase; group: number[]; done: boolean;
  /** Unanswered enemy pressure on the target when the plan began (0..1); scales a DEFEND plan's success bonus. */
  pressure?: number;
}

export interface CmdStats {
  kills: number; losses: number; captures: number; opsPlayed: number; opsWon: number; plans: number;
  valueKilled: number; valueLost: number; built: number; spent: number; produced: number;
}

export interface Commander {
  id: number; key: string; name: string; faction: number; status: 'active' | 'reserve' | 'retired';
  gen: number; parents: number[]; children: number[]; born: number; birthKind: string;
  doctrine: number[]; mutation: { param: string; delta: number }[];
  policyMajor: number; policyMinor: number; policyHash: string;
  policyHistory: { tick: number; version: string; note: string }[];
  lw: number[]; updates: number; errEma: number; rewardEma: number;
  memory: MemoryFact[];
  res: { alloy: number; energy: number; supply: number };
  coreId: number; homeTile: number;
  queue: { cls: number; left: number }[];
  plan: Plan | null;
  nextStrategic: number; nextOperational: number; lastReview: number;
  stats: CmdStats;
  meritAcct: number; meritGross: number; meritSpent: number;
  elo: number; evalGames: number; evalWins: number; evalDraws: number;
  rel: { issued: number; rejected: number; fallbacks: number; decisions: number };
  decisions: DecisionRecord[];
  hist: { power: number[]; merit: number[]; elo: number[]; err: number[] };
  team: number; role: string;
  reserveSince: number; lastDescendant: number; underSupplied: boolean;
  campaignBase: { sites: number; territory: number };
  trust: Record<number, number>;
  power: number;
  lastIncome: { alloy: number; energy: number; supply: number }; lastUpkeep: number; awaiting: boolean;
}

export interface Intel { id: number; kind: number; tile: number; faction: number; tick: number }

export interface Ghost { id: number; tile: number; cls: number; faction: number; tick: number }

export interface FactionState {
  id: number;
  lastSeen: Int32Array; knownOwner: Int8Array; visible: Uint8Array; inSupply: Uint8Array; supplyDist: Int16Array;
  ghosts: Ghost[]; intel: Intel[];
  hostility: number[]; trust: number[];
  capBonus: number; citadel: boolean; kills: number; losses: number;
  reserveEntry: number;
  powerHist: number[];
}

export interface Team {
  id: number; faction: number; name: string; leader: number;
  members: { id: number; role: string; accepted: boolean }[];
  objective: string; budget: number; formed: number; expires: number; split: string;
  record: { ops: number; captures: number };
}

export interface Treaty {
  id: number; a: number; b: number; kind: 'NAP'; status: 'active' | 'notice' | 'ended';
  effective: number; expires: number; noticeAt: number; endsAt: number;
}

export interface OpObjective { tile: number; name: string; points: number; holder: number }

export interface Operation {
  id: number; code: string; name: string;
  status: 'Scheduled' | 'Open' | 'Locked' | 'Running' | 'Provisional' | 'Settled' | 'Voided';
  center: number; radius: number; region: number[]; roster: number[]; objectives: OpObjective[];
  openTick: number; lockTick: number; startTick: number; endTick: number; settleTick: number;
  seed: number; seedHex: string; commit: string; revealed: boolean;
  scores: Record<number, number>; spent: Record<number, number>; supplyTicks: Record<number, number>;
  evidence: number; // rolling hash of scoring evidence
  result: string | null; winner: number; merit: { id: number; amount: number }[];
  rngState: number[];
}

export interface Bet { id: string; account: number; outcome: string; stake: number; tick: number }

export interface Market {
  id: string; opId: number; kind: 'TOP_SCORE' | 'CONTROL'; question: string;
  status: Operation['status'];
  outcomes: { id: string; label: string; faction: number }[];
  bets: Bet[]; caps: Record<number, number>; positions: Record<number, string>;
  escrowAcct: number; cutoffTick: number; endTick: number; specHash: string;
  result: string | null; note: string | null; subjectFaction: number; subjectTile: number;
  lockedTotals: Record<string, number> | null;
}

export interface LedgerAccount { id: number; owner: string; currency: 'SIG' | 'MERIT'; kind: 'available' | 'escrow' | 'issuance' | 'sink' | 'treasury' }
export interface LedgerTx { id: number; type: string; ref: string; idem: string; tick: number; postings: [number, number][] }

export interface LedgerState {
  accounts: LedgerAccount[]; balances: number[]; txs: LedgerTx[]; idem: string[]; nextTx: number;
  totals: { minted: number; paid: number; refunded: number; retired: number; meritMinted: number; meritSpent: number };
}

export interface Npc { id: number; name: string; style: 'power' | 'skill' | 'form' | 'contrarian' | 'random' | 'loyal'; acct: number; favFaction: number; nextAct: number }

export interface Wallet {
  name: string; acct: number; grantLastCampaign: number; bets: number; wins: number; losses: number; refunds: number; net: number;
  receipts: { id: string; tick: number; marketId: string; kind: string; amount: number; text: string; opId: number }[];
  netHist: number[];
}

export interface Weather { id: number; name: string; tile: number; radius: number; start: number; end: number }

export interface ChronEntry { id: number; tick: number; cat: string; text: string; f: number; a: number[]; tile: number }

export interface Series {
  version: number; ticks: number[]; territory: number[][]; power: number[][]; squads: number[][]; kills: number[][];
  learnErr: number[]; reward: number[];
}

export interface EvalRecord { id: number; a: number; b: number; seed: number; result: string; ticks: number; scoreA: number; scoreB: number; swapped: boolean }
