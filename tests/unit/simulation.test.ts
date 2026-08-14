import { describe, expect, it } from 'vitest'
import { rng } from '../../src/core/math'
import { EcsSimulation } from '../../src/game/state'
import { World } from '../../src/game/world'

const dependencies = {
  clock: { now: () => 1_786_700_000_000 },
  rngFactory: { create: (seed: number) => rng(seed) },
}

describe('ECS simulation', () => {
  it('replays deterministically with fixed dependencies', () => {
    const first = new EcsSimulation(new World(), dependencies)
    const second = new EcsSimulation(new World(), dependencies)
    first.setView({ x0: 1800, y0: 3200, x1: 3000, y1: 4200 })
    second.setView({ x0: 1800, y0: 3200, x1: 3000, y1: 4200 })
    for (let frame = 0; frame < 180; frame++) {
      const input = { moveX: frame < 90 ? 1 : 0, moveY: frame < 90 ? 0 : -1 }
      first.update(1 / 60, input)
      second.update(1 / 60, input)
    }
    expect(first.snapshot()).toEqual(second.snapshot())
  })

  it('maps live entities into component stores and removes dead ownership', () => {
    const simulation = new EcsSimulation(new World(), dependencies)
    expect(simulation.components.playerControl.has(EcsSimulation.PLAYER_ENTITY)).toBe(true)
    const enemy = simulation.enemies[0]!
    expect(simulation.components.spawnLink.get(enemy.id)?.nodeId).toBe(enemy.nodeId)
    expect(simulation.spatial.queryRadius(enemy.x, enemy.y, 4).some((candidate) => candidate.id === enemy.id)).toBe(true)
  })

  it('dispatches commands and advances slice revisions', () => {
    const simulation = new EcsSimulation(new World(), dependencies)
    const before = simulation.revisions.combat
    expect(simulation.dispatch({ type: 'toggle-auto' }).ok).toBe(true)
    simulation.update(1 / 60, { moveX: 0, moveY: 0 })
    expect(simulation.player.auto).toBe(true)
    expect(simulation.revisions.combat).toBeGreaterThan(before)
  })
})
