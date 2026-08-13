import { Input } from './core/input'
import { rng } from './core/math'
import { runOfflineLedger, type OfflineReport } from './game/offline'
import { Game } from './game/state'
import { World } from './game/world'
import { buildArt } from './render/sprites'
import { Renderer } from './render/renderer'
import { UI } from './ui/ui'
import { installAutosave, loadSave } from './ui/storage'

const canvas = document.getElementById('game') as HTMLCanvasElement

const art = buildArt()
const world = new World()
const game = new Game(world)

const save = loadSave(world.seed)
let report: OfflineReport | null = null
if (save) {
  game.hydrate(save)
  // Settle the absence before the first frame, so the HUD never shows stale
  // numbers that jump a moment later.
  report = runOfflineLedger(save, Date.now(), rng((save.savedAt ^ 0x51ed270b) >>> 0))
  if (report) game.applyOfflineReport(report)
}
installAutosave(game)
const renderer = new Renderer(canvas, game, art)
const ui = new UI(game, renderer)
const input = new Input(ui.stickZone, ui.stick)

// Handy for poking at the simulation from the browser console.
;(window as unknown as { __game: Game; __renderer: Renderer }).__game = game
;(window as unknown as { __game: Game; __renderer: Renderer }).__renderer = renderer

window.addEventListener('resize', () => renderer.resize())
window.addEventListener('orientationchange', () => renderer.resize())

if (report) {
  ui.showReport(report)
  ui.log(`Returned from ${report.groundName}.`, '#f2c14e')
} else {
  ui.log('Welcome to the Wildmarch.', '#f2c14e')
  ui.log('WASD or drag the left half of the screen to move.')
  ui.log('Space toggles auto-battle. Q and E are your abilities.')
  ui.banner('Hearthglen Camp', 'Greenwood Vale')
}

let last = performance.now()

/**
 * Snap each step to a whole number of display frame periods.
 *
 * The renderer rounds the world's position to whole device pixels, so a small
 * error in `dt` is enough to flip that rounding and scroll the world a pixel
 * too far or too little. Estimating the display's period from recent deltas
 * gives a steady display a genuinely constant `dt`, and lets a dropped frame
 * come through as exactly two periods rather than as a smear.
 */
const PERIOD_SAMPLES = 31
const periods: number[] = []
let period = 1 / 60

function quantise(raw: number): number {
  // Keep the sample only if it looks like a real frame, so a stall or a
  // backgrounded tab cannot poison the estimate.
  if (raw > 0.002 && raw < 0.06) {
    periods.push(raw)
    if (periods.length > PERIOD_SAMPLES) periods.shift()
  }
  if (periods.length >= 8) {
    const sorted = [...periods].sort((a, b) => a - b)
    // The median survives the occasional long frame that a mean would absorb.
    period = sorted[sorted.length >> 1]!
  }
  // How many display frames this step really covers.
  const steps = Math.max(1, Math.min(4, Math.round(raw / period)))
  return steps * period
}

function frame(now: number) {
  // Clamp the step so a backgrounded tab doesn't teleport the whole world.
  const dt = Math.min(0.05, quantise((now - last) / 1000))
  last = now

  input.sample()
  // Simulate first, then move the camera. Following a player position that is
  // already a frame stale makes the camera-to-player offset depend on frame
  // timing, which the pixel snapping then turns into visible jitter.
  game.update(dt, input.moveX, input.moveY)
  renderer.updateCamera(dt)
  // The simulation needs the view rectangle: enemies give up the chase the
  // moment they fall off the visible screen. One frame old is plenty here.
  game.setView(
    renderer.viewX0,
    renderer.viewY0,
    renderer.viewX0 + renderer.vw,
    renderer.viewY0 + renderer.vh,
  )
  renderer.render(now / 1000)
  ui.update(dt)
  input.endFrame()

  requestAnimationFrame(frame)
}

requestAnimationFrame(frame)
