/**
 * Save verification. A spike for the server described in
 * `docs/design/server-backend.md`.
 *
 * `readSave` already answers "is this well-formed?" — every field decoded, every
 * bound checked. This file answers the harder question: "could an honest game
 * have produced it?" The two are different. A weapon with 9,000 damage decodes
 * perfectly and cannot exist.
 *
 * Nothing here simulates anything. Every check is a closed-form fact about the
 * generators in `loot.ts` and the curves in `content.ts`, which is what makes it
 * cheap enough to run on every upload, and what makes a violation proof rather
 * than a suspicion.
 *
 * Kept in `game/` because it belongs to the shared package the client and server
 * both import — the client can run it too, and a client that rejects its own
 * corrupt save is a client that never uploads one.
 */
import {
  AFFIX_POOL,
  MILESTONES,
  TALENT_ROWS,
  bossWindow,
  uniqueById,
  xpForLevel,
} from './content'
import { baseById } from './loot'
import type { Save } from './save'
import type { Item, ItemStats } from './types'

export interface Violation {
  /** Dotted path to the offending field, for the `anomaly` audit row. */
  path: string
  kind: string
  detail: string
}

/**
 * Affix magnitudes are the one part of an item that isn't closed-form:
 * `makeItem` scales them by `r.range(0.8, 1.25)`. The band below is that range
 * with a little slack, because the roll is rounded and the rounding can push a
 * value one outside a naive reconstruction of the bounds.
 */
const AFFIX_MIN = 0.8
const AFFIX_MAX = 1.25

const AFFIX_KEYS = new Set<keyof ItemStats>(AFFIX_POOL)

/**
 * Every Tier 1 check from the design, in one pass.
 *
 * Returns every violation rather than the first, because the audit trail is more
 * useful when it records the whole shape of a tampered save — one bad item is a
 * bug report, forty is an account to look at.
 */
export function verifySave(save: Save, nowMs: number): Violation[] {
  const out: Violation[] = []
  verifyItems(save, out)
  verifyProgression(save, out)
  verifyTalents(save, out)
  verifyMilestones(save, out)
  verifyBossWindows(save, nowMs, out)
  return out
}

function verifyItems(save: Save, out: Violation[]) {
  save.bag.forEach((item, index) => {
    if (item) verifyItem(item, `bag[${index}]`, out)
  })
  for (const [slot, item] of Object.entries(save.equipped)) {
    if (item) verifyItem(item, `equipped.${slot}`, out)
  }
}

/**
 * The load-bearing check. See `makeItem` and `makeUnique` in `loot.ts` — every
 * line below reconstructs one of their expressions.
 */
export function verifyItem(item: Item, path: string, out: Violation[]) {
  if (item.unique) {
    verifyUnique(item, path, out)
    return
  }

  const base = baseById(item.base)
  if (base.id !== item.base) {
    out.push({ path, kind: 'item-base', detail: `no base named ${item.base}` })
    return
  }
  if (base.slot !== item.slot || base.icon !== item.icon) {
    out.push({ path, kind: 'item-base', detail: `${item.base} is not a ${item.slot}/${item.icon}` })
  }

  const lvl = item.ilvl
  const rar = item.rarity

  const value = Math.round(base.value + lvl * 3.4 + rar * 22)
  if (item.value !== value) {
    out.push({ path, kind: 'item-value', detail: `expected ${value}, saw ${item.value}` })
  }

  // Base lines are exact. Armour is the exception: it is also in AFFIX_POOL, so
  // an affix can stack on top of the base line and only the floor is knowable.
  if (base.dmg) {
    const dmg = Math.round(base.dmg * lvl + 3 + rar * 2.2)
    if (item.stats.dmg !== dmg) {
      out.push({ path, kind: 'item-dmg', detail: `expected ${dmg}, saw ${item.stats.dmg ?? 0}` })
    }
  } else if (item.stats.dmg !== undefined && !AFFIX_KEYS.has('dmg')) {
    out.push({ path, kind: 'item-dmg', detail: `${item.base} cannot carry damage` })
  }

  const baseArmor = base.armor ? Math.round(base.armor * lvl + 2 + rar * 1.8) : 0

  // One affix per rarity tier, drawn without replacement, so the number of stat
  // lines that are not the base's own is exactly the rarity — capped by the pool.
  const affixCap = Math.min(rar, AFFIX_POOL.length)
  const { count, magnitudes } = affixesOf(item, base.dmg ? 'dmg' : null, baseArmor)
  if (count !== affixCap) {
    out.push({ path, kind: 'item-affix-count', detail: `rarity ${rar} allows ${affixCap} affixes, saw ${count}` })
  }

  const centre = 1.1 + lvl * 0.38 + rar * 0.5
  const min = Math.max(1, Math.floor(centre * AFFIX_MIN))
  const max = Math.max(1, Math.ceil(centre * AFFIX_MAX))
  for (const [key, magnitude] of magnitudes) {
    if (magnitude < min || magnitude > max) {
      out.push({
        path,
        kind: 'item-affix-magnitude',
        detail: `${key} of ${magnitude} outside [${min}, ${max}] at ilvl ${lvl} rarity ${rar}`,
      })
    }
  }
}

/**
 * Splits an item's stats into "the base's own lines" and "affixes", which is the
 * only ambiguous part of reading an item back. Armour is in the affix pool, so a
 * plate with more armour than its base line has spent an affix on armour.
 */
function affixesOf(
  item: Item,
  baseDmgKey: 'dmg' | null,
  baseArmor: number,
): { count: number; magnitudes: [keyof ItemStats, number][] } {
  const magnitudes: [keyof ItemStats, number][] = []
  let count = 0
  for (const [rawKey, rawValue] of Object.entries(item.stats)) {
    const key = rawKey as keyof ItemStats
    const amount = rawValue ?? 0
    if (key === baseDmgKey) continue
    if (key === 'armor') {
      if (amount === baseArmor) continue
      // An affix stacked on the base line; the affix is the difference.
      count++
      magnitudes.push([key, amount - baseArmor])
      continue
    }
    if (!AFFIX_KEYS.has(key)) {
      // A line no generator can produce at all — counted so the affix total fails.
      count++
      continue
    }
    count++
    magnitudes.push([key, amount])
  }
  return { count, magnitudes }
}

/** Relics are fully closed-form: no affixes, no value, one rarity. */
function verifyUnique(item: Item, path: string, out: Violation[]) {
  const def = uniqueById(item.unique!)
  if (!def) {
    out.push({ path, kind: 'relic-id', detail: `no relic named ${item.unique}` })
    return
  }
  if (item.rarity !== 4 || item.value !== 0) {
    out.push({ path, kind: 'relic-shape', detail: 'a relic is rarity 4 and worth nothing' })
  }
  const lvl = item.ilvl
  const dmg = def.dmg ? Math.round(def.dmg * lvl + 3) : undefined
  const armor = def.armor ? Math.round(def.armor * lvl + 2) : undefined
  if (item.stats.dmg !== dmg) {
    out.push({ path, kind: 'relic-dmg', detail: `expected ${dmg ?? 0}, saw ${item.stats.dmg ?? 0}` })
  }
  if (item.stats.armor !== armor) {
    out.push({ path, kind: 'relic-armor', detail: `expected ${armor ?? 0}, saw ${item.stats.armor ?? 0}` })
  }
  for (const key of Object.keys(item.stats)) {
    if (key !== 'dmg' && key !== 'armor') {
      out.push({ path, kind: 'relic-affix', detail: `a relic carries no ${key}` })
    }
  }
}

/** `xpNext` is a pure function of level, and `xp` has not yet paid for the next one. */
function verifyProgression(save: Save, out: Violation[]) {
  const expected = xpForLevel(save.player.level)
  if (save.player.xpNext !== expected) {
    out.push({
      path: 'player.xpNext',
      kind: 'xp-curve',
      detail: `level ${save.player.level} needs ${expected}, saw ${save.player.xpNext}`,
    })
  }
  if (save.player.xp >= save.player.xpNext) {
    out.push({
      path: 'player.xp',
      kind: 'xp-unspent',
      detail: `${save.player.xp} of ${save.player.xpNext} should have levelled`,
    })
  }
}

/** One pick per unlocked row, and never two from the same row. */
function verifyTalents(save: Save, out: Violation[]) {
  const rows = new Set<string>()
  for (const id of save.talents) {
    const row = TALENT_ROWS.find((r) => r.choices.some((c) => c.id === id))
    if (!row) {
      out.push({ path: 'talents', kind: 'talent-id', detail: `no talent named ${id}` })
      continue
    }
    if (row.level > save.player.level) {
      out.push({
        path: 'talents',
        kind: 'talent-level',
        detail: `${id} unlocks at ${row.level}, character is ${save.player.level}`,
      })
    }
    if (rows.has(row.id)) {
      out.push({ path: 'talents', kind: 'talent-row', detail: `two picks from row ${row.id}` })
    }
    rows.add(row.id)
  }
}

/** A claimed milestone has to be one the counters actually earned. */
function verifyMilestones(save: Save, out: Violation[]) {
  for (const id of save.claimed) {
    const milestone = MILESTONES.find((m) => m.id === id)
    if (!milestone) {
      out.push({ path: 'claimed', kind: 'milestone-id', detail: `no milestone named ${id}` })
      continue
    }
    const have = metricValue(save, milestone.metric)
    if (have < milestone.threshold) {
      out.push({
        path: 'claimed',
        kind: 'milestone-threshold',
        detail: `${id} needs ${milestone.metric} ${milestone.threshold}, saw ${have}`,
      })
    }
  }
}

function metricValue(save: Save, metric: string): number {
  const counters = save.counters
  switch (metric) {
    case 'kills': return counters.kills
    case 'elite': return counters.elite
    case 'bosses': return counters.bosses
    case 'gold': return counters.gold
    case 'quests': return counters.quests
    case 'level': return save.player.level
    default: {
      // `slain:wolf` and the rest of the per-species metrics.
      const kind = metric.startsWith('slain:') ? metric.slice(6) : metric
      return counters.species[kind as keyof typeof counters.species] ?? 0
    }
  }
}

/**
 * An apex clear is stamped with the window it happened in, and no window has
 * opened yet that the server's clock hasn't reached. This is the tightest bound
 * available on the largest single reward in the game.
 */
function verifyBossWindows(save: Save, nowMs: number, out: Violation[]) {
  const current = bossWindow(nowMs)
  for (const [id, window] of Object.entries(save.bossCleared)) {
    if (window > current) {
      out.push({
        path: `bossCleared.${id}`,
        kind: 'boss-window',
        detail: `cleared in window ${window}, clock is at ${current}`,
      })
    }
  }
}
