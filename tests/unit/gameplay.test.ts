import { describe, expect, it } from 'vitest'
import { rng } from '../../src/core/math'
import { SYSTEM_ORDER } from '../../src/game/contracts'
import {
  BOSSES,
  bossWindow,
  buildMods,
  rewardScale,
  xpScale,
} from '../../src/game/content'
import { runOfflineLedger } from '../../src/game/offline'
import { EcsSimulation } from '../../src/game/state'
import { CAMPS, REGIONS, World } from '../../src/game/world'

const dependencies = {
  clock: { now: () => 1_786_700_000_000 },
  rngFactory: { create: (seed: number) => rng(seed) },
}

function simulation() {
  return new EcsSimulation(new World(), dependencies)
}

describe('gameplay invariants', () => {
  it('publishes the approved deterministic system order', () => {
    expect(SYSTEM_ORDER).toEqual([
      'command-input', 'travel-target-selection', 'movement', 'player-attacks',
      'ground-effects', 'enemy-ai-attacks', 'rewards-progression', 'regeneration',
      'spawning-bosses', 'transient-cleanup',
    ])
  })

  it('cancels travel when manual input takes the stick', () => {
    const game = simulation()
    const target = CAMPS[1]!
    expect(game.dispatch({
      type: 'travel-to',
      target: { x: target.x, y: target.y, label: target.name, arrive: 60, stopHere: true },
    }).ok).toBe(true)
    expect(game.travel).not.toBeNull()
    game.update(1 / 60, { moveX: 1, moveY: 0 })
    expect(game.travel).toBeNull()
    expect(game.player.auto).toBe(false)
  })

  it('respawns a dead player at a discovered camp', () => {
    const game = simulation()
    game.player.alive = false
    game.player.hp = 0
    for (let i = 0; i < 180; i++) game.update(1 / 60, { moveX: 0, moveY: 0 })
    expect(game.player.alive).toBe(true)
    expect(game.player.hp).toBe(game.player.maxHp)
    expect(game.player.x).toBe(CAMPS[0]!.x)
  })

  it('requires explicit acceptance for an offered task', () => {
    const game = simulation()
    expect(game.quest).toBeNull()
    expect(game.offeredQuest).not.toBeNull()
    expect(game.dispatch({ type: 'accept-quest' }).ok).toBe(true)
    expect(game.quest).not.toBeNull()
  })

  it('starts ability cooldowns through the command boundary', () => {
    const game = simulation()
    expect(game.dispatch({ type: 'use-ability', ability: 'whirlwind' }).ok).toBe(true)
    expect(game.abilities[0]!.cd).toBeGreaterThan(0)
    expect(game.dispatch({ type: 'use-ability', ability: 'whirlwind' }).ok).toBe(false)
  })

  it('keeps experience and loot on their distinct low-level curves', () => {
    expect(xpScale(20, 1)).toBe(0)
    expect(rewardScale(20, 1)).toBeGreaterThan(0)
  })

  it('folds modifier sources without sharing mutable species records', () => {
    const first = buildMods([], [], { wolf: 0, bear: 0, boar: 0, spider: 0, corvid: 0 })
    const second = buildMods([], [], { wolf: 0, bear: 0, boar: 0, spider: 0, corvid: 0 })
    first.vs.wolf = 99
    expect(second.vs.wolf).not.toBe(99)
  })

  it('derives boss windows only from the injected wall clock value', () => {
    const now = dependencies.clock.now()
    expect(BOSSES.length).toBe(5)
    expect(bossWindow(now)).toBe(bossWindow(now + 1))
  })

  it('settles deterministic offline rewards from player-owned save data', () => {
    const game = simulation()
    const ground = REGIONS.find((region) => region.kind !== null)!
    game.setHuntingGround(ground.id)
    const save = game.serialize()
    const first = runOfflineLedger(save, save.savedAt + 3_600_000, rng(44))
    const second = runOfflineLedger(save, save.savedAt + 3_600_000, rng(44))
    expect(first).toEqual(second)
    expect(first?.kills).toBeGreaterThan(0)
  })
})
