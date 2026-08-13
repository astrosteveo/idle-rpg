/**
 * The save schema.
 *
 * Nothing here touches the DOM or storage. `Game` hands over a plain object and
 * takes one back, so the same schema a browser writes to localStorage is the one
 * a server would persist per account — which is the point, since the simulation
 * is meant to run in either place unchanged.
 *
 * Node populations are deliberately absent. Terrain, props and spawn placement
 * are pure functions of the world seed, and the `Game` constructor seeds every
 * node full on boot; a save that carried them would be describing shared-world
 * state a server will eventually own.
 */
import type { Counters } from './state'
import { ENEMY_KINDS, perSpecies, type Item, type Slot } from './types'
import type { BiomeId } from './world'

export const SAVE_VERSION = 3
export const SAVE_KEY = 'wildmarch.save'

export interface SavedPlayer {
  x: number
  y: number
  level: number
  xp: number
  xpNext: number
  str: number
  vit: number
  agi: number
  hp: number
  gold: number
  auto: boolean
}

export interface SaveV3 {
  v: number
  /** Saves are tied to the world they were made in. */
  seed: number
  /** Epoch ms, the anchor the offline ledger measures from. */
  savedAt: number
  player: SavedPlayer
  bag: (Item | null)[]
  equipped: Record<Slot, Item | null>
  /** Item uid high-water mark — see `restoreUidMark` in loot.ts. */
  nextUid: number
  counters: Counters
  questIndex: number
  questProgress: number
  claimed: string[]
  discovered: string[]
  huntingGround: BiomeId | null
  /** Whether the ground was chosen deliberately or is still following the player. */
  groundPinned: boolean
  autoEquip: boolean
  /** One talent id per unlocked row, in pick order. */
  talents: string[]
  /**
   * Relics this character has ever found, so no elite drops the same one twice.
   * Kept separate from the bag on purpose: a relic that was sold, or is sitting
   * in storage a future version adds, is still found.
   */
  foundUniques: string[]
}

/** The schema at the current version. Everything outside this file uses it. */
export type Save = SaveV3

/**
 * Structural check plus a forward migration, in one pass, because callers only
 * ever want the answer to "can I play this?".
 *
 * A save from another world is discarded — the seed decides where every camp
 * and den is, so a character restored into a different one would be standing in
 * a lake. Older schema versions are filled in with defaults instead, which is
 * cheap while every addition so far is additive.
 */
export function readSave(x: unknown, expectSeed: number): Save | null {
  if (!x || typeof x !== 'object') return null
  const s = x as Partial<Save>
  if (typeof s.v !== 'number' || s.v < 1 || s.v > SAVE_VERSION) return null
  if (s.seed !== expectSeed) return null
  if (typeof s.savedAt !== 'number' || !Number.isFinite(s.savedAt)) return null
  if (!s.player || typeof s.player.level !== 'number') return null
  if (!Array.isArray(s.bag) || !s.equipped) return null
  if (!s.counters || typeof s.counters.kills !== 'number') return null
  if (!Array.isArray(s.claimed) || !Array.isArray(s.discovered)) return null

  // v1 → v2: talents and found relics did not exist. An existing character
  // keeps its level and simply arrives with its picks unspent.
  const talents = Array.isArray(s.talents) ? s.talents.filter(isId) : []
  const foundUniques = Array.isArray(s.foundUniques) ? s.foundUniques.filter(isId) : []

  return {
    ...(s as Save),
    v: SAVE_VERSION,
    talents,
    foundUniques,
    counters: readCounters(s.counters),
  }
}

/**
 * v2 → v3: per-species kills moved from a field per animal (`wolf`, `bear`) to
 * one record keyed by species. The old fields were already named for their
 * species, so the migration is a lookup rather than a translation table — and a
 * species added since the save was written simply starts at zero.
 */
function readCounters(x: unknown): Counters {
  const c = (x ?? {}) as Record<string, unknown>
  const legacy = (c.species ?? c) as Record<string, unknown>
  const species = perSpecies(0)
  for (const kind of ENEMY_KINDS) species[kind] = count(legacy[kind])
  return {
    kills: count(c.kills),
    elite: count(c.elite),
    gold: count(c.gold),
    quests: count(c.quests),
    species,
  }
}

function count(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0
}

function isId(x: unknown): x is string {
  return typeof x === 'string'
}
