import type { IconKind } from '../assets/types'
import { BOSSES, ITEM_BASES, MILESTONES, QUESTS, TALENT_ROWS, UNIQUES } from './content'
import type { Counters } from './state'
import { ENEMY_KINDS, SLOTS, perSpecies, type Item, type ItemStats, type Slot } from './types'
import { CAMPS, LANDMARKS, REGIONS, WORLD_SIZE, type BiomeId } from './world'

export const SAVE_VERSION = 1
export const SAVE_KEY = 'wildmarch.ecs.save.v1'

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
  v: 1
  seed: number
  savedAt: number
  player: SavedPlayer
  bag: (Item | null)[]
  equipped: Record<Slot, Item | null>
  nextUid: number
  counters: Counters
  questIndex: number
  questProgress: number
  questTaken: boolean
  claimed: string[]
  discovered: string[]
  seenLandmarks: string[]
  bossCleared: Record<string, number>
  huntingGround: BiomeId | null
  groundPinned: boolean
  autoEquip: boolean
  talents: string[]
  foundUniques: string[]
}

export type Save = SaveV1

const ICONS = new Set<IconKind>(['axe', 'sword', 'mace', 'helm', 'chest', 'gloves', 'boots', 'ring', 'coin', 'pelt'])
const ITEM_IDS = new Set(ITEM_BASES.map((item) => item.id))
const UNIQUE_IDS = new Set(UNIQUES.map((item) => item.id))
const TALENT_IDS = new Set(TALENT_ROWS.flatMap((row) => row.choices.map((choice) => choice.id)))
const CLAIM_IDS = new Set(MILESTONES.map((milestone) => milestone.id))
const CAMP_IDS = new Set(CAMPS.map((camp) => camp.id))
const LANDMARK_IDS = new Set(LANDMARKS.map((landmark) => landmark.id))
const BOSS_IDS = new Set(BOSSES.map((boss) => boss.id))
const BIOME_IDS = new Set<string>(REGIONS.map((region) => region.id))

/** Decode every value from unknown. A single invalid field rejects the whole save. */
export function readSave(value: unknown, expectSeed: number): Save | null {
  const root = record(value)
  if (!root || root.v !== SAVE_VERSION || root.seed !== expectSeed) return null
  const savedAt = finite(root.savedAt, 0, Number.MAX_SAFE_INTEGER)
  const player = readPlayer(root.player)
  const bag = readBag(root.bag)
  const equipped = readEquipment(root.equipped)
  const counters = readCounters(root.counters)
  const nextUid = integer(root.nextUid, 1, Number.MAX_SAFE_INTEGER)
  const questIndex = integer(root.questIndex, 0, QUESTS.length)
  const questProgress = integer(root.questProgress, 0, 1_000_000_000)
  const claimed = idArray(root.claimed, CLAIM_IDS, MILESTONES.length)
  const discovered = idArray(root.discovered, CAMP_IDS, CAMPS.length)
  const seenLandmarks = idArray(root.seenLandmarks, LANDMARK_IDS, LANDMARKS.length)
  const bossCleared = numberRecord(root.bossCleared, BOSS_IDS)
  const talents = idArray(root.talents, TALENT_IDS, TALENT_ROWS.length)
  const foundUniques = idArray(root.foundUniques, UNIQUE_IDS, UNIQUES.length)
  const huntingGround = root.huntingGround === null
    ? null
    : typeof root.huntingGround === 'string' && BIOME_IDS.has(root.huntingGround)
      ? (root.huntingGround as BiomeId)
      : undefined

  if (
    savedAt === null || !player || !bag || !equipped || !counters || nextUid === null ||
    questIndex === null || questProgress === null || !claimed || !discovered || !seenLandmarks ||
    !bossCleared || !talents || !foundUniques || huntingGround === undefined ||
    typeof root.questTaken !== 'boolean' || typeof root.groundPinned !== 'boolean' ||
    typeof root.autoEquip !== 'boolean'
  ) return null

  return {
    v: SAVE_VERSION,
    seed: expectSeed,
    savedAt,
    player,
    bag,
    equipped,
    nextUid,
    counters,
    questIndex,
    questProgress,
    questTaken: root.questTaken,
    claimed,
    discovered,
    seenLandmarks,
    bossCleared,
    huntingGround,
    groundPinned: root.groundPinned,
    autoEquip: root.autoEquip,
    talents,
    foundUniques,
  }
}

function readPlayer(value: unknown): SavedPlayer | null {
  const source = record(value)
  if (!source) return null
  const x = finite(source.x, 0, WORLD_SIZE)
  const y = finite(source.y, 0, WORLD_SIZE)
  const level = integer(source.level, 1, 10_000)
  const xp = finite(source.xp, 0, 1e15)
  const xpNext = finite(source.xpNext, 1, 1e15)
  const str = finite(source.str, 0, 1e9)
  const vit = finite(source.vit, 0, 1e9)
  const agi = finite(source.agi, 0, 1e9)
  const hp = finite(source.hp, 0, 1e15)
  const gold = finite(source.gold, 0, 1e15)
  if ([x, y, level, xp, xpNext, str, vit, agi, hp, gold].some((field) => field === null)) return null
  if (typeof source.auto !== 'boolean') return null
  return { x: x!, y: y!, level: level!, xp: xp!, xpNext: xpNext!, str: str!, vit: vit!, agi: agi!, hp: hp!, gold: gold!, auto: source.auto }
}

function readBag(value: unknown): (Item | null)[] | null {
  if (!Array.isArray(value) || value.length !== 40) return null
  const out: (Item | null)[] = []
  for (const entry of value) {
    if (entry === null) out.push(null)
    else {
      const item = readItem(entry)
      if (!item) return null
      out.push(item)
    }
  }
  return out
}

function readEquipment(value: unknown): Record<Slot, Item | null> | null {
  const source = record(value)
  if (!source) return null
  const out = {} as Record<Slot, Item | null>
  for (const slot of SLOTS) {
    const raw = source[slot]
    if (raw === null) out[slot] = null
    else {
      const item = readItem(raw)
      if (!item || item.slot !== slot) return null
      out[slot] = item
    }
  }
  return out
}

function readItem(value: unknown): Item | null {
  const source = record(value)
  if (!source) return null
  const uid = integer(source.uid, 1, Number.MAX_SAFE_INTEGER)
  const rarity = integer(source.rarity, 0, 4)
  const ilvl = integer(source.ilvl, 1, 100_000)
  const itemValue = integer(source.value, 0, 1e12)
  const stats = readStats(source.stats)
  if (
    uid === null || rarity === null || ilvl === null || itemValue === null || !stats ||
    typeof source.base !== 'string' || (!ITEM_IDS.has(source.base) && !UNIQUE_IDS.has(source.base)) ||
    typeof source.name !== 'string' || source.name.length < 1 || source.name.length > 120 ||
    typeof source.slot !== 'string' || !SLOTS.includes(source.slot as Slot) ||
    typeof source.icon !== 'string' || !ICONS.has(source.icon as IconKind)
  ) return null
  const unique = source.unique === undefined
    ? undefined
    : typeof source.unique === 'string' && UNIQUE_IDS.has(source.unique)
      ? source.unique
      : null
  if (unique === null) return null
  if (unique && (source.base !== unique || itemValue !== 0 || rarity !== 4)) return null
  return {
    uid,
    base: source.base,
    name: source.name,
    slot: source.slot as Slot,
    icon: source.icon as IconKind,
    rarity,
    ilvl,
    stats,
    value: itemValue,
    ...(unique ? { unique } : {}),
  }
}

function readStats(value: unknown): ItemStats | null {
  const source = record(value)
  if (!source) return null
  const allowed = new Set(['dmg', 'armor', 'str', 'vit', 'agi'])
  if (Object.keys(source).some((key) => !allowed.has(key))) return null
  const out: ItemStats = {}
  for (const key of allowed as Set<keyof ItemStats>) {
    if (source[key] === undefined) continue
    const amount = finite(source[key], 0, 1e9)
    if (amount === null) return null
    out[key] = amount
  }
  return out
}

function readCounters(value: unknown): Counters | null {
  const source = record(value)
  const speciesSource = source ? record(source.species) : null
  if (!source || !speciesSource) return null
  const species = perSpecies(0)
  for (const kind of ENEMY_KINDS) {
    const amount = integer(speciesSource[kind], 0, Number.MAX_SAFE_INTEGER)
    if (amount === null) return null
    species[kind] = amount
  }
  const kills = integer(source.kills, 0, Number.MAX_SAFE_INTEGER)
  const elite = integer(source.elite, 0, Number.MAX_SAFE_INTEGER)
  const bosses = integer(source.bosses, 0, Number.MAX_SAFE_INTEGER)
  const gold = integer(source.gold, 0, Number.MAX_SAFE_INTEGER)
  const quests = integer(source.quests, 0, Number.MAX_SAFE_INTEGER)
  if ([kills, elite, bosses, gold, quests].some((field) => field === null)) return null
  return { kills: kills!, elite: elite!, bosses: bosses!, gold: gold!, quests: quests!, species }
}

function idArray(value: unknown, allowed: ReadonlySet<string>, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxLength) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.has(entry) || seen.has(entry)) return null
    seen.add(entry)
    out.push(entry)
  }
  return out
}

function numberRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, number> | null {
  const source = record(value)
  if (!source) return null
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(source)) {
    const amount = integer(raw, 0, Number.MAX_SAFE_INTEGER)
    if (!allowed.has(key) || amount === null) return null
    out[key] = amount
  }
  return out
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null
}

function integer(value: unknown, min: number, max: number): number | null {
  const number = finite(value, min, max)
  return number !== null && Number.isInteger(number) ? number : null
}
