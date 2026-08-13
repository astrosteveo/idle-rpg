/**
 * The offline ledger.
 *
 * A pure function of a save and an elapsed time — no DOM, no `Game`, no clock of
 * its own. That is deliberate: this is the piece a server runs to settle a
 * character's absence, and the piece a ghost's visible behaviour will eventually
 * be a dramatisation of. Keeping it pure keeps both of those cheap.
 *
 * It is a rate model rather than a simulation, because it has to settle twelve
 * hours in a frame. See `OFFLINE` in content.ts for every constant it leans on.
 */
import {
  CRIT_MULT,
  ELITE,
  ENEMIES,
  OFFLINE,
  UNIQUES,
  UNIQUE_DROP_CHANCE,
  buildMods,
  damageVs,
  deriveStats,
  rewardScale,
  xpForLevel,
  xpScale,
} from './content'
import { itemScore, makeItem, makeUnique, rollRarity, sumStats } from './loot'
import type { DerivedStats } from './content'
import type { Rng } from '../core/math'
import type { Save } from './save'
import type { BySpecies, EnemyKind, Item, Slot } from './types'
import { SLOTS } from './types'
import { REGIONS, groundLevelOf, type BiomeId } from './world'

/**
 * Shared by the ledger and by the Hunt tab's estimate, so the number a player is
 * shown before choosing a ground is the number the ledger will actually pay.
 */
export function killsPerHour(
  stats: DerivedStats,
  kind: EnemyKind,
  groundLevel: number,
  /** Mastery and any worn relic's opinion of this species. See `damageVs`. */
  speciesMult = 1,
): number {
  const dps =
    (stats.damage / stats.attackInterval) *
    (1 + stats.crit * (CRIT_MULT - 1)) *
    speciesMult *
    OFFLINE.cleave[kind]
  const killInterval = ENEMIES[kind].hp(groundLevel) / Math.max(1, dps) + OFFLINE.seekSeconds
  return (3600 / killInterval) * OFFLINE.efficiency
}

export interface OfflineReport {
  ground: BiomeId
  groundName: string
  kind: EnemyKind
  /** Real time away, before the cap. */
  elapsedSeconds: number
  /** Time actually paid out. */
  creditedSeconds: number
  capped: boolean
  kills: number
  eliteKills: number
  xp: number
  gold: number
  levelFrom: number
  levelTo: number
  /** The best few drops, already sorted by score, with any relic appended. */
  items: Item[]
  /** Ids of relics found while away — at most one per absence. */
  uniques: string[]
  soldCount: number
  soldGold: number
}

/**
 * Returns null when there is nothing worth reporting: too short an absence, no
 * assigned ground, or a ground with nothing living in it.
 */
export function runOfflineLedger(save: Save, nowMs: number, rand: Rng): OfflineReport | null {
  const elapsedSeconds = Math.max(0, (nowMs - save.savedAt) / 1000)
  if (elapsedSeconds < OFFLINE.minReportSeconds) return null

  const ground = REGIONS.find((r) => r.id === save.huntingGround)
  if (!ground || !ground.kind) return null

  const creditedSeconds = Math.min(elapsedSeconds, OFFLINE.capHours * 3600)
  const kind = ground.kind
  const type = ENEMIES[kind]
  const groundLevel = groundLevelOf(ground)
  const eliteShare = ground.eliteNodes > 0 ? OFFLINE.eliteShare : 0

  // Elites are folded in as a share of kills rather than modelled separately;
  // their extra health is one of the things `efficiency` is paying for.
  const xpPerKill = type.xp(groundLevel) * (1 - eliteShare + eliteShare * ELITE.xpMult)
  const goldPerKill = type.gold(groundLevel) * (1 - eliteShare + eliteShare * ELITE.goldMult)

  const gear = sumStats(SLOTS.map((s: Slot) => save.equipped[s] ?? null))
  const worn = SLOTS.map((s: Slot) => save.equipped[s]?.unique)
  const levelFrom = save.player.level
  let level = save.player.level
  let xp = save.player.xp
  let xpNext = save.player.xpNext
  const base = { str: save.player.str, vit: save.player.vit, agi: save.player.agi }
  // Mastery is a function of kills, and kills are what this loop produces — so
  // the tally advances with the run and the build tightens as the night goes on,
  // exactly as it would at the keyboard.
  const killsByKind: BySpecies = { ...save.counters.species }

  let killsFloat = 0
  let gold = 0
  let xpTotal = 0
  let mods = buildMods(worn, save.talents, killsByKind)

  let remaining = creditedSeconds
  while (remaining > 0) {
    const slice = Math.min(OFFLINE.bucketSeconds, remaining)
    remaining -= slice

    const stats = deriveStats(level, base, gear, mods)
    const kills =
      (killsPerHour(stats, kind, groundLevel, damageVs(mods, kind)) / 3600) * slice
    if (kills <= 0) continue

    const scale = rewardScale(level, groundLevel)
    killsFloat += kills
    killsByKind[kind] += kills
    mods = buildMods(worn, save.talents, killsByKind)
    gold += kills * goldPerKill * scale * mods.goldMult
    // Levelling during the run can carry a character past the ground's cutoff,
    // at which point the rest of the night earns gold and drops but no levels.
    const gained = kills * xpPerKill * xpScale(level, groundLevel)
    xpTotal += gained

    // Level up between buckets so the next slice earns at the new rate.
    xp += gained
    while (xp >= xpNext) {
      xp -= xpNext
      level++
      base.str += 2
      base.vit += 2
      base.agi += 1
      xpNext = xpForLevel(level)
    }
  }

  const kills = Math.floor(killsFloat)
  if (kills <= 0) return null

  // Drops: materialise a bounded sample, keep the best few, and value the rest
  // from that sample's mean rather than generating thousands of items.
  const finalScale = rewardScale(level, groundLevel)
  const expectedDrops = Math.round(kills * type.dropChance * finalScale * mods.dropChanceMult)
  const sampled = Math.min(expectedDrops, OFFLINE.itemSampleCap)
  const rolled: Item[] = []
  for (let i = 0; i < sampled; i++) {
    const rarity = rollRarity(rand, eliteShare > 0 && rand() < eliteShare ? ELITE.rarityBonus : 0)
    const ilvl = groundLevel * finalScale + level * (1 - finalScale)
    rolled.push(makeItem(rand, Math.max(1, Math.round(ilvl) + rand.int(-1, 2)), rarity))
  }
  rolled.sort((a, b) => itemScore(b) - itemScore(a))

  const items = rolled.slice(0, OFFLINE.maxItemsKept)
  const leftovers = rolled.slice(OFFLINE.maxItemsKept)
  const meanValue = rolled.length
    ? rolled.reduce((sum, it) => sum + it.value, 0) / rolled.length
    : 0
  const unsampled = Math.max(0, expectedDrops - sampled)
  const soldCount = leftovers.length + unsampled
  const soldGold = Math.round(
    leftovers.reduce((sum, it) => sum + it.value, 0) + unsampled * meanValue,
  )

  const eliteKills = Math.round(kills * eliteShare)
  const relic = rollRelic(save, kind, eliteKills, finalScale, level, rand)
  if (relic) items.push(relic.item)

  return {
    ground: ground.id,
    groundName: ground.name,
    kind,
    elapsedSeconds,
    creditedSeconds,
    capped: elapsedSeconds > creditedSeconds,
    kills,
    eliteKills,
    xp: Math.round(xpTotal),
    gold: Math.round(gold) + soldGold,
    levelFrom,
    levelTo: level,
    items,
    uniques: relic ? [relic.id] : [],
    soldCount,
    soldGold,
  }
}

/**
 * Relics can be found while away, or the best items in the game would only ever
 * drop while someone is watching — which is the wrong rule for an idle game.
 *
 * One roll for the whole absence rather than one per elite: the chance is the
 * complement of missing every time, but the payout is capped at a single relic
 * so a long night cannot hand over the entire set at once.
 */
function rollRelic(
  save: Save,
  kind: EnemyKind,
  eliteKills: number,
  scale: number,
  level: number,
  rand: Rng,
): { id: string; item: Item } | null {
  if (eliteKills <= 0) return null
  const found = new Set(save.foundUniques)
  const pool = UNIQUES.filter((u) => !found.has(u.id) && (u.from === null || u.from === kind))
  if (!pool.length) return null
  const per = UNIQUE_DROP_CHANCE * scale
  if (rand() > 1 - Math.pow(1 - per, eliteKills)) return null
  const def = rand.pick(pool)
  return { id: def.id, item: makeUnique(def, level) }
}
