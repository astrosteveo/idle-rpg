import type { BeastSheetId, IconKind } from '../assets/types'

/** Sprite sheet row. See `facingToDir` for the octant each value covers. */
export type Dir = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

export type Slot = 'weapon' | 'head' | 'chest' | 'hands' | 'feet' | 'ring'

export const SLOTS: Slot[] = ['weapon', 'head', 'chest', 'hands', 'feet', 'ring']

export const SLOT_LABEL: Record<Slot, string> = {
  weapon: 'Weapon',
  head: 'Head',
  chest: 'Chest',
  hands: 'Hands',
  feet: 'Feet',
  ring: 'Ring',
}

export interface ItemStats {
  dmg?: number
  armor?: number
  str?: number
  vit?: number
  agi?: number
}

export interface Item {
  uid: number
  base: string
  name: string
  slot: Slot
  icon: IconKind
  rarity: number
  ilvl: number
  stats: ItemStats
  value: number
  /**
   * Id in `UNIQUES` when this item carries a rule rather than just numbers.
   * Present means `itemScore` is not allowed to decide anything about it —
   * auto-equip neither takes it nor replaces it, and it cannot be sold.
   */
  unique?: string
}

/**
 * Every species in the game, in one list. Species-keyed tables are declared as
 * `Record<EnemyKind, ...>`, so adding a name here fails the build everywhere
 * that would otherwise have silently kept a two-species assumption.
 */
export const ENEMY_KINDS = ['wolf', 'bear', 'boar', 'spider', 'corvid'] as const

export type EnemyKind = (typeof ENEMY_KINDS)[number]

/** One number per species — the shape mastery, relics and the ledger all use. */
export type BySpecies = Record<EnemyKind, number>

export function perSpecies(value: number): BySpecies {
  const out = {} as BySpecies
  for (const kind of ENEMY_KINDS) out[kind] = value
  return out
}

export type EnemyState =
  | 'idle'
  | 'wander'
  | 'chase'
  | 'attack'
  | 'return'
  | 'dead'
  /** Boar: pawing the ground, then committed to a straight line. */
  | 'charge'
  /** Corvid: blown off the kill and re-forming a moment later. */
  | 'scatter'

/**
 * States in which a beast is fighting the player and the de-aggro rule applies.
 * A species trick is still a chase — forgetting one here is how a charging
 * boar ends up following you across the map.
 */
export function isEngaged(state: EnemyState): boolean {
  return state === 'chase' || state === 'attack' || state === 'charge' || state === 'scatter'
}

export interface Enemy {
  id: number
  kind: EnemyKind
  elite: boolean
  level: number
  name: string
  /**
   * Which art this individual wears. Carried on the beast rather than looked
   * up from its species, because an apex is neither the ordinary body nor the
   * elite one — it has its own.
   */
  sheet: BeastSheetId
  x: number
  y: number
  /**
   * Unit heading, and only meaningful in `charge` and `scatter` — both commit
   * to a direction chosen once and then stop steering, which is the whole
   * point of them.
   */
  vx: number
  vy: number
  radius: number
  /** Half-width/height used for sprite draw scaling. */
  scale: number
  facing: number
  dir: Dir
  hp: number
  maxHp: number
  dmg: number
  speed: number
  xpValue: number
  goldValue: number
  alive: boolean
  state: EnemyState
  stateT: number
  anim: number
  moving: boolean
  attackCd: number
  windup: number
  /** Cooldown on this species' trick, kept apart from the melee swing. */
  special: number
  hitFlash: number
  /**
   * Index into `World.nodes`, or -1 for a beast no spawn node owns — a world
   * boss answers to the clock rather than to a den.
   */
  nodeId: number
  /** Id in `BOSSES` when this is an apex beast. */
  bossId?: string
  ax: number
  ay: number
  wx: number
  wy: number
  aggroRange: number
  leash: number
  attackRange: number
  deadT: number
}

export interface Player {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  facing: number
  dir: Dir
  hp: number
  maxHp: number
  level: number
  xp: number
  xpNext: number
  str: number
  vit: number
  agi: number
  anim: number
  moving: boolean
  attackCd: number
  /** Counts down through the 3-frame swing animation. */
  swingT: number
  swingDir: number
  hitFlash: number
  alive: boolean
  deadT: number
  gold: number
  auto: boolean
  targetId: number
  invuln: number
  /** Seconds of spider webbing still dragging on your stride. */
  webbed: number
}

export interface Ability {
  id: 'whirlwind' | 'secondwind'
  name: string
  key: string
  desc: string
  cooldown: number
  cd: number
}

export interface FloatText {
  x: number
  y: number
  vy: number
  t: number
  life: number
  text: string
  color: string
  size: number
}

export interface Effect {
  kind: 'slash' | 'ring' | 'burst' | 'heal' | 'spark'
  x: number
  y: number
  t: number
  life: number
  angle: number
  radius: number
  color: string
}

/**
 * A patch of ground that damages what stands in it. Unlike `Effect` this is
 * simulation, not decoration: it ticks, it kills, and it keeps burning while
 * the player is down.
 */
export interface Ground {
  x: number
  y: number
  radius: number
  t: number
  life: number
  /** Damage dealt per tick to every beast inside. */
  perTick: number
  /** Seconds until the next tick. */
  next: number
}

export interface Corpse {
  x: number
  y: number
  sheet: string
  /** Quarter-turn the body fell through, in radians. */
  lean: number
  t: number
}
