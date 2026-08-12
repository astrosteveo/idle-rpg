import type { Rng } from '../core/math'
import { clamp } from '../core/math'
import {
  AFFIX_POOL,
  ITEM_BASES,
  PREFIXES,
  RARITY_NAMES,
  SUFFIXES,
  type ItemBase,
} from './content'
import type { Item, ItemStats } from './types'

let nextUid = 1

export function baseById(id: string): ItemBase {
  return ITEM_BASES.find((b) => b.id === id) ?? ITEM_BASES[0]!
}

/** Weighted rarity roll; `bonus` shifts the curve for elites and chests. */
export function rollRarity(r: Rng, bonus = 0): number {
  const roll = r() * 100 - bonus * 14
  if (roll < 1.2) return 4
  if (roll < 7) return 3
  if (roll < 22) return 2
  if (roll < 52) return 1
  return 0
}

export function makeItem(r: Rng, ilvl: number, rarity: number, baseId?: string): Item {
  const base = baseId ? baseById(baseId) : r.pick(ITEM_BASES)
  const lvl = Math.max(1, Math.round(ilvl))
  const rar = clamp(rarity, 0, 4)
  const stats: ItemStats = {}

  if (base.dmg) stats.dmg = Math.round(base.dmg * lvl + 3 + rar * 2.2)
  if (base.armor) stats.armor = Math.round(base.armor * lvl + 2 + rar * 1.8)

  // One affix per rarity tier, never duplicating a line.
  const pool = [...AFFIX_POOL]
  for (let i = 0; i < rar; i++) {
    if (!pool.length) break
    const idx = Math.floor(r() * pool.length)
    const key = pool.splice(idx, 1)[0]!
    const mag = Math.max(1, Math.round((1.1 + lvl * 0.38 + rar * 0.5) * r.range(0.8, 1.25)))
    stats[key] = (stats[key] ?? 0) + mag
  }

  const prefixes = PREFIXES[rar] ?? PREFIXES[0]!
  const prefix = rar > 0 ? `${r.pick(prefixes)} ` : ''
  const suffix = rar >= 2 ? ` ${r.pick(SUFFIXES.slice(1))}` : ''

  return {
    uid: nextUid++,
    base: base.id,
    name: `${prefix}${base.name}${suffix}`.trim(),
    slot: base.slot,
    icon: base.icon,
    rarity: rar,
    ilvl: lvl,
    stats,
    value: Math.round(base.value + lvl * 3.4 + rar * 22),
  }
}

/** Single number used for "is this an upgrade?" comparisons and auto-equip. */
export function itemScore(it: Item | null | undefined): number {
  if (!it) return 0
  const s = it.stats
  return (
    (s.dmg ?? 0) * 3.2 +
    (s.armor ?? 0) * 1.1 +
    (s.str ?? 0) * 2 +
    (s.vit ?? 0) * 1.3 +
    (s.agi ?? 0) * 1.7
  )
}

export function rarityName(r: number): string {
  return RARITY_NAMES[clamp(r, 0, 4)]!
}

export function statLines(it: Item): string[] {
  const s = it.stats
  const out: string[] = []
  if (s.dmg) out.push(`+${s.dmg} Damage`)
  if (s.armor) out.push(`+${s.armor} Armour`)
  if (s.str) out.push(`+${s.str} Strength`)
  if (s.vit) out.push(`+${s.vit} Vitality`)
  if (s.agi) out.push(`+${s.agi} Agility`)
  return out
}

export function sumStats(items: (Item | null)[]): ItemStats {
  const total: ItemStats = { dmg: 0, armor: 0, str: 0, vit: 0, agi: 0 }
  for (const it of items) {
    if (!it) continue
    total.dmg! += it.stats.dmg ?? 0
    total.armor! += it.stats.armor ?? 0
    total.str! += it.stats.str ?? 0
    total.vit! += it.stats.vit ?? 0
    total.agi! += it.stats.agi ?? 0
  }
  return total
}
