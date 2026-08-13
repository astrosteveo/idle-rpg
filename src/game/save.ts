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
import type { Item, Slot } from './types'
import type { BiomeId } from './world'

export const SAVE_VERSION = 1
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

export interface SaveV1 {
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
}

/**
 * Structural check only. A save from a different schema version or a different
 * world is discarded rather than migrated — real migrations arrive with the
 * first schema change worth preserving, and the `v` field is what makes them
 * possible later.
 */
export function isSaveV1(x: unknown, expectSeed: number): x is SaveV1 {
  if (!x || typeof x !== 'object') return false
  const s = x as Partial<SaveV1>
  if (s.v !== SAVE_VERSION) return false
  if (s.seed !== expectSeed) return false
  if (typeof s.savedAt !== 'number' || !Number.isFinite(s.savedAt)) return false
  if (!s.player || typeof s.player.level !== 'number') return false
  if (!Array.isArray(s.bag) || !s.equipped) return false
  if (!s.counters || typeof s.counters.kills !== 'number') return false
  if (!Array.isArray(s.claimed) || !Array.isArray(s.discovered)) return false
  return true
}
