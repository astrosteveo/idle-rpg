/**
 * Does an hour away pay the same as an hour played?
 *
 * `OFFLINE.efficiency` states the intent: idle should earn about 0.72 of active,
 * the discount covering healing, pathing, and waiting on respawns. Nothing has
 * ever checked that the rate model actually lands there, because until now the
 * ledger and the live loop only had to agree well enough for an estimate on the
 * Hunt tab.
 *
 * Under a server-authoritative design that changes. The ledger stops being an
 * estimate and becomes the definitive account of an absence, so the gap between
 * the two is a gameplay balance number that needs a gate on it.
 *
 * This is a characterization test. It records where the ratio sits today, not
 * where it should sit — see the note on the target below. Both sides are fully
 * deterministic (fixed seeds, an injected clock, no wall time), so any movement
 * here is a real change in the model, never flake.
 */
import { describe, expect, it } from 'vitest'
import { rng } from '../../src/core/math'
import { runOfflineLedger } from '../../src/game/offline'
import { EcsSimulation } from '../../src/game/state'
import { World } from '../../src/game/world'
import type { BiomeId } from '../../src/game/world'

const START = 1_786_700_000_000
const HOUR_SECONDS = 3600
const TICK_HZ = 20

/** What `OFFLINE.efficiency` says an hour away should be worth. */
const INTENT = 0.72

interface Comparison {
  liveKills: number
  ledgerKills: number
  ratio: number
}

function compareOneHour(ground: BiomeId, warmupSeconds: number): Comparison {
  let clock = START
  const sim = new EcsSimulation(new World(), {
    clock: { now: () => clock },
    rngFactory: { create: (seed) => rng(seed) },
  })
  sim.setView({ x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 })
  sim.dispatch({ type: 'toggle-auto' })
  sim.setHuntingGround(ground)

  const tick = () => {
    sim.update(1 / TICK_HZ, { moveX: 0, moveY: 0 })
    clock += 1000 / TICK_HZ
  }

  // Warm up so the comparison starts from a character that is already hunting
  // rather than one still walking out of camp.
  for (let i = 0; i < TICK_HZ * warmupSeconds; i++) tick()

  const save = sim.serialize()
  const killsBefore = sim.snapshot().counters.kills

  for (let i = 0; i < TICK_HZ * HOUR_SECONDS; i++) tick()
  const liveKills = sim.snapshot().counters.kills - killsBefore

  const report = runOfflineLedger(
    { ...save, savedAt: START + warmupSeconds * 1000 },
    START + warmupSeconds * 1000 + HOUR_SECONDS * 1000,
    rng(4242),
  )
  expect(report).not.toBeNull()

  return { liveKills, ledgerKills: report!.kills, ratio: report!.kills / liveKills }
}

describe('the ledger against the simulation', () => {
  it('pays about half what an hour of play pays, against an intended 0.72', () => {
    const early = compareOneHour('vale', 120)
    const late = compareOneHour('thicket', 900)

    for (const [label, run] of [['early', early], ['late', late]] as const) {
      expect(run.liveKills, `${label}: the live hour produced no kills to compare against`)
        .toBeGreaterThan(200)
    }

    // Where it sits today, on both a low-level and a high-level character. The
    // band is wide enough to survive incidental changes and tight enough to
    // catch a real shift in either model.
    expect(early.ratio).toBeGreaterThan(0.4)
    expect(early.ratio).toBeLessThan(0.6)
    expect(late.ratio).toBeGreaterThan(0.4)
    expect(late.ratio).toBeLessThan(0.6)

    // The gap this test exists to keep visible. Closing it means either raising
    // the ledger's rate or accepting a smaller `OFFLINE.efficiency` as the real
    // intent — a balance decision, not a bug fix, which is why this asserts the
    // measurement rather than the target.
    expect(early.ratio).toBeLessThan(INTENT)
    expect(late.ratio).toBeLessThan(INTENT)
  }, 120_000)
})
