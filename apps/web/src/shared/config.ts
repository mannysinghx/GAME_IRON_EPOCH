// Published rules for the IRON EPOCH sandbox. Every number here is a tuning parameter, not a
// measured result (design doc §14). Faction modifiers are public and budget-neutral by intent.

export const RULES_VERSION = 'r1.0.0-sandbox';
export const SAVE_VERSION = 6;

export const TICK_HZ = 5;
export const TICK_MS = 200;

// Full launch-target theatre (design doc §3.2): 128 x 128 hexes in 16 x 16 chunks. The world starts with the
// central 64 x 64 (MVP size) open and unlocks frontier chunks over time, up to this bounded budget.
export const MAP_W = 128;
export const MAP_H = 128;
export const CHUNK = 16;

export const FRONTIER = {
  initialMin: 2, // initially open chunk range (inclusive) on both axes: chunks 2..5 = tiles 32..95
  initialMax: 5,
  firstAt: 6000, // first expansion after 20 simulation minutes
  interval: 6000, // then every 20 simulation minutes
  perEvent: 4, // one chunk per quadrant, mirrored, so expansion stays balanced
} as const;

// ---------------------------------------------------------------- clocks (in ticks)
// Sandbox compression: the doc's 6 h campaign / 7 day chapter are compressed so a viewer can see
// musters, team charters, and chapter boundaries in a single session.
export const CLOCK = {
  OP_RUN: 3000, // 10 simulation minutes
  OP_OPEN_LEAD: 900, // market opens 3 minutes before deployment
  OP_LOCK_LEAD: 150, // market closes 30 seconds before deployment
  OP_VERIFY: 50, // provisional evidence check, 10 s
  CAMPAIGN: 18000, // 60 simulation minutes
  CHAPTER: 108000, // 6 campaigns
  STRATEGIC_MIN: 300, // 60 s
  STRATEGIC_MAX: 600, // 120 s
  REVIEW_QUOTA: 100, // minimum gap between event-triggered reviews
  OPERATIONAL: 15, // 3 s, staggered per commander
  ECON: 25,
  SUPPLY: 25,
  CAPTURE: 5,
  VIS: 3,
  SAMPLE: 150, // analytics sample every 30 s
  DECAY: 150,
} as const;

export const POP = {
  ACTIVE_CAP: 12, // with the initial 16 chunks; grows by 1 per 4 chunks opened, up to ACTIVE_MAX
  ACTIVE_MAX: 24, // launch target (§14)
  FACTION_CAP: 3, // grows by 1 per 12 chunks opened, up to FACTION_MAX
  FACTION_MAX: 6,
  RESERVE_CAP: 8,
  SQUADS_PER_CMD: 16,
  MUSTER_MAX: 2,
  SPONSOR_MERIT: 200,
  SPONSOR_PLANS: 20,
  RECON_MERIT: 100,
} as const;

// ---------------------------------------------------------------- terrain
export const T = {
  PLAINS: 0, FOREST: 1, RIDGE: 2, RUIN: 3, MARSH: 4, ROAD: 5, RIVER: 6, CROSSING: 7,
} as const;

export interface TerrainDef {
  key: string; name: string;
  cost: number; // movement cost units (plains = 10); 0 = impassable
  def: number; // cover percent
  blocks: boolean; // blocks line of sight through the tile
  sight: number; // sight bonus when standing on it
  color: number;
}

export const TERRAIN: TerrainDef[] = [
  { key: 'plains', name: 'Plains', cost: 10, def: 0, blocks: false, sight: 0, color: 0x2a3038 },
  { key: 'forest', name: 'Forest', cost: 16, def: 25, blocks: true, sight: 0, color: 0x1f2b27 },
  { key: 'ridge', name: 'Ridge', cost: 22, def: 20, blocks: true, sight: 2, color: 0x3a3e46 },
  { key: 'ruin', name: 'Industrial ruin', cost: 14, def: 30, blocks: true, sight: 0, color: 0x332f2c },
  { key: 'marsh', name: 'Marsh', cost: 24, def: -10, blocks: false, sight: 0, color: 0x243030 },
  { key: 'road', name: 'Road', cost: 6, def: 0, blocks: false, sight: 0, color: 0x353a42 },
  { key: 'river', name: 'River', cost: 0, def: 0, blocks: false, sight: 0, color: 0x14304a },
  { key: 'crossing', name: 'River crossing', cost: 9, def: -10, blocks: false, sight: 0, color: 0x3b3326 },
];

// ---------------------------------------------------------------- units
export const U = { SCOUT: 0, RIFLE: 1, WALKER: 2, ENGINEER: 3, ARTILLERY: 4 } as const;

export interface UnitDef {
  key: string; name: string; short: string;
  hp: number; armor: number; atk: number; range: number; minRange: number; sight: number;
  speed: number; // movement progress per tick; a tile needs cost*10 progress
  cd: number; // ticks between shots
  alloy: number; energy: number; build: number; // build ticks
  upkeep: number; capture: number;
  power: number; // planning strength weight
  armored: boolean;
  role: string;
}

export const UNITS: UnitDef[] = [
  { key: 'scout', name: 'Scout', short: 'SCT', hp: 60, armor: 0, atk: 4, range: 2, minRange: 0, sight: 7, speed: 17, cd: 5, alloy: 30, energy: 10, build: 45, upkeep: 1, capture: 1, power: 0.45, armored: false, role: 'Visibility and objective reconnaissance' },
  { key: 'rifle', name: 'Rifle squad', short: 'RFL', hp: 110, armor: 1, atk: 8, range: 2, minRange: 0, sight: 4, speed: 11, cd: 5, alloy: 50, energy: 5, build: 65, upkeep: 1, capture: 3, power: 1.0, armored: false, role: 'Flexible capture and garrison' },
  { key: 'walker', name: 'Assault walker', short: 'WLK', hp: 300, armor: 5, atk: 18, range: 3, minRange: 0, sight: 4, speed: 8, cd: 8, alloy: 140, energy: 60, build: 150, upkeep: 3, capture: 2, power: 2.6, armored: true, role: 'Break a defended line' },
  { key: 'engineer', name: 'Engineer convoy', short: 'ENG', hp: 85, armor: 1, atk: 3, range: 1, minRange: 0, sight: 4, speed: 11, cd: 8, alloy: 60, energy: 20, build: 80, upkeep: 1, capture: 1, power: 0.35, armored: false, role: 'Repair, bridges, supply nodes' },
  { key: 'artillery', name: 'Artillery battery', short: 'ART', hp: 90, armor: 1, atk: 25, range: 6, minRange: 2, sight: 3, speed: 7, cd: 22, alloy: 120, energy: 50, build: 140, upkeep: 2, capture: 0, power: 1.8, armored: false, role: 'Pressure fixed positions; needs spotting' },
];

/** Damage percent multiplier [attacker][defender]; defender index 5 = structure. */
export const DMG_MATRIX: number[][] = [
  [100, 70, 15, 100, 100, 20],
  [120, 100, 35, 120, 110, 40],
  [130, 130, 110, 130, 140, 150],
  [60, 60, 40, 60, 60, 50],
  [110, 110, 70, 110, 100, 160],
];

// ---------------------------------------------------------------- structures
export const S = {
  CORE: 0, DEPOT: 1, TOWER: 2, BUNKER: 3, BRIDGE: 4, RELAY: 5, MINE: 6, REFINERY: 7, HUB: 8, CITADEL: 9,
} as const;

export interface StructDef {
  key: string; name: string; hp: number; armor: number; atk: number; range: number; cd: number; sight: number;
  alloy: number; energy: number; build: number; capturable: boolean; destructible: boolean; value: number;
  supplyRadius: number;
}

export const STRUCTS: StructDef[] = [
  { key: 'core', name: 'Command core', hp: 1400, armor: 4, atk: 14, range: 3, cd: 6, sight: 6, alloy: 0, energy: 0, build: 0, capturable: false, destructible: true, value: 1.0, supplyRadius: 14 },
  { key: 'depot', name: 'Supply depot', hp: 320, armor: 2, atk: 0, range: 0, cd: 0, sight: 3, alloy: 80, energy: 20, build: 150, capturable: false, destructible: true, value: 0.5, supplyRadius: 8 },
  { key: 'tower', name: 'Watchtower', hp: 200, armor: 1, atk: 0, range: 0, cd: 0, sight: 9, alloy: 50, energy: 10, build: 90, capturable: false, destructible: true, value: 0.3, supplyRadius: 0 },
  { key: 'bunker', name: 'Bunker', hp: 520, armor: 3, atk: 10, range: 2, cd: 6, sight: 4, alloy: 90, energy: 10, build: 170, capturable: false, destructible: true, value: 0.4, supplyRadius: 0 },
  { key: 'bridge', name: 'Bridge', hp: 260, armor: 2, atk: 0, range: 0, cd: 0, sight: 0, alloy: 70, energy: 0, build: 120, capturable: false, destructible: true, value: 0.45, supplyRadius: 0 },
  { key: 'relay', name: 'Relay station', hp: 0, armor: 0, atk: 0, range: 0, cd: 0, sight: 6, alloy: 0, energy: 0, build: 0, capturable: true, destructible: false, value: 0.6, supplyRadius: 0 },
  { key: 'mine', name: 'Alloy mine', hp: 0, armor: 0, atk: 0, range: 0, cd: 0, sight: 2, alloy: 0, energy: 0, build: 0, capturable: true, destructible: false, value: 0.55, supplyRadius: 0 },
  { key: 'refinery', name: 'Reactor refinery', hp: 0, armor: 0, atk: 0, range: 0, cd: 0, sight: 2, alloy: 0, energy: 0, build: 0, capturable: true, destructible: false, value: 0.55, supplyRadius: 0 },
  { key: 'hub', name: 'Fabrication hub', hp: 0, armor: 0, atk: 0, range: 0, cd: 0, sight: 3, alloy: 0, energy: 0, build: 0, capturable: true, destructible: false, value: 0.72, supplyRadius: 6 },
  { key: 'citadel', name: 'Neutral citadel', hp: 0, armor: 0, atk: 0, range: 0, cd: 0, sight: 7, alloy: 0, energy: 0, build: 0, capturable: true, destructible: false, value: 0.88, supplyRadius: 7 },
];

// ---------------------------------------------------------------- factions
export interface FactionMods {
  speed: number; sight: number; structHp: number; buildCost: number; prodTime: number; income: number;
  supplyDrain: number; dmgOut: number; dmgIn: number; capture: number; heal: number; jam: number;
}

export interface FactionDef {
  id: number; key: string; name: string; identity: string; strength: string; tradeoff: string;
  color: number; css: string; dim: string; mods: FactionMods;
  doctrine: number[]; // founding doctrine centre
  names: string[];
}

const NO_MODS: FactionMods = { speed: 0, sight: 0, structHp: 0, buildCost: 0, prodTime: 0, income: 0, supplyDrain: 0, dmgOut: 0, dmgIn: 0, capture: 0, heal: 0, jam: 0 };
export const NEUTRAL_MODS = NO_MODS;

export const FACTIONS: FactionDef[] = [
  {
    id: 0, key: 'bastion', name: 'Bastion', identity: 'Fortification network', strength: 'Defense and recovery', tradeoff: 'Slow expansion',
    color: 0x5aa9ff, css: '#5aa9ff', dim: '#1d3a5c',
    mods: { ...NO_MODS, speed: -8, structHp: 25, buildCost: -25, heal: 40, capture: -15 },
    doctrine: [40, 70, 60, 35, 70, 25],
    names: ['Cairn', 'Rampart', 'Bulwark', 'Aegis', 'Palisade', 'Warden', 'Basalt', 'Keep', 'Talus', 'Gable', 'Mortar', 'Lintel'],
  },
  {
    id: 1, key: 'vector', name: 'Vector', identity: 'Mobile coalition', strength: 'Reconnaissance and flanking', tradeoff: 'Fragile supply lines',
    color: 0xffb547, css: '#ffb547', dim: '#5a3f14',
    mods: { ...NO_MODS, speed: 15, sight: 1, supplyDrain: 30, structHp: -10 },
    doctrine: [70, 30, 35, 70, 45, 45],
    names: ['Kestrel', 'Harrier', 'Swift', 'Lancer', 'Comet', 'Vane', 'Drift', 'Sabre', 'Merlin', 'Gyre', 'Skiff', 'Corsair'],
  },
  {
    id: 2, key: 'forge', name: 'Forge', identity: 'Industrial collective', strength: 'Production and logistics', tradeoff: 'Vulnerable infrastructure',
    color: 0xff6a55, css: '#ff6a55', dim: '#5c231b',
    mods: { ...NO_MODS, prodTime: -20, income: 12, structHp: -15 },
    doctrine: [55, 45, 70, 60, 55, 25],
    names: ['Anvil', 'Crucible', 'Cinder', 'Ingot', 'Bellows', 'Slag', 'Tempest', 'Rivet', 'Quench', 'Flux', 'Tongs', 'Kiln'],
  },
  {
    id: 3, key: 'veil', name: 'Veil', identity: 'Electronic warfare cells', strength: 'Deception and disruption', tradeoff: 'Limited direct firepower',
    color: 0xc08cff, css: '#c08cff', dim: '#3e2a5e',
    mods: { ...NO_MODS, dmgOut: -10, dmgIn: -15, capture: 10, jam: 2 },
    doctrine: [50, 50, 40, 45, 40, 75],
    names: ['Whisper', 'Mirage', 'Gloam', 'Cipher', 'Wraith', 'Umbra', 'Echo', 'Lumen', 'Shade', 'Nocturne', 'Vesper', 'Haze'],
  },
];

export const NEUTRAL_CSS = '#8a93a2';

// ---------------------------------------------------------------- doctrine & planning
export const DOCTRINE = ['aggression', 'caution', 'logistics', 'expansion', 'loyalty', 'deception'] as const;

export const PK = {
  CAPTURE: 0, ATTACK: 1, ASSAULT_CORE: 2, RAID: 3, DEFEND: 4, FORTIFY: 5, SECURE_SUPPLY: 6, REPAIR: 7,
  SABOTAGE: 8, RECON: 9, OPERATION: 10, SUPPORT: 11, REGROUP: 12,
} as const;
export const PLAN_NAMES = ['CAPTURE', 'ATTACK', 'ASSAULT_CORE', 'RAID', 'DEFEND', 'FORTIFY', 'SECURE_SUPPLY', 'REPAIR', 'SABOTAGE', 'RECON', 'OPERATION', 'SUPPORT', 'REGROUP'];
export const PLAN_COUNT = PLAN_NAMES.length;

export const FEATURES = ['value', 'proximity', 'threat', 'supplyRisk', 'uncertainty', 'danger', 'exposure', 'opBonus', 'teamSupport', 'econNeed'] as const;
export const FEAT_COUNT = FEATURES.length;
/** learned linear policy head input: features + plan-kind one-hot + bias */
export const PSI_DIM = FEAT_COUNT + PLAN_COUNT + 1;

export const LEARN = {
  rate: 0.09,
  lambda: 0.85, // weight of learned correction in plan score
  clamp: 2.0,
  versionEvery: 8, // online updates per policy minor version
  epsilon0: 0.22,
  epsilonMin: 0.04,
} as const;

export const MEMORY_CAP = 24;
export const DECISION_LOG = 14;

// ---------------------------------------------------------------- economy & ledger
export const SIGNAL = {
  initialGrant: 1000,
  periodicGrant: 100, // claimable once per campaign (sandbox compression of "per simulation day")
  stakeCapAbs: 100,
  stakeCapPct: 10,
  npcCount: 36,
} as const;

export const MERIT = {
  opPool: 100,
  campaignPool: 200,
} as const;
