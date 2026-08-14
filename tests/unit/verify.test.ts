/**
 * Proves the claim the server design rests on: gear that no generator could
 * have produced is detectable without simulating anything.
 *
 * The first test is the one that matters. It generates items across every
 * rarity and a wide band of item levels and asserts the verifier accepts all of
 * them — because a check that rejects honest players is worse than no check.
 */
import { describe, expect, it } from 'vitest'
import { rng } from '../../src/core/math'
import { MILESTONES, TALENT_ROWS, UNIQUES, bossWindow, xpForLevel } from '../../src/game/content'
import { UidSequence, makeItem, makeUnique, rollRarity } from '../../src/game/loot'
import { runOfflineLedger } from '../../src/game/offline'
import type { Save } from '../../src/game/save'
import { EcsSimulation } from '../../src/game/state'
import { perSpecies, type Item } from '../../src/game/types'
import { verifyItem, verifySave } from '../../src/game/verify'
import { World } from '../../src/game/world'

const NOW = 1_786_700_000_000

function freshSave(): Save {
  const simulation = new EcsSimulation(new World(), {
    clock: { now: () => NOW },
    rngFactory: { create: (seed) => rng(seed) },
  })
  return simulation.serialize()
}

function violations(item: Item) {
  const out: ReturnType<typeof verifySave> = []
  verifyItem(item, 'item', out)
  return out
}

describe('item verification', () => {
  it('accepts everything the generator produces', () => {
    const rand = rng(0xa5f3)
    const uids = new UidSequence()
    const rejected: string[] = []
    let checked = 0

    for (let ilvl = 1; ilvl <= 60; ilvl++) {
      for (let i = 0; i < 60; i++) {
        const item = makeItem(rand, ilvl, rollRarity(rand), uids)
        const found = violations(item)
        checked++
        if (found.length) {
          rejected.push(`ilvl ${ilvl} rarity ${item.rarity} ${item.base}: ${found[0]!.detail}`)
        }
      }
    }

    expect(checked).toBe(3600)
    expect(rejected).toEqual([])
  })

  it('accepts every relic at every level it can be found at', () => {
    const uids = new UidSequence()
    for (const def of UNIQUES) {
      for (let ilvl = 1; ilvl <= 40; ilvl++) {
        expect(violations(makeUnique(def, ilvl, uids))).toEqual([])
      }
    }
  })

  it('accepts the items the offline ledger pays out', () => {
    const save = freshSave()
    save.huntingGround = 'vale'
    save.savedAt = NOW - 6 * 3600 * 1000
    const report = runOfflineLedger(save, NOW, rng(7))
    expect(report).not.toBeNull()
    expect(report!.items.length).toBeGreaterThan(0)
    for (const item of report!.items) expect(violations(item)).toEqual([])
  })

  it('rejects an inflated damage line', () => {
    const item = makeItem(rng(1), 5, 2, new UidSequence(), 'axe')
    const tampered = { ...item, stats: { ...item.stats, dmg: 9000 } }
    expect(violations(tampered).map((v) => v.kind)).toContain('item-dmg')
  })

  it('rejects an inflated affix', () => {
    const rand = rng(2)
    const uids = new UidSequence()
    let item = makeItem(rand, 5, 3, uids)
    while (!item.stats.str) item = makeItem(rand, 5, 3, uids)
    const tampered = { ...item, stats: { ...item.stats, str: item.stats.str! + 400 } }
    expect(violations(tampered).map((v) => v.kind)).toContain('item-affix-magnitude')
  })

  it('rejects extra affixes bolted onto a common item', () => {
    const item = makeItem(rng(3), 5, 0, new UidSequence(), 'axe')
    const tampered = { ...item, stats: { ...item.stats, str: 4, vit: 4, agi: 4 } }
    expect(violations(tampered).map((v) => v.kind)).toContain('item-affix-count')
  })

  it('rejects an item level raised without its stats', () => {
    const item = makeItem(rng(4), 5, 1, new UidSequence(), 'axe')
    expect(violations({ ...item, ilvl: 80 }).length).toBeGreaterThan(0)
  })

  it('rejects a relic given affixes', () => {
    const item = makeUnique(UNIQUES[0]!, 10, new UidSequence())
    const tampered = { ...item, stats: { ...item.stats, str: 50 } }
    expect(violations(tampered).map((v) => v.kind)).toContain('relic-affix')
  })

  it('rejects a relic priced to sell', () => {
    const item = makeUnique(UNIQUES[0]!, 10, new UidSequence())
    expect(violations({ ...item, value: 5000 }).map((v) => v.kind)).toContain('relic-shape')
  })
})

describe('save verification', () => {
  it('accepts a fresh character', () => {
    expect(verifySave(freshSave(), NOW)).toEqual([])
  })

  it('accepts a character carried through the offline ledger', () => {
    const simulation = new EcsSimulation(new World(), {
      clock: { now: () => NOW },
      rngFactory: { create: (seed) => rng(seed) },
    })
    const save = simulation.serialize()
    save.huntingGround = 'vale'
    save.savedAt = NOW - 8 * 3600 * 1000
    const report = runOfflineLedger(save, NOW, rng(11))
    expect(report).not.toBeNull()
    simulation.hydrate(save)
    simulation.applyOfflineReport(report!)
    expect(verifySave(simulation.serialize(), NOW)).toEqual([])
  })

  it('rejects a level that does not match its experience curve', () => {
    const save = freshSave()
    save.player.level = 40
    expect(verifySave(save, NOW).map((v) => v.kind)).toContain('xp-curve')
  })

  it('rejects unspent experience that should have levelled', () => {
    const save = freshSave()
    save.player.xp = save.player.xpNext
    expect(verifySave(save, NOW).map((v) => v.kind)).toContain('xp-unspent')
  })

  it('rejects a talent taken before its row unlocks', () => {
    const save = freshSave()
    const row = TALENT_ROWS.find((r) => r.level > 1)!
    save.talents = [row.choices[0]!.id]
    expect(verifySave(save, NOW).map((v) => v.kind)).toContain('talent-level')
  })

  it('rejects two picks from one talent row', () => {
    const save = freshSave()
    const row = TALENT_ROWS[0]!
    save.player.level = row.level
    save.player.xpNext = xpForLevel(row.level)
    save.talents = [row.choices[0]!.id, row.choices[1]!.id]
    expect(verifySave(save, NOW).map((v) => v.kind)).toContain('talent-row')
  })

  it('rejects a milestone claimed without the counters to earn it', () => {
    const save = freshSave()
    const milestone = MILESTONES.find((m) => m.metric === 'kills')!
    save.claimed = [milestone.id]
    save.counters = { ...save.counters, kills: 0, species: perSpecies(0) }
    expect(verifySave(save, NOW).map((v) => v.kind)).toContain('milestone-threshold')
  })

  it('accepts a milestone the counters do earn', () => {
    const save = freshSave()
    const milestone = MILESTONES.find((m) => m.metric === 'kills')!
    save.claimed = [milestone.id]
    save.counters = { ...save.counters, kills: milestone.threshold }
    expect(verifySave(save, NOW)).toEqual([])
  })

  it('rejects an apex cleared in a window the clock has not reached', () => {
    const save = freshSave()
    save.bossCleared = { greytooth: bossWindow(NOW) + 5 }
    expect(verifySave(save, NOW).map((v) => v.kind)).toContain('boss-window')
  })

  it('accepts an apex cleared in the current window', () => {
    const save = freshSave()
    save.bossCleared = { greytooth: bossWindow(NOW) }
    expect(verifySave(save, NOW)).toEqual([])
  })
})
