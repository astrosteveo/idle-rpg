/**
 * All game tuning lives here: enemy statlines, item bases, the quest chain and
 * the claimable milestone rewards. Systems read from this file so balance can
 * be changed without touching simulation code.
 */
import type { EnemyKind, ItemStats, Slot } from './types'
import type { IconKind } from '../render/sprites'

/* ------------------------------------------------------------------ *
 * Player
 * ------------------------------------------------------------------ */

export const PLAYER_SPEED = 118
export const PLAYER_RADIUS = 11

/** Melee arc: reach measured from the player's centre, and half-angle. */
export const SWING_RANGE = 52
export const SWING_HALF_ANGLE = Math.PI * 0.42
export const SWING_DURATION = 0.34

export function xpForLevel(level: number): number {
  return Math.round(46 + Math.pow(level, 1.62) * 26)
}

export interface DerivedStats {
  maxHp: number
  damage: number
  armor: number
  attackInterval: number
  crit: number
  str: number
  vit: number
  agi: number
}

export function deriveStats(
  level: number,
  base: { str: number; vit: number; agi: number },
  gear: ItemStats,
): DerivedStats {
  const str = base.str + (gear.str ?? 0)
  const vit = base.vit + (gear.vit ?? 0)
  const agi = base.agi + (gear.agi ?? 0)
  return {
    str,
    vit,
    agi,
    maxHp: Math.round(72 + vit * 11 + level * 7),
    damage: 5 + str * 1.75 + (gear.dmg ?? 0),
    armor: gear.armor ?? 0,
    attackInterval: Math.max(0.36, 0.98 - agi * 0.013),
    crit: Math.min(0.55, 0.05 + agi * 0.007),
  }
}

export const CRIT_MULT = 1.9

/** Diminishing-returns mitigation so armour never trivialises damage. */
export function mitigate(damage: number, armor: number, attackerLevel: number): number {
  const reduction = armor / (armor + 58 + attackerLevel * 13)
  return Math.max(1, damage * (1 - reduction))
}

/* ------------------------------------------------------------------ *
 * Enemies
 * ------------------------------------------------------------------ */

export interface EnemyType {
  id: EnemyKind
  name: string
  eliteName: string
  sheet: 'wolf' | 'bear'
  eliteSheet: 'alphaWolf' | 'elderBear'
  radius: number
  speed: number
  aggroRange: number
  leash: number
  attackRange: number
  attackCd: number
  windup: number
  hp: (l: number) => number
  dmg: (l: number) => number
  xp: (l: number) => number
  gold: (l: number) => number
  /** Chance an ordinary kill drops an equipment item. */
  dropChance: number
}

export const ENEMIES: Record<EnemyKind, EnemyType> = {
  wolf: {
    id: 'wolf',
    name: 'Grey Wolf',
    eliteName: 'Alpha Wolf',
    sheet: 'wolf',
    eliteSheet: 'alphaWolf',
    radius: 15,
    speed: 96,
    aggroRange: 210,
    leash: 620,
    attackRange: 40,
    attackCd: 1.15,
    windup: 0.3,
    hp: (l) => Math.round(32 + l * 11),
    dmg: (l) => 4.5 + l * 1.7,
    xp: (l) => Math.round(11 + l * 6),
    gold: (l) => Math.round(3 + l * 2.4),
    dropChance: 0.2,
  },
  bear: {
    id: 'bear',
    name: 'Brown Bear',
    eliteName: 'Elder Bear',
    sheet: 'bear',
    eliteSheet: 'elderBear',
    radius: 21,
    speed: 72,
    aggroRange: 175,
    leash: 560,
    attackRange: 52,
    attackCd: 1.75,
    windup: 0.42,
    hp: (l) => Math.round(88 + l * 26),
    dmg: (l) => 10 + l * 3.1,
    xp: (l) => Math.round(30 + l * 13),
    gold: (l) => Math.round(9 + l * 5),
    dropChance: 0.34,
  },
}

export const ELITE = {
  hpMult: 2.8,
  dmgMult: 1.45,
  xpMult: 3.4,
  goldMult: 3.2,
  speedMult: 1.08,
  scale: 1.0,
  dropChance: 1,
  rarityBonus: 2,
}

/* ------------------------------------------------------------------ *
 * Reward scaling
 * ------------------------------------------------------------------ */

/**
 * Everyone who damages a beast earns full credit for the kill — never a split
 * share, never a race to tag it first. What scales is the *value* of that
 * credit, by the gap between the two levels, so a low-level character cannot
 * tap high-level beasts into free progress.
 *
 * The multiplier depends only on the two levels, so no faster, earlier or
 * harder action improves it: there is nothing to race. Full value within +2
 * (punching up a little should stay worth it), then a steep taper to a floor;
 * a gentler taper downward keeps high-level players from farming the starter
 * regions for gold.
 *
 * Applies to xp, gold, drop chance and drop item level. It must NEVER touch
 * kill counters, bestiary entries or quest progress — that acknowledgment is
 * unconditional, and has no economic value to exploit.
 */
export function rewardScale(playerLevel: number, enemyLevel: number): number {
  const d = enemyLevel - playerLevel
  if (d > 2) return Math.max(0.04, 1 - (d - 2) * 0.22)
  if (d < -4) return Math.max(0.15, 1 + (d + 4) * 0.12)
  return 1
}

/**
 * Experience alone falls all the way to nothing, so a region can be *outgrown*
 * rather than merely made unrewarding. `rewardScale` floors at 15% and never
 * reaches zero, which is right for gold and drops — trivial beasts should still
 * be worth looting — but it would let a character grind the starter vale to the
 * level cap forever.
 *
 * Tuned against the region bands: at `cutoff` 8, a level 11 character earns
 * nothing from Greenwood Vale (levels 1–3) but is still paid properly in
 * Wolfden Thicket (4–8). Punching upward is unchanged — that curve belongs to
 * `rewardScale`, which also guards against tapping high-level beasts.
 *
 * Kills, quests, counters and the bestiary are never affected. Acknowledgment
 * stays unconditional; only the payout stops.
 */
export const XP_FALLOFF = {
  /** Full experience while the beast is within this many levels below you. */
  grace: 3,
  /** Experience reaches exactly zero this many levels below you. */
  cutoff: 8,
}

export function xpScale(playerLevel: number, enemyLevel: number): number {
  const d = enemyLevel - playerLevel
  if (d >= 0) return rewardScale(playerLevel, enemyLevel)
  const below = -d
  if (below <= XP_FALLOFF.grace) return 1
  if (below >= XP_FALLOFF.cutoff) return 0
  return (XP_FALLOFF.cutoff - below) / (XP_FALLOFF.cutoff - XP_FALLOFF.grace)
}

/* ------------------------------------------------------------------ *
 * Offline progression
 * ------------------------------------------------------------------ */

/**
 * The ledger is a closed-form rate model, not a headless simulation — it has to
 * settle months of absence in a frame. It is deliberately an approximation, and
 * these are the knobs that make it honest.
 */
export const OFFLINE = {
  /** Accrual stops here. Long enough to cover a night's sleep and a workday. */
  capHours: 12,
  /** Walking between bodies, per kill. */
  seekSeconds: 2.5,
  /** Healing, deaths, pathing, waiting on respawns. */
  efficiency: 0.72,
  /** Arc melee cleaves, and wolves come in packs where bears do not. */
  cleave: { wolf: 1.45, bear: 1.1 } as Record<EnemyKind, number>,
  /**
   * Rewards depend on level, so the run is stepped and stats recomputed between
   * buckets. Without this a level 1 character earns level 1 rates all night when
   * it would really have hit level 6 in the first hour.
   */
  bucketSeconds: 600,
  /** Share of kills that are elites, in regions that have elite nodes. */
  eliteShare: 0.06,
  /** Best few drops are kept; the rest become gold, as bag overflow already does. */
  maxItemsKept: 6,
  /** Upper bound on items actually generated, so a long absence stays cheap. */
  itemSampleCap: 24,
  /** Shorter absences than this are not worth interrupting the player for. */
  minReportSeconds: 120,
}

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

export const RARITY_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']
export const RARITY_COLORS = ['#b9c0cc', '#62c46a', '#4e9df5', '#b064e8', '#f0913a']

export interface ItemBase {
  id: string
  name: string
  slot: Slot
  icon: IconKind
  /** Per-item-level contribution to the base stat. */
  dmg?: number
  armor?: number
  value: number
}

export const ITEM_BASES: ItemBase[] = [
  { id: 'axe', name: 'Hand Axe', slot: 'weapon', icon: 'axe', dmg: 1.5, value: 12 },
  { id: 'sword', name: 'Broadsword', slot: 'weapon', icon: 'sword', dmg: 1.4, value: 13 },
  { id: 'maul', name: 'War Maul', slot: 'weapon', icon: 'mace', dmg: 1.7, value: 14 },
  { id: 'helm', name: 'Helm', slot: 'head', icon: 'helm', armor: 0.9, value: 9 },
  { id: 'cuirass', name: 'Cuirass', slot: 'chest', icon: 'chest', armor: 1.5, value: 11 },
  { id: 'gauntlets', name: 'Gauntlets', slot: 'hands', icon: 'gloves', armor: 0.7, value: 8 },
  { id: 'sabatons', name: 'Sabatons', slot: 'feet', icon: 'boots', armor: 0.8, value: 8 },
  { id: 'band', name: 'Band', slot: 'ring', icon: 'ring', value: 14 },
]

export const PREFIXES = [
  [''],
  ['Sturdy', 'Keen', 'Hardened', 'Rugged'],
  ['Gleaming', 'Wolfsbane', 'Ironbound', 'Warded'],
  ['Direhunter', 'Stormforged', 'Bloodsworn', 'Thornmail'],
  ['Wildmarch', 'Sunsundered', 'Beastking'],
]

export const SUFFIXES = [
  '',
  'of the Vale',
  'of the Hunt',
  'of Stonewatch',
  'of the Thicket',
  'of the Alpha',
  'of Endurance',
]

export const AFFIX_POOL: (keyof ItemStats)[] = ['str', 'vit', 'agi', 'armor']

/* ------------------------------------------------------------------ *
 * Quests
 * ------------------------------------------------------------------ */

export type QuestObjective =
  | { type: 'kill'; kind: EnemyKind | 'elite' | 'any'; count: number }
  | { type: 'reach'; camp: string }

export interface QuestReward {
  xp: number
  gold: number
  item?: { base: string; rarity: number; ilvl: number }
}

export interface QuestDef {
  id: string
  name: string
  giver: string
  desc: string
  objective: QuestObjective
  reward: QuestReward
}

export const QUESTS: QuestDef[] = [
  {
    id: 'q1',
    name: 'Blood on the Grass',
    giver: 'Hearthglen Camp',
    desc: 'Wolves have grown bold at the edge of the Vale. Thin them out.',
    objective: { type: 'kill', kind: 'wolf', count: 6 },
    reward: { xp: 70, gold: 45, item: { base: 'axe', rarity: 1, ilvl: 3 } },
  },
  {
    id: 'q2',
    name: 'Pack Mentality',
    giver: 'Hearthglen Camp',
    desc: 'They hunt in numbers. Prove you can too.',
    objective: { type: 'kill', kind: 'wolf', count: 14 },
    reward: { xp: 170, gold: 95, item: { base: 'cuirass', rarity: 1, ilvl: 5 } },
  },
  {
    id: 'q3',
    name: "The Road to Ranger's Rest",
    giver: 'Hearthglen Camp',
    desc: 'Scouts have not reported in. Follow the north road and find their camp.',
    objective: { type: 'reach', camp: 'rangers' },
    reward: { xp: 210, gold: 120, item: { base: 'sabatons', rarity: 2, ilvl: 6 } },
  },
  {
    id: 'q4',
    name: 'Hold the Stonewatch',
    giver: "Ranger's Rest",
    desc: 'The western hold has gone quiet. Reach Stonewatch and see what walks there.',
    objective: { type: 'reach', camp: 'stonewatch' },
    reward: { xp: 300, gold: 160, item: { base: 'helm', rarity: 2, ilvl: 8 } },
  },
  {
    id: 'q5',
    name: 'Bear Necessities',
    giver: 'Stonewatch Hold',
    desc: 'Bears have claimed the ridge. Drive them off it.',
    objective: { type: 'kill', kind: 'bear', count: 8 },
    reward: { xp: 520, gold: 260, item: { base: 'maul', rarity: 2, ilvl: 10 } },
  },
  {
    id: 'q6',
    name: 'Apex',
    giver: 'Stonewatch Hold',
    desc: 'Something larger leads them. Kill three of the beasts that others follow.',
    objective: { type: 'kill', kind: 'elite', count: 3 },
    reward: { xp: 900, gold: 500, item: { base: 'band', rarity: 3, ilvl: 12 } },
  },
  {
    id: 'q7',
    name: 'The Long Hunt',
    giver: 'Wildmarch',
    desc: 'The march never truly ends. Keep culling whatever prowls these lands.',
    objective: { type: 'kill', kind: 'any', count: 60 },
    reward: { xp: 1500, gold: 900, item: { base: 'cuirass', rarity: 4, ilvl: 15 } },
  },
]

/* ------------------------------------------------------------------ *
 * Milestones — claimed manually from the Rewards panel
 * ------------------------------------------------------------------ */

export type Metric = 'kills' | 'wolf' | 'bear' | 'elite' | 'gold' | 'level' | 'quests'

export interface MilestoneDef {
  id: string
  name: string
  desc: string
  metric: Metric
  threshold: number
  reward: QuestReward
}

export const MILESTONES: MilestoneDef[] = [
  {
    id: 'm-kill-10',
    name: 'First Blood',
    desc: 'Slay 10 beasts',
    metric: 'kills',
    threshold: 10,
    reward: { xp: 60, gold: 60, item: { base: 'gauntlets', rarity: 1, ilvl: 3 } },
  },
  {
    id: 'm-kill-50',
    name: 'Culler',
    desc: 'Slay 50 beasts',
    metric: 'kills',
    threshold: 50,
    reward: { xp: 320, gold: 260, item: { base: 'sword', rarity: 2, ilvl: 8 } },
  },
  {
    id: 'm-kill-100',
    name: 'Wildmarch Veteran',
    desc: 'Slay 100 beasts',
    metric: 'kills',
    threshold: 100,
    reward: { xp: 850, gold: 700, item: { base: 'cuirass', rarity: 3, ilvl: 12 } },
  },
  {
    id: 'm-kill-250',
    name: 'Beastbane',
    desc: 'Slay 250 beasts',
    metric: 'kills',
    threshold: 250,
    reward: { xp: 2400, gold: 1800, item: { base: 'maul', rarity: 4, ilvl: 18 } },
  },
  {
    id: 'm-wolf-40',
    name: 'Pack Breaker',
    desc: 'Slay 40 wolves',
    metric: 'wolf',
    threshold: 40,
    reward: { xp: 280, gold: 220, item: { base: 'sabatons', rarity: 2, ilvl: 9 } },
  },
  {
    id: 'm-bear-20',
    name: 'Ridge Walker',
    desc: 'Slay 20 bears',
    metric: 'bear',
    threshold: 20,
    reward: { xp: 620, gold: 480, item: { base: 'helm', rarity: 3, ilvl: 13 } },
  },
  {
    id: 'm-elite-5',
    name: 'Trophy Hunter',
    desc: 'Slay 5 elite beasts',
    metric: 'elite',
    threshold: 5,
    reward: { xp: 1100, gold: 900, item: { base: 'band', rarity: 3, ilvl: 14 } },
  },
  {
    id: 'm-level-5',
    name: 'Blooded',
    desc: 'Reach level 5',
    metric: 'level',
    threshold: 5,
    reward: { xp: 0, gold: 150, item: { base: 'axe', rarity: 2, ilvl: 6 } },
  },
  {
    id: 'm-level-10',
    name: 'Hardened',
    desc: 'Reach level 10',
    metric: 'level',
    threshold: 10,
    reward: { xp: 0, gold: 600, item: { base: 'sword', rarity: 3, ilvl: 12 } },
  },
  {
    id: 'm-gold-1000',
    name: 'Coin Purse',
    desc: 'Earn 1,000 gold',
    metric: 'gold',
    threshold: 1000,
    reward: { xp: 400, gold: 0, item: { base: 'band', rarity: 2, ilvl: 10 } },
  },
  {
    id: 'm-quests-4',
    name: 'Dependable',
    desc: 'Complete 4 quests',
    metric: 'quests',
    threshold: 4,
    reward: { xp: 500, gold: 350, item: { base: 'gauntlets', rarity: 3, ilvl: 12 } },
  },
]

/* ------------------------------------------------------------------ *
 * Abilities
 * ------------------------------------------------------------------ */

export const WHIRLWIND = {
  radius: 86,
  damageMult: 2.1,
  cooldown: 7,
}

export const SECOND_WIND = {
  healFraction: 0.4,
  cooldown: 24,
}
