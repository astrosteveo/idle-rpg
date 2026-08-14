/**
 * Headless capacity benchmark. Run with `npm run bench`.
 *
 * The server design in `docs/design/server-backend.md` rests on one number: how
 * many authoritative simulations a single core can carry in real time. This
 * measures it by running the simulation with no renderer, no DOM, and an
 * injected clock — which is the same way the server will run it.
 *
 * It prints and asserts nothing. Timings vary by machine, and a benchmark that
 * fails the build on a busy laptop teaches everyone to ignore the build.
 */
import { describe, it } from 'vitest'
import { rng } from '../src/core/math'
import { EcsSimulation } from '../src/game/state'
import { World } from '../src/game/world'

const START = 1_786_700_000_000

function makeSim() {
  let clock = START
  const sim = new EcsSimulation(new World(), {
    clock: { now: () => clock },
    rngFactory: { create: (seed) => rng(seed) },
  })
  // A world-sized view, so nothing is culled by the screen test the server
  // build removes. See `shouldGiveUp` in state.ts.
  sim.setView({ x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 })
  return { sim, advance: (ms: number) => { clock += ms } }
}

function measure(hz: number, simSeconds: number) {
  const { sim, advance } = makeSim()
  const dt = 1 / hz
  const ticks = Math.round(simSeconds * hz)
  sim.dispatch({ type: 'toggle-auto' })

  // Warm the JIT before the clock starts.
  for (let i = 0; i < 400; i++) { sim.update(dt, { moveX: 0, moveY: 0 }); advance(dt * 1000) }

  const t0 = performance.now()
  for (let i = 0; i < ticks; i++) {
    sim.update(dt, { moveX: 0, moveY: 0 })
    advance(dt * 1000)
    sim.drainEvents()
  }
  const wall = (performance.now() - t0) / 1000
  const snapshot = sim.snapshot()

  console.log(
    `${String(hz).padStart(2)} Hz | ${((wall * 1000) / ticks).toFixed(4)} ms/tick | ` +
    `${String(Math.round(simSeconds / wall)).padStart(5)}x realtime | ` +
    `~${Math.floor(simSeconds / wall)} concurrent sims per core | ` +
    `${snapshot.counters.kills} kills, level ${snapshot.player.level} in ${simSeconds / 60} sim-minutes`,
  )
}

describe('simulation capacity', () => {
  it('measures tick cost with auto-battle running', () => {
    console.log(`world: ${new World().nodes.length} spawn nodes`)
    for (const hz of [10, 20, 30, 60]) measure(hz, 600)
  }, 600_000)

  it('measures what a naive snapshot costs on the wire', () => {
    const { sim, advance } = makeSim()
    sim.dispatch({ type: 'toggle-auto' })
    for (let i = 0; i < 20 * 600; i++) { sim.update(1 / 20, { moveX: 0, moveY: 0 }); advance(50) }

    const snapshot = sim.snapshot()
    const enemies = JSON.stringify(snapshot.enemies).length
    const count = Math.max(1, snapshot.enemies.length)
    console.log(
      `JSON snapshot: ${JSON.stringify(snapshot).length} B total | ` +
      `${enemies} B for ${snapshot.enemies.length} enemies (${Math.round(enemies / count)} B each) | ` +
      `save ${JSON.stringify(sim.serialize()).length} B`,
    )
    console.log(
      'The per-enemy figure is why the wire format needs its own view type: ' +
      'most of `Enemy` is server-side AI bookkeeping the client never draws.',
    )
  }, 600_000)
})
