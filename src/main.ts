import '@fontsource/cinzel/600.css'
import '@fontsource/cinzel/700.css'
import '@fontsource/source-sans-3/400.css'
import '@fontsource/source-sans-3/600.css'
import { Input } from './core/input'
import { rng } from './core/math'
import type { GameCommand, GameSnapshot } from './game/contracts'
import { runOfflineLedger, type OfflineReport } from './game/offline'
import { EcsSimulation } from './game/state'
import { World } from './game/world'
import { preloadArt } from './render/assets'
import { Renderer } from './render/renderer'
import { UI } from './ui/ui'
import { installAutosave, loadSave } from './ui/storage'

declare global {
  interface Window {
    __wildmarch?: {
      simulation: EcsSimulation
      renderer: Renderer
      dispatch: (command: GameCommand) => ReturnType<EcsSimulation['dispatch']>
      snapshot: () => Readonly<GameSnapshot>
    }
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement
const loading = document.getElementById('loading')!

void start().catch((error: unknown) => {
  loading.classList.add('fatal')
  loading.innerHTML = `<strong>Wildmarch could not start.</strong><span>${escapeHtml(
    error instanceof Error ? error.message : 'A required asset is unavailable.',
  )}</span>`
  console.error(error)
})

async function start() {
  const art = await preloadArt()
  const world = new World()
  const dependencies = {
    clock: { now: () => Date.now() },
    rngFactory: { create: (seed: number) => rng(seed) },
  }
  const simulation = new EcsSimulation(world, dependencies)
  const save = loadSave(world.seed)
  let report: OfflineReport | null = null
  if (save) {
    simulation.hydrate(save)
    report = runOfflineLedger(save, dependencies.clock.now(), dependencies.rngFactory.create((save.savedAt ^ 0x51ed270b) >>> 0))
    if (report) simulation.applyOfflineReport(report)
  }
  installAutosave(simulation)
  const renderer = new Renderer(canvas, simulation, art)
  const ui = new UI(simulation, renderer)
  const input = new Input(ui.stickZone, ui.stick)

  window.__wildmarch = {
    simulation,
    renderer,
    dispatch: (command) => simulation.dispatch(command),
    snapshot: () => simulation.snapshot(),
  }

  window.addEventListener('resize', () => renderer.resize())
  window.addEventListener('orientationchange', () => renderer.resize())

  if (report) {
    ui.showReport(report)
    ui.log(`Returned from ${report.groundName}.`, '#f2c14e')
  } else {
    ui.log('Welcome to the Wildmarch.', '#f2c14e')
    ui.log('WASD or drag the left half of the screen to move.')
    ui.log('Space toggles auto-battle. Q and E are your abilities.')
    ui.log('Warden Aldric waits by the fire. Stand near him and press G.', '#cbe4c9')
    ui.banner('Hearthglen Camp', 'Greenwood Vale')
  }

  loading.classList.add('done')
  beginFrameLoop(simulation, renderer, ui, input)
}

function beginFrameLoop(simulation: EcsSimulation, renderer: Renderer, ui: UI, input: Input) {
  let last = performance.now()
  const samples: number[] = []
  let period = 1 / 60

  const quantise = (raw: number): number => {
    if (raw > 0.002 && raw < 0.06) {
      samples.push(raw)
      if (samples.length > 31) samples.shift()
    }
    if (samples.length >= 8) {
      const sorted = [...samples].sort((a, b) => a - b)
      period = sorted[sorted.length >> 1]!
    }
    return Math.max(1, Math.min(4, Math.round(raw / period))) * period
  }

  const frame = (now: number) => {
    const dt = Math.min(0.05, quantise((now - last) / 1000))
    last = now
    input.sample()
    simulation.update(dt, { moveX: input.moveX, moveY: input.moveY })
    renderer.updateCamera(dt)
    simulation.setView({
      x0: renderer.viewX0,
      y0: renderer.viewY0,
      x1: renderer.viewX0 + renderer.vw,
      y1: renderer.viewY0 + renderer.vh,
    })
    renderer.render(now / 1000)
    ui.update(dt)
    input.endFrame()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

function escapeHtml(value: string): string {
  const node = document.createElement('span')
  node.textContent = value
  return node.innerHTML
}
