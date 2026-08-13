/**
 * All game tuning lives here: enemy statlines, item bases, the quest chain and
 * the claimable milestone rewards. Systems read from this file so balance can
 * be changed without touching simulation code.
 */
import { ENEMY_KINDS, perSpecies, type BySpecies, type EnemyKind, type ItemStats, type Slot } from './types'
import type { BeastSheetId, IconKind } from '../render/sprites'

/* ------------------------------------------------------------------ *
 * Modifiers
 * ------------------------------------------------------------------ */

/**
 * One flat bag of numbers that talents, uniques and beast mastery all
 * contribute to, so the simulation asks a single object what the rules are
 * instead of interrogating three systems at every damage roll.
 *
 * `COMBINE` below declares how each field stacks, and it is a `Record` over
 * every key of `Mods` — a field added here without a stacking rule fails the
 * build rather than silently defaulting to something wrong.
 */
export interface Mods {
  /* Multiplicative. Two +10% sources make +21%, never +20%. */
  damageMult: number
  attackSpeedMult: number
  maxHpMult: number
  moveSpeedMult: number
  /** Out-of-combat health regeneration. */
  regenMult: number
  goldMult: number
  dropChanceMult: number
  wwRadiusMult: number
  wwDamageMult: number
  wwCooldownMult: number
  swHealMult: number
  swCooldownMult: number
  swingArcMult: number
  /** Against a beast already below `EXECUTE_BELOW` of its health. */
  executeMult: number
  /** Against a beast that has not been wounded yet. */
  openerMult: number
  /**
   * Damage dealt to each species, and damage taken from each species. Records
   * rather than a field per animal: a new species is a row in `ENEMY_KINDS`,
   * not four new modifier fields and four new stacking rules.
   */
  vs: BySpecies
  from: BySpecies
  /**
   * Scales every distance in `Game.shouldGiveUp`. Only ever set below 1: the
   * de-aggro rule is what keeps the map traversable, so content may make a
   * chase end *sooner* and never later.
   */
  leashMult: number
  /**
   * Share of maximum health the largest single blow may take. 1 is no cap at
   * all — a hit above your whole health bar was lethal anyway — so it composes
   * multiplicatively without needing a "no cap" sentinel.
   */
  maxHitFraction: number

  /* Additive. */
  critAdd: number
  swingRangeAdd: number
  /** Seconds off Whirlwind's cooldown for every beast it catches. */
  wwRefundPerHit: number
  /** Fraction of maximum health restored on every kill. */
  lifeOnKill: number
  /** Damage per extra beast in whirlwind range, and the ceiling on that bonus. */
  frenzyPer: number
  frenzyCap: number
  /** Seconds of Second Wind returned on every kill. */
  breathOnKill: number

  /* Flags — any source turning one on turns it on. */
  emberTrail: boolean
  ambush: boolean
  /** Spider webbing never lands. */
  webproof: boolean
}

/**
 * The identity element. Frozen — including the two per-species records, which
 * are the part a caller could plausibly reach into — because it is module
 * scope: a `Mods` that anything could write to would be one character's build
 * leaking into everyone's the moment the world is shared.
 */
export const NO_MODS: Readonly<Mods> = Object.freeze({
  damageMult: 1,
  attackSpeedMult: 1,
  maxHpMult: 1,
  moveSpeedMult: 1,
  regenMult: 1,
  goldMult: 1,
  dropChanceMult: 1,
  wwRadiusMult: 1,
  wwDamageMult: 1,
  wwCooldownMult: 1,
  swHealMult: 1,
  swCooldownMult: 1,
  swingArcMult: 1,
  executeMult: 1,
  openerMult: 1,
  vs: Object.freeze(perSpecies(1)),
  from: Object.freeze(perSpecies(1)),
  leashMult: 1,
  maxHitFraction: 1,
  critAdd: 0,
  swingRangeAdd: 0,
  wwRefundPerHit: 0,
  lifeOnKill: 0,
  frenzyPer: 0,
  frenzyCap: 0,
  breathOnKill: 0,
  emberTrail: false,
  ambush: false,
  webproof: false,
})

/**
 * A contribution. Identical to `Partial<Mods>` except that the two per-species
 * records may be partial themselves — a relic that only has an opinion about
 * wolves says so, rather than restating every other species at 1.
 */
export type ModsPatch = Partial<Omit<Mods, 'vs' | 'from'>> & {
  vs?: Partial<BySpecies>
  from?: Partial<BySpecies>
}

const COMBINE: Record<keyof Mods, 'mul' | 'add' | 'or' | 'mulEach'> = {
  damageMult: 'mul',
  attackSpeedMult: 'mul',
  maxHpMult: 'mul',
  moveSpeedMult: 'mul',
  regenMult: 'mul',
  goldMult: 'mul',
  dropChanceMult: 'mul',
  wwRadiusMult: 'mul',
  wwDamageMult: 'mul',
  wwCooldownMult: 'mul',
  swHealMult: 'mul',
  swCooldownMult: 'mul',
  swingArcMult: 'mul',
  executeMult: 'mul',
  openerMult: 'mul',
  vs: 'mulEach',
  from: 'mulEach',
  leashMult: 'mul',
  maxHitFraction: 'mul',
  critAdd: 'add',
  swingRangeAdd: 'add',
  wwRefundPerHit: 'add',
  lifeOnKill: 'add',
  frenzyPer: 'add',
  frenzyCap: 'add',
  breathOnKill: 'add',
  emberTrail: 'or',
  ambush: 'or',
  webproof: 'or',
}

/**
 * Fresh, writable copy of the identity. The species records are copied too —
 * a shallow spread would hand every character the frozen module-scope one.
 */
export function baseMods(): Mods {
  return { ...NO_MODS, vs: { ...NO_MODS.vs }, from: { ...NO_MODS.from } }
}

/** Folds one contribution into an accumulator, in place. */
export function mergeMods(into: Mods, add: ModsPatch): Mods {
  const acc = into as unknown as Record<string, number | boolean | BySpecies>
  for (const [key, value] of Object.entries(add)) {
    if (value === undefined) continue
    const rule = COMBINE[key as keyof Mods]
    if (rule === 'mulEach') {
      // Only the species the contribution mentions move; the rest stay at
      // whatever the accumulator already says about them.
      const target = acc[key] as BySpecies
      for (const [kind, factor] of Object.entries(value as Partial<BySpecies>)) {
        if (factor === undefined) continue
        target[kind as EnemyKind] *= factor
      }
    } else if (rule === 'or') acc[key] = (acc[key] as boolean) || (value as boolean)
    else if (rule === 'mul') acc[key] = (acc[key] as number) * (value as number)
    else acc[key] = (acc[key] as number) + (value as number)
  }
  return into
}

/**
 * "Ruinous against one animal, worse against everything else" — the shape a
 * specialist relic wants, written once so a new species joins the losing side
 * automatically instead of quietly becoming an exception.
 */
export function focused(kind: EnemyKind, against: number, others: number): BySpecies {
  const out = perSpecies(others)
  out[kind] = against
  return out
}

/** A beast at or below this share of its health counts as executable. */
export const EXECUTE_BELOW = 0.3

/** Below this share of *your* health, Second Wind's refund becomes total. */
export const DESPERATE_BELOW = 0.25

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
  mods: Readonly<Mods> = NO_MODS,
): DerivedStats {
  const str = base.str + (gear.str ?? 0)
  const vit = base.vit + (gear.vit ?? 0)
  const agi = base.agi + (gear.agi ?? 0)
  return {
    str,
    vit,
    agi,
    maxHp: Math.round((72 + vit * 11 + level * 7) * mods.maxHpMult),
    damage: (5 + str * 1.75 + (gear.dmg ?? 0)) * mods.damageMult,
    armor: gear.armor ?? 0,
    attackInterval: Math.max(0.3, (0.98 - agi * 0.013) / mods.attackSpeedMult),
    crit: Math.min(0.7, 0.05 + agi * 0.007 + mods.critAdd),
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

/**
 * How a species fights, as opposed to how big its numbers are.
 *
 * `stalk` is the original animal: walk at the player, swing when in reach.
 * The other three are the whole reason a third species is worth adding — a
 * statline can only ever be a wolf with more health.
 */
export type Behaviour =
  /** Wolves and bears: close the distance and bite. */
  | 'stalk'
  /** Boars: line up from range and commit to a straight, heavy run. */
  | 'charge'
  /** Spiders: every bite leaves webbing that drags on your stride. */
  | 'web'
  /** Corvids: the whole flock breaks off when one is hit, then re-forms. */
  | 'flock'

export interface EnemyType {
  id: EnemyKind
  name: string
  /** How the HUD counts them: "Wolves slain". */
  plural: string
  eliteName: string
  sheet: BeastSheetId
  eliteSheet: BeastSheetId
  behaviour: Behaviour
  /** Dot colour on the minimap. */
  mapColor: string
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
  /** Bestiary entry — read once, and only there. */
  lore: string
  /** Bestiary entry — how the thing actually fights. */
  habits: string
}

export const ENEMIES: Record<EnemyKind, EnemyType> = {
  wolf: {
    id: 'wolf',
    name: 'Grey Wolf',
    plural: 'Wolves',
    eliteName: 'Alpha Wolf',
    sheet: 'wolf',
    eliteSheet: 'alphaWolf',
    behaviour: 'stalk',
    mapColor: '#d8483f',
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
    lore:
      'Grey wolves hold the low ground from the Vale to the Thicket. They are ' +
      'not brave animals — they are patient ones, and they count.',
    habits:
      'Fast, sees you from a long way off, and never arrives alone. Packs of ' +
      'three to five den together, which is exactly what Whirlwind is for.',
  },
  bear: {
    id: 'bear',
    name: 'Brown Bear',
    plural: 'Bears',
    eliteName: 'Elder Bear',
    sheet: 'bear',
    eliteSheet: 'elderBear',
    behaviour: 'stalk',
    mapColor: '#c96a4a',
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
    lore:
      'Brown bears own the Stonewatch ridge and see no reason to explain ' +
      'themselves. Elders have been up there longer than the hold has.',
    habits:
      'Slow, short-sighted, and hits like a falling tree. One or two to a ' +
      'ground, so nothing rescues it — and nothing rescues you either.',
  },
  boar: {
    id: 'boar',
    name: 'Tusked Boar',
    plural: 'Boars',
    eliteName: 'Ironhide Tusker',
    sheet: 'boar',
    eliteSheet: 'ironhideBoar',
    behaviour: 'charge',
    mapColor: '#c98a3a',
    radius: 18,
    speed: 82,
    aggroRange: 250,
    leash: 600,
    attackRange: 44,
    attackCd: 1.45,
    windup: 0.34,
    hp: (l) => Math.round(58 + l * 18),
    dmg: (l) => 7 + l * 2.2,
    xp: (l) => Math.round(20 + l * 9),
    gold: (l) => Math.round(6 + l * 3.4),
    dropChance: 0.26,
    lore:
      'Thornfell was pasture once. The boars that root through it now are ' +
      'descended from something that was fed, and they have not forgotten it.',
    habits:
      'Squares up at a distance, paws once, and then commits — a charge goes ' +
      'where it was aimed and nowhere else. Step out of the line and it has to ' +
      'turn around and start again.',
  },
  spider: {
    id: 'spider',
    name: 'Fen Spider',
    plural: 'Spiders',
    eliteName: 'Mirefen Broodmother',
    sheet: 'spider',
    eliteSheet: 'broodmother',
    behaviour: 'web',
    mapColor: '#6fbf7a',
    radius: 16,
    speed: 90,
    aggroRange: 205,
    leash: 540,
    attackRange: 46,
    attackCd: 1.3,
    windup: 0.26,
    hp: (l) => Math.round(66 + l * 20),
    dmg: (l) => 8 + l * 2.5,
    xp: (l) => Math.round(26 + l * 11),
    gold: (l) => Math.round(7 + l * 4),
    dropChance: 0.3,
    lore:
      'The hollow is strung wall to wall. Nothing that walks into Mirefen ' +
      'walks out at the pace it went in.',
    habits:
      'Every bite leaves webbing, and webbing halves your stride for a few ' +
      'seconds. Disengaging is the thing they take away from you — kill them ' +
      'where they stand or do not start.',
  },
  corvid: {
    id: 'corvid',
    name: 'Carrion Rook',
    plural: 'Rooks',
    eliteName: 'Stormcrow',
    sheet: 'corvid',
    eliteSheet: 'stormcrow',
    behaviour: 'flock',
    mapColor: '#9aa6c8',
    radius: 12,
    speed: 126,
    aggroRange: 235,
    leash: 700,
    attackRange: 36,
    attackCd: 0.95,
    windup: 0.2,
    // Individually flimsy on purpose: the threat is the number of them and the
    // fact that they will not hold still, not any one bird's health bar.
    hp: (l) => Math.round(40 + l * 11),
    dmg: (l) => 6 + l * 2,
    xp: (l) => Math.round(18 + l * 7),
    gold: (l) => Math.round(4 + l * 2.6),
    dropChance: 0.18,
    lore:
      'They hold the crag in numbers nobody has ever finished counting, and ' +
      'they were there before the watch was.',
    habits:
      'Hit one and the whole unkindness breaks off at once — then re-forms a ' +
      'second later from a different side. Whirlwind catches a flock mid-' +
      'gather; single blows mostly catch air.',
  },
}

/**
 * The three species tricks, in one place.
 *
 * Each is deliberately answerable. A charge is telegraphed and cannot steer, so
 * it is dodged by moving; webbing is short, so it is survived by killing what
 * applied it; a scatter is brief, so it is beaten by an ability with an area
 * rather than by chasing individual birds.
 */
export const BEHAVIOUR = {
  charge: {
    /** Furthest the boar will start a run from. */
    range: 340,
    /** Pawing the ground — the whole tell, and it must stay readable. */
    windup: 0.6,
    speedMult: 3.1,
    /** How long the run lasts before it blows out. */
    seconds: 1.15,
    damageMult: 1.7,
    /** Seconds before it can line up another. */
    cooldown: 5,
  },
  web: {
    seconds: 1.8,
    /** Stride multiplier while webbed. */
    slowMult: 0.45,
  },
  flock: {
    seconds: 0.85,
    speedMult: 1.9,
    /** How far the panic carries through the flock. */
    radius: 190,
    /** Per bird, so a flock cannot be broken off on every single blow. */
    cooldown: 3.2,
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
 * World bosses
 * ------------------------------------------------------------------ */

/**
 * An apex beast, standing at a named place on a clock everybody shares.
 *
 * The schedule is derived from wall-clock time rather than from anything this
 * character has done, so every player's answer to "when does the Greytooth
 * walk?" is the same answer. That is the whole point: a common world makes
 * "it holds the Hollow Oak on the half hour" transferable knowledge, and
 * transferable knowledge is the cheapest social content there is.
 */
export const BOSS = {
  /** Real minutes between windows. */
  periodMinutes: 30,
  /**
   * Apex relic chance. Far above an ordinary elite's, because a boss is the
   * one encounter a player can plan to be present for, and the reward for
   * turning up on time should be the thing they are missing.
   */
  uniqueChance: 0.45,
  /** How far out an apex notices you — they hold their ground, not a leash. */
  aggroMult: 1.5,
}

/** Which scheduling window a moment falls in. Identical on every client. */
export function bossWindow(nowMs: number): number {
  return Math.floor(nowMs / (BOSS.periodMinutes * 60_000))
}

/** Milliseconds until the next window opens. */
export function bossWindowRemaining(nowMs: number): number {
  const period = BOSS.periodMinutes * 60_000
  return period - (nowMs % period)
}

export interface BossDef {
  id: string
  name: string
  /** The line under the name, in the bestiary and on arrival. */
  title: string
  kind: EnemyKind
  /** Id of the `Landmark` it holds. Fixed, and the same for everybody. */
  site: string
  level: number
  sheet: BeastSheetId
  hpMult: number
  dmgMult: number
  xpMult: number
  goldMult: number
  lore: string
}

/**
 * One apex to a species, each holding the landmark its kind is named for, and
 * each a clear step above the band it stands in — a boss is somewhere to aim,
 * not somewhere to grind.
 */
export const BOSSES: BossDef[] = [
  {
    id: 'greytooth',
    name: 'The Greytooth',
    title: 'Apex of Wolfden Thicket',
    kind: 'wolf',
    site: 'hollow-oak',
    level: 10,
    sheet: 'greytooth',
    hpMult: 14,
    dmgMult: 2.1,
    xpMult: 12,
    goldMult: 11,
    lore: 'The pack that will not den. It has been the same animal for longer than that is possible.',
  },
  {
    id: 'thornfell-sow',
    name: 'The Thornfell Sow',
    title: 'Apex of Thornfell Downs',
    kind: 'boar',
    site: 'bonefield',
    level: 11,
    sheet: 'thornfellSow',
    hpMult: 15,
    dmgMult: 2.2,
    xpMult: 12,
    goldMult: 11,
    lore: 'Whatever is buried in the Bonefield, she put it there, and she is still not finished.',
  },
  {
    id: 'stonebrow',
    name: 'Stonebrow',
    title: 'Apex of Stonewatch Ridge',
    kind: 'bear',
    site: 'wind-altar',
    level: 14,
    sheet: 'stonebrow',
    hpMult: 16,
    dmgMult: 2.3,
    xpMult: 13,
    goldMult: 12,
    lore: 'The altar was raised to something. The rangers have stopped arguing about whether it worked.',
  },
  {
    id: 'mirefen-widow',
    name: 'The Widow of Mirefen',
    title: 'Apex of Mirefen Hollow',
    kind: 'spider',
    site: 'drowned-chapel',
    level: 16,
    sheet: 'mirefenWidow',
    hpMult: 16,
    dmgMult: 2.4,
    xpMult: 13,
    goldMult: 12,
    lore: 'The chapel did not drown. It was wrapped, and the water came afterwards.',
  },
  {
    id: 'gallows-king',
    name: 'The Gallows King',
    title: 'Apex of Ravencrag',
    kind: 'corvid',
    site: 'rookstone',
    level: 20,
    sheet: 'gallowsKing',
    hpMult: 18,
    dmgMult: 2.5,
    xpMult: 15,
    goldMult: 14,
    lore: 'Every rook on the crag watches the Rookstone. This is what they are watching for.',
  },
]

export function bossById(id: string): BossDef | null {
  return BOSSES.find((b) => b.id === id) ?? null
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
 * How much a swing overkills, per species. Declared as a `BySpecies` rather
 * than cast to one: a species missing from here should fail the build, not
 * quietly settle a night's hunting at `undefined` kills an hour.
 */
const CLEAVE: BySpecies = { wolf: 1.45, bear: 1.1, boar: 1.15, spider: 1.25, corvid: 1.7 }

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
  cleave: CLEAVE,
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
  | { type: 'kill'; kind: EnemyKind | 'elite' | 'boss' | 'any'; count: number }
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
    desc: 'The ridge is held. Cull whatever still prowls, and the march moves on.',
    objective: { type: 'kill', kind: 'any', count: 60 },
    reward: { xp: 1500, gold: 900, item: { base: 'cuirass', rarity: 4, ilvl: 15 } },
  },
  {
    id: 'q8',
    name: 'South of the Old Pasture',
    giver: 'Hearthglen Camp',
    desc: 'There is a camp on the Thornfell road that has stopped sending word. Find it.',
    objective: { type: 'reach', camp: 'thornrest' },
    reward: { xp: 700, gold: 380, item: { base: 'gauntlets', rarity: 3, ilvl: 11 } },
  },
  {
    id: 'q9',
    name: 'Tusk and Thorn',
    giver: 'Thornrest',
    desc: 'The boars have the Downs. They will not be moved politely.',
    objective: { type: 'kill', kind: 'boar', count: 14 },
    reward: { xp: 1100, gold: 560, item: { base: 'maul', rarity: 3, ilvl: 12 } },
  },
  {
    id: 'q10',
    name: 'Into the Mire',
    giver: 'Thornrest',
    desc: 'East of the water there is a watchpost nobody has walked out of lately.',
    objective: { type: 'reach', camp: 'mirewatch' },
    reward: { xp: 1400, gold: 700, item: { base: 'sabatons', rarity: 3, ilvl: 14 } },
  },
  {
    id: 'q11',
    name: 'Cut the Weave',
    giver: 'Mirewatch',
    desc: 'Mirefen is strung wall to wall. Thin the weavers.',
    objective: { type: 'kill', kind: 'spider', count: 16 },
    reward: { xp: 2100, gold: 1000, item: { base: 'sword', rarity: 4, ilvl: 16 } },
  },
  {
    id: 'q12',
    name: 'The Crag Road',
    giver: 'Mirewatch',
    desc: 'North, above everything, there is a rest cut into the rock. Reach it.',
    objective: { type: 'reach', camp: 'rookrest' },
    reward: { xp: 2600, gold: 1200, item: { base: 'helm', rarity: 4, ilvl: 17 } },
  },
  {
    id: 'q13',
    name: 'An Unkindness',
    giver: 'Rookrest',
    desc: 'The rooks hold Ravencrag in numbers nobody has finished counting. Start counting.',
    objective: { type: 'kill', kind: 'corvid', count: 30 },
    reward: { xp: 3400, gold: 1600, item: { base: 'band', rarity: 4, ilvl: 19 } },
  },
  {
    id: 'q14',
    name: 'Apex',
    giver: 'Wildmarch',
    desc:
      'Five beasts hold the named places, and each of them keeps to its own hour. ' +
      'Be somewhere on time, for once.',
    objective: { type: 'kill', kind: 'boss', count: 1 },
    reward: { xp: 4200, gold: 2200, item: { base: 'maul', rarity: 4, ilvl: 20 } },
  },
]

/* ------------------------------------------------------------------ *
 * Milestones — claimed manually from the Rewards panel
 * ------------------------------------------------------------------ */

/**
 * What a milestone counts. Per-species goals are one member generated from
 * `EnemyKind` rather than one member written per animal, so a new species
 * cannot be given a milestone the metric union has never heard of.
 */
export type Metric =
  | 'kills'
  | 'elite'
  | 'bosses'
  | 'gold'
  | 'level'
  | 'quests'
  | `slain:${EnemyKind}`

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
    metric: 'slain:wolf',
    threshold: 40,
    reward: { xp: 280, gold: 220, item: { base: 'sabatons', rarity: 2, ilvl: 9 } },
  },
  {
    id: 'm-bear-20',
    name: 'Ridge Walker',
    desc: 'Slay 20 bears',
    metric: 'slain:bear',
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
  {
    id: 'm-boar-60',
    name: 'Thornfell Butcher',
    desc: 'Slay 60 boars',
    metric: 'slain:boar',
    threshold: 60,
    reward: { xp: 1600, gold: 900, item: { base: 'cuirass', rarity: 3, ilvl: 14 } },
  },
  {
    id: 'm-spider-50',
    name: 'Weave Cutter',
    desc: 'Slay 50 spiders',
    metric: 'slain:spider',
    threshold: 50,
    reward: { xp: 2400, gold: 1300, item: { base: 'sabatons', rarity: 4, ilvl: 16 } },
  },
  {
    id: 'm-corvid-120',
    name: 'Scarecrow',
    desc: 'Slay 120 rooks',
    metric: 'slain:corvid',
    threshold: 120,
    reward: { xp: 3600, gold: 2000, item: { base: 'axe', rarity: 4, ilvl: 19 } },
  },
  {
    id: 'm-kill-500',
    name: 'The Long March',
    desc: 'Slay 500 beasts',
    metric: 'kills',
    threshold: 500,
    reward: { xp: 4800, gold: 3200, item: { base: 'sword', rarity: 4, ilvl: 20 } },
  },
  {
    id: 'm-boss-1',
    name: 'Kingslayer',
    desc: 'Kill a world boss',
    metric: 'bosses',
    threshold: 1,
    reward: { xp: 2000, gold: 1500, item: { base: 'helm', rarity: 4, ilvl: 18 } },
  },
  {
    id: 'm-boss-10',
    name: 'The Whole Table',
    desc: 'Kill 10 world bosses',
    metric: 'bosses',
    threshold: 10,
    reward: { xp: 8000, gold: 5000, item: { base: 'maul', rarity: 4, ilvl: 22 } },
  },
  {
    id: 'm-level-15',
    name: 'Weathered',
    desc: 'Reach level 15',
    metric: 'level',
    threshold: 15,
    reward: { xp: 0, gold: 1600, item: { base: 'maul', rarity: 4, ilvl: 18 } },
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

/* ------------------------------------------------------------------ *
 * Talents — the choice a level-up hands you
 * ------------------------------------------------------------------ */

export interface TalentDef {
  id: string
  name: string
  desc: string
  mods: ModsPatch
}

export interface TalentRow {
  id: string
  name: string
  /** The level that unlocks this row's single pick. */
  level: number
  choices: TalentDef[]
}

/**
 * Three nodes per row, one pick, and the rows are deliberately *not* a tree:
 * a tree's real content is its prerequisites, and there is not enough game here
 * yet to make a prerequisite mean anything. Each row instead specialises one
 * thing the player already does — swinging, spinning, recovering, finishing.
 */
export const TALENT_ROWS: TalentRow[] = [
  {
    id: 'stance',
    name: 'Stance',
    level: 2,
    choices: [
      {
        id: 'brutality',
        name: 'Brutality',
        desc: 'Every blow lands 10% harder.',
        mods: { damageMult: 1.1 },
      },
      {
        id: 'alacrity',
        name: 'Alacrity',
        desc: 'You swing 12% faster.',
        mods: { attackSpeedMult: 1.12 },
      },
      {
        id: 'endurance',
        name: 'Endurance',
        desc: '12% more maximum health.',
        mods: { maxHpMult: 1.12 },
      },
    ],
  },
  {
    id: 'spin',
    name: 'The Spin',
    level: 5,
    choices: [
      {
        id: 'wide-arc',
        name: 'Wide Arc',
        desc: 'Whirlwind reaches 35% further.',
        mods: { wwRadiusMult: 1.35 },
      },
      {
        id: 'quick-spin',
        name: 'Quick Spin',
        desc: 'Whirlwind comes back 35% sooner.',
        mods: { wwCooldownMult: 0.65 },
      },
      {
        id: 'heavy-spin',
        name: 'Heavy Spin',
        desc: 'Whirlwind hits half again as hard.',
        mods: { wwDamageMult: 1.5 },
      },
    ],
  },
  {
    id: 'recovery',
    name: 'Recovery',
    level: 8,
    choices: [
      {
        id: 'deep-breath',
        name: 'Deep Breath',
        desc: 'Second Wind heals half again as much.',
        mods: { swHealMult: 1.5 },
      },
      {
        id: 'quick-breath',
        name: 'Quick Breath',
        desc: 'Second Wind comes back 40% sooner.',
        mods: { swCooldownMult: 0.6 },
      },
      {
        id: 'field-dressing',
        name: 'Field Dressing',
        desc: 'You mend four times as fast out of combat.',
        mods: { regenMult: 4 },
      },
    ],
  },
  {
    id: 'predation',
    name: 'Predation',
    level: 11,
    choices: [
      {
        id: 'executioner',
        name: 'Executioner',
        desc: `+35% damage to beasts below ${Math.round(EXECUTE_BELOW * 100)}% health.`,
        mods: { executeMult: 1.35 },
      },
      {
        id: 'ambusher',
        name: 'Ambusher',
        desc: '+45% damage to beasts you have not yet wounded.',
        mods: { openerMult: 1.45 },
      },
      {
        id: 'cleaver',
        name: 'Cleaver',
        desc: 'Your swing arc is 25% wider and reaches 14 further.',
        mods: { swingArcMult: 1.25, swingRangeAdd: 14 },
      },
    ],
  },
  {
    id: 'legend',
    name: 'Legend',
    level: 14,
    choices: [
      {
        id: 'bloodthirst',
        name: 'Bloodthirst',
        desc: 'Every kill restores 2% of your maximum health.',
        mods: { lifeOnKill: 0.02 },
      },
      {
        id: 'warlord',
        name: 'Warlord',
        desc: '+7% damage for every beast crowding you, up to +35%.',
        mods: { frenzyPer: 0.07, frenzyCap: 0.35 },
      },
      {
        id: 'fortune',
        name: 'Fortune',
        desc: '+30% chance of a drop and +20% gold.',
        mods: { dropChanceMult: 1.3, goldMult: 1.2 },
      },
    ],
  },
]

export function talentById(id: string): TalentDef | null {
  for (const row of TALENT_ROWS) {
    const found = row.choices.find((c) => c.id === id)
    if (found) return found
  }
  return null
}

export function rowOfTalent(id: string): TalentRow | null {
  return TALENT_ROWS.find((row) => row.choices.some((c) => c.id === id)) ?? null
}

/**
 * Respeccing is a gold sink rather than a wall. A permanent choice would be
 * answered by looking up a build; a priced one is answered by playing, and the
 * economy has no drains at all otherwise.
 */
export const RESPEC_COST_PER_LEVEL = 120

/* ------------------------------------------------------------------ *
 * Uniques — items that change a rule instead of a number
 * ------------------------------------------------------------------ */

/** Burning ground left by Whirlwind while Emberfang is worn. */
export const EMBER = {
  seconds: 4,
  /** Share of your damage dealt per second to everything standing in it. */
  dpsFraction: 0.55,
  tick: 0.5,
  radiusMult: 0.92,
}

export interface UniqueDef {
  id: string
  name: string
  slot: Slot
  icon: IconKind
  /** Per-item-level base stat, deliberately thin. See the note below. */
  dmg?: number
  armor?: number
  /** The rule, in the words the tooltip uses. */
  rule: string
  flavour: string
  mods: ModsPatch
  /** Which species' elites carry it. `null` means any elite may. */
  from: EnemyKind | null
}

/**
 * Every base stat here is roughly half what an ordinary item of the same slot
 * would roll, and that is the entire point: `itemScore` collapses gear to one
 * number and auto-equip takes the bigger one, so a unique that also won on
 * stats would be picked up automatically and decide nothing.
 *
 * Because they cannot be ranked, uniques sit outside auto-equip in both
 * directions — never equipped for you, never swapped off you. Wearing one is
 * the first choice in the game the simulation cannot make on your behalf.
 */
export const UNIQUES: UniqueDef[] = [
  {
    id: 'emberfang',
    name: 'Emberfang',
    slot: 'weapon',
    icon: 'axe',
    dmg: 0.85,
    rule: `Whirlwind leaves burning ground for ${EMBER.seconds} seconds.`,
    flavour: 'Quenched in a campfire that had not finished with it.',
    mods: { emberTrail: true },
    from: 'wolf',
  },
  {
    id: 'carrion-heart',
    name: 'Carrion Heart',
    slot: 'chest',
    icon: 'chest',
    armor: 0.85,
    rule: 'Every kill restores 4% of your maximum health.',
    flavour: 'It beats a little faster near the dying.',
    mods: { lifeOnKill: 0.04 },
    from: 'bear',
  },
  {
    id: 'quarrys-eye',
    name: "The Quarry's Eye",
    slot: 'head',
    icon: 'helm',
    armor: 0.5,
    rule: 'Your first blow against an unwounded beast always crits.',
    flavour: 'Rangers say the trick is to look where the animal is going to be.',
    mods: { ambush: true },
    from: null,
  },
  {
    id: 'wolfsbane-band',
    name: 'Wolfsbane Band',
    slot: 'ring',
    icon: 'ring',
    rule: '+90% damage to wolves. −35% damage to everything else.',
    flavour: 'Cut for one hunt, and no other.',
    mods: { vs: focused('wolf', 1.9, 0.65) },
    from: 'wolf',
  },
  {
    id: 'longstride',
    name: 'Longstride Sabatons',
    slot: 'feet',
    icon: 'boots',
    armor: 0.45,
    rule: 'You move 22% faster, and beasts give up the chase far sooner.',
    flavour: 'Worn thin by someone who never once stood their ground.',
    mods: { moveSpeedMult: 1.22, leashMult: 0.7 },
    from: null,
  },
  {
    id: 'second-breath',
    name: 'Gauntlets of the Second Breath',
    slot: 'hands',
    icon: 'gloves',
    armor: 0.4,
    rule: `Each kill returns 3 seconds of Second Wind — all of it below ${Math.round(
      DESPERATE_BELOW * 100,
    )}% health.`,
    flavour: 'The march does not stop to let you breathe. These do.',
    mods: { breathOnKill: 3 },
    from: 'bear',
  },
  {
    id: 'ironhide-bulwark',
    name: 'Ironhide Bulwark',
    slot: 'chest',
    icon: 'chest',
    armor: 0.7,
    rule: 'No single blow may take more than 18% of your health.',
    flavour: 'Cut from something that spent its whole life running at things.',
    mods: { maxHitFraction: 0.18 },
    from: 'boar',
  },
  {
    id: 'widows-weave',
    name: "Widow's Weave",
    slot: 'feet',
    icon: 'boots',
    armor: 0.4,
    rule: 'Webbing never slows you.',
    flavour: 'Woven from the thing that wove it. It remembers being on the other side.',
    mods: { webproof: true, moveSpeedMult: 1.06 },
    from: 'spider',
  },
  {
    id: 'stormcrow-quill',
    name: 'Stormcrow Quill',
    slot: 'head',
    icon: 'helm',
    armor: 0.45,
    rule: 'Whirlwind returns 1 second of its own cooldown for every beast it catches.',
    flavour: 'Picked up off the crag. It was not moulted.',
    mods: { wwRefundPerHit: 1 },
    from: 'corvid',
  },
]

export function uniqueById(id: string): UniqueDef | null {
  return UNIQUES.find((u) => u.id === id) ?? null
}

/** Chance an elite carries a relic the character has never found, before scaling. */
export const UNIQUE_DROP_CHANCE = 0.08

/* ------------------------------------------------------------------ *
 * Beast mastery — the bestiary's reward for kills already counted
 * ------------------------------------------------------------------ */

/**
 * Read straight off `Counters.species`, which the game has been keeping since
 * the first commit. Nothing new is stored: mastery is a view of kills, so it
 * survives any save and can never disagree with the bestiary.
 */
export const MASTERY_TIERS = [
  { at: 25, name: 'Tracker', damage: 1.06, resist: 1 },
  { at: 100, name: 'Stalker', damage: 1.12, resist: 0.95 },
  { at: 300, name: 'Bane', damage: 1.2, resist: 0.9 },
  { at: 750, name: 'Nemesis', damage: 1.3, resist: 0.85 },
]

/** Index into `MASTERY_TIERS`, or -1 before the first tier. */
export function masteryTier(kills: number): number {
  let tier = -1
  for (let i = 0; i < MASTERY_TIERS.length; i++) {
    if (kills >= MASTERY_TIERS[i]!.at) tier = i
  }
  return tier
}

export function masteryMods(kills: BySpecies): ModsPatch {
  const vs: Partial<BySpecies> = {}
  const from: Partial<BySpecies> = {}
  for (const kind of ENEMY_KINDS) {
    const tier = MASTERY_TIERS[masteryTier(kills[kind])]
    if (!tier) continue
    vs[kind] = tier.damage
    from[kind] = tier.resist
  }
  return { vs, from }
}

/* ------------------------------------------------------------------ *
 * Assembling a build
 * ------------------------------------------------------------------ */

/**
 * The single place the three sources are folded together, in a fixed order, so
 * the live game and the offline ledger can never disagree about what a
 * character's rules are. Takes ids rather than items on purpose: the ledger
 * works from a save, not from a `Game`.
 */
export function buildMods(
  wornUniques: readonly (string | undefined)[],
  talents: readonly string[],
  kills: BySpecies,
): Mods {
  const m = baseMods()
  for (const id of wornUniques) {
    const def = id ? uniqueById(id) : null
    if (def) mergeMods(m, def.mods)
  }
  for (const id of talents) {
    const t = talentById(id)
    if (t) mergeMods(m, t.mods)
  }
  mergeMods(m, masteryMods(kills))
  return m
}

/** Damage multiplier against one species, from mastery and any worn relic. */
export function damageVs(mods: Readonly<Mods>, kind: EnemyKind): number {
  return mods.vs[kind]
}

/** Damage multiplier taken from one species — mastery's other half. */
export function resistFrom(mods: Readonly<Mods>, kind: EnemyKind): number {
  return mods.from[kind]
}
