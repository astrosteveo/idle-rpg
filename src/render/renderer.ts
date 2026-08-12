/**
 * The world is drawn into a small offscreen buffer (roughly 900x500 "art
 * pixels") and then blitted to the full-size canvas with nearest-neighbour
 * scaling. That keeps every pixel square and uniform at any window size, and
 * makes the fill cost independent of the display resolution.
 */
import { clamp, hash2 } from '../core/math'
import { CAMPS, TILE, WORLD_SIZE, type PropInstance } from '../game/world'
import type { Game } from '../game/state'
import type { Enemy } from '../game/types'
import { ENEMIES, SWING_HALF_ANGLE, SWING_RANGE } from '../game/content'
import { CHUNK_PX, CHUNK_TILES, Terrain } from './terrain'
import { drawTextCentered } from './font'
import type { Art } from './sprites'
import type { Sheet } from './pixel'

type Drawable =
  | { y: number; sort: number; kind: 'prop'; prop: PropInstance }
  | { y: number; sort: number; kind: 'enemy'; enemy: Enemy }
  | { y: number; sort: number; kind: 'player' }

export class Renderer {
  readonly ctx: CanvasRenderingContext2D
  readonly buf: HTMLCanvasElement
  readonly bctx: CanvasRenderingContext2D
  private terrain: Terrain

  scale = 2
  vw = 900
  vh = 500
  camX = 0
  camY = 0
  private shake = 0
  private drawables: Drawable[] = []

  constructor(
    private canvas: HTMLCanvasElement,
    private game: Game,
    private art: Art,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    this.buf = document.createElement('canvas')
    const bctx = this.buf.getContext('2d', { alpha: false })
    if (!bctx) throw new Error('2d buffer unavailable')
    this.bctx = bctx
    this.terrain = new Terrain(game.world)
    this.camX = game.player.x
    this.camY = game.player.y
    this.resize()
  }

  resize() {
    const dpr = Math.max(1, Math.min(2, Math.floor(window.devicePixelRatio || 1)))
    const cssW = Math.max(320, window.innerWidth)
    const cssH = Math.max(240, window.innerHeight)
    // Choose an integer zoom so the visible slice of world stays consistent
    // across displays, then multiply by DPR so the blit is still 1:1.
    const zoom = clamp(Math.round(Math.min(cssW / 760, cssH / 440)), 1, 4)
    // Keep the buffer even in both axes. With an odd width, viewX0 lands on a
    // half pixel and Math.round flips direction depending on the camera's
    // fractional part — a guaranteed one-pixel shimmer as you walk.
    this.vw = Math.ceil(cssW / zoom) + (Math.ceil(cssW / zoom) % 2)
    this.vh = Math.ceil(cssH / zoom) + (Math.ceil(cssH / zoom) % 2)
    this.scale = zoom * dpr
    this.buf.width = this.vw
    this.buf.height = this.vh
    this.canvas.width = Math.floor(cssW * dpr)
    this.canvas.height = Math.floor(cssH * dpr)
    this.canvas.style.width = `${cssW}px`
    this.canvas.style.height = `${cssH}px`
    this.ctx.imageSmoothingEnabled = false
    this.bctx.imageSmoothingEnabled = false
  }

  kick(amount: number) {
    this.shake = Math.min(6, this.shake + amount)
  }

  /**
   * The camera is locked to the player rather than easing toward them.
   *
   * Smoothing looks tempting, but it leaves a sub-pixel offset between camera
   * and player that changes every frame. Once the render origin is snapped to
   * the pixel grid, that offset rounds one way and then the other, and the
   * player visibly twitches against the ground. Locking the camera makes the
   * player's screen position mathematically constant, so the world scrolls
   * cleanly underneath them.
   */
  updateCamera(dt: number) {
    const p = this.game.player
    this.camX = p.x
    this.camY = p.y - 6
    const halfW = this.vw / 2
    const halfH = this.vh / 2
    this.camX =
      this.vw >= WORLD_SIZE ? WORLD_SIZE / 2 : clamp(this.camX, halfW, WORLD_SIZE - halfW)
    this.camY =
      this.vh >= WORLD_SIZE ? WORLD_SIZE / 2 : clamp(this.camY, halfH, WORLD_SIZE - halfH)
    this.shake = Math.max(0, this.shake - dt * 22)
  }

  get viewX0() {
    return this.camX - this.vw / 2
  }
  get viewY0() {
    return this.camY - this.vh / 2
  }

  render(time: number) {
    const g = this.game
    const ctx = this.bctx
    const ox = Math.round(this.viewX0 + (this.shake ? (hash2(time * 60, 1) - 0.5) * this.shake : 0))
    const oy = Math.round(this.viewY0 + (this.shake ? (hash2(2, time * 60) - 0.5) * this.shake : 0))

    this.drawTerrain(ctx, ox, oy)
    this.drawCampAuras(ctx, ox, oy)
    this.drawCorpses(ctx, ox, oy)
    this.drawScene(ctx, ox, oy, time)
    this.drawEffects(ctx, ox, oy)
    this.drawNameplates(ctx, ox, oy)
    this.drawFloats(ctx, ox, oy)
    if (!g.player.alive) {
      ctx.fillStyle = 'rgba(70,10,10,0.35)'
      ctx.fillRect(0, 0, this.vw, this.vh)
    }

    this.ctx.imageSmoothingEnabled = false
    this.ctx.drawImage(
      this.buf,
      0,
      0,
      this.vw,
      this.vh,
      0,
      0,
      this.vw * this.scale,
      this.vh * this.scale,
    )
  }

  /* ---------------- layers ---------------- */

  private drawTerrain(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    const c0x = Math.floor(ox / CHUNK_PX)
    const c0y = Math.floor(oy / CHUNK_PX)
    const c1x = Math.floor((ox + this.vw) / CHUNK_PX)
    const c1y = Math.floor((oy + this.vh) / CHUNK_PX)
    const maxChunk = Math.ceil((WORLD_SIZE / TILE) / CHUNK_TILES)
    ctx.fillStyle = '#1b2a3a'
    ctx.fillRect(0, 0, this.vw, this.vh)
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        if (cx < 0 || cy < 0 || cx >= maxChunk || cy >= maxChunk) continue
        ctx.drawImage(this.terrain.chunk(cx, cy), cx * CHUNK_PX - ox, cy * CHUNK_PX - oy)
      }
    }
  }

  /** A warm ring marks where a camp's protection begins. */
  private drawCampAuras(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    for (const c of CAMPS) {
      const sx = c.x - ox
      const sy = c.y - oy
      if (sx < -c.radius * 1.2 || sy < -c.radius * 1.2) continue
      if (sx > this.vw + c.radius * 1.2 || sy > this.vh + c.radius * 1.2) continue
      ctx.fillStyle = 'rgba(242,193,78,0.055)'
      pixelDisc(ctx, sx, sy * 1, c.radius, c.radius * 0.78)
      // Dashed boundary
      ctx.fillStyle = 'rgba(242,193,78,0.5)'
      for (let i = 0; i < 96; i++) {
        if (i % 3 === 0) continue
        const a = (i / 96) * Math.PI * 2
        ctx.fillRect(
          Math.round(sx + Math.cos(a) * c.radius),
          Math.round(sy + Math.sin(a) * c.radius * 0.78),
          2,
          2,
        )
      }
    }
  }

  private drawCorpses(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    for (const c of this.game.corpses) {
      const img = this.art.corpses[c.sheet]
      if (!img) continue
      const alpha = c.t > 6 ? clamp(1 - (c.t - 6) / 3, 0, 1) : 1
      const sx = Math.round(c.x - ox)
      const sy = Math.round(c.y - oy)
      ctx.fillStyle = `rgba(58,14,12,${0.3 * alpha})`
      pixelDisc(ctx, sx, sy, img.width * 0.38, img.width * 0.16)
      ctx.save()
      ctx.globalAlpha = alpha * 0.92
      if (c.lean < 0) {
        // Half of them fall the other way, so a battlefield isn't a pattern.
        ctx.translate(sx + Math.round(img.width / 2), sy - img.height + 4)
        ctx.scale(-1, 1)
        ctx.drawImage(img, 0, 0)
      } else {
        ctx.drawImage(img, sx - Math.round(img.width / 2), sy - img.height + 4)
      }
      ctx.restore()
    }
  }

  private drawScene(
    ctx: CanvasRenderingContext2D,
    ox: number,
    oy: number,
    time: number,
  ) {
    const g = this.game
    const list = this.drawables
    list.length = 0

    for (const p of g.world.propsInView(ox, oy, ox + this.vw, oy + this.vh)) {
      list.push({ y: p.y, sort: p.y, kind: 'prop', prop: p })
    }
    for (const e of g.enemies) {
      if (!e.alive) continue
      if (e.x < ox - 70 || e.x > ox + this.vw + 70) continue
      if (e.y < oy - 90 || e.y > oy + this.vh + 70) continue
      list.push({ y: e.y, sort: e.y, kind: 'enemy', enemy: e })
    }
    list.push({ y: g.player.y, sort: g.player.y + 0.5, kind: 'player' })
    list.sort((a, b) => a.sort - b.sort)

    for (const d of list) {
      if (d.kind === 'prop') this.drawProp(ctx, d.prop, ox, oy, time)
      else if (d.kind === 'enemy') this.drawEnemy(ctx, d.enemy, ox, oy)
      else this.drawPlayer(ctx, ox, oy)
    }
  }

  private drawProp(
    ctx: CanvasRenderingContext2D,
    p: PropInstance,
    ox: number,
    oy: number,
    time: number,
  ) {
    const frames = this.art.props[p.kind]
    if (!frames) return
    const frame =
      p.kind === 'campfire'
        ? frames[Math.floor(time * 9) % frames.length]!
        : frames[p.variant % frames.length]!
    const sx = Math.round(p.x - ox - frame.width / 2)
    const sy = Math.round(p.y - oy - frame.height)
    if (p.kind === 'campfire') {
      // Pool of firelight on the ground, flickering with the flame frames.
      const flicker = 1 + Math.sin(time * 7) * 0.06
      ctx.fillStyle = 'rgba(240,150,60,0.13)'
      pixelDisc(ctx, p.x - ox, p.y - oy - 2, 44 * flicker, 18 * flicker)
      ctx.fillStyle = 'rgba(255,196,110,0.14)'
      pixelDisc(ctx, p.x - ox, p.y - oy - 2, 24 * flicker, 10 * flicker)
    } else if (frame.height > 24) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)'
      pixelDisc(ctx, p.x - ox, p.y - oy - 1, frame.width * 0.34, frame.width * 0.13)
    }
    ctx.drawImage(frame, sx, sy)
  }

  private drawEnemy(ctx: CanvasRenderingContext2D, e: Enemy, ox: number, oy: number) {
    const type = ENEMIES[e.kind]
    const sheet = this.sheetByName(e.elite ? type.eliteSheet : type.sheet)
    if (!sheet) return
    const sx = e.x - ox
    const sy = e.y - oy

    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    pixelDisc(ctx, sx, sy, e.radius * 1.15, e.radius * 0.42)

    if (e.elite) {
      ctx.fillStyle = e.kind === 'wolf' ? 'rgba(255,106,61,0.18)' : 'rgba(255,138,60,0.18)'
      pixelDisc(ctx, sx, sy, e.radius * 1.7, e.radius * 0.7)
    }

    let col: number
    if (e.state === 'attack') col = e.windup > 0.12 ? 4 : 5
    else if (e.moving) col = Math.floor(e.anim) % 4
    else col = 0

    ctx.globalAlpha = e.state === 'return' ? 0.62 : 1
    this.blitFrame(ctx, sheet, col, e.dir, sx, sy)
    if (e.hitFlash > 0) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = clamp(e.hitFlash / 0.12, 0, 1) * 0.75
      this.blitFrame(ctx, sheet, col, e.dir, sx, sy)
      ctx.globalCompositeOperation = 'source-over'
    }
    ctx.globalAlpha = 1
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    const p = this.game.player
    if (!p.alive) return
    const sheet = this.art.warrior
    const sx = p.x - ox
    const sy = p.y - oy

    ctx.fillStyle = 'rgba(0,0,0,0.32)'
    pixelDisc(ctx, sx, sy, 12, 5)

    let col: number
    if (p.swingT > 0) {
      const t = 1 - p.swingT / 0.34
      col = 4 + clamp(Math.floor(t * 3), 0, 2)
    } else if (p.moving) {
      col = Math.floor(p.anim) % 4
    } else {
      col = 0
    }

    if (p.invuln > 0 && Math.floor(p.invuln * 12) % 2 === 0) ctx.globalAlpha = 0.45
    this.blitFrame(ctx, sheet, col, p.dir, sx, sy)
    if (p.hitFlash > 0) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = clamp(p.hitFlash / 0.18, 0, 1) * 0.7
      this.blitFrame(ctx, sheet, col, p.dir, sx, sy)
      ctx.globalCompositeOperation = 'source-over'
    }
    ctx.globalAlpha = 1
  }

  private drawEffects(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    for (const fx of this.game.effects) {
      const t = fx.t / fx.life
      const sx = fx.x - ox
      const sy = fx.y - oy
      switch (fx.kind) {
        case 'slash': {
          // A crescent sweeping through the swing arc.
          const spread = SWING_HALF_ANGLE * 1.05
          const from = fx.angle - spread
          const sweep = spread * 2
          ctx.fillStyle = t < 0.5 ? '#ffffff' : '#cfd8ea'
          const head = from + sweep * clamp(t * 1.6, 0, 1)
          for (let i = 0; i < 16; i++) {
            const a = head - (i / 16) * sweep * 0.55
            if (a < from) break
            const r = fx.radius * (0.72 + 0.28 * Math.sin((i / 16) * Math.PI))
            const fade = 1 - i / 16
            if (fade < 0.15) continue
            ctx.globalAlpha = (1 - t) * fade
            ctx.fillRect(Math.round(sx + Math.cos(a) * r), Math.round(sy + Math.sin(a) * r * 0.62), 3, 3)
          }
          ctx.globalAlpha = 1
          break
        }
        case 'ring': {
          const r = fx.radius * (0.4 + t * 0.75)
          // Space the dots by arc length, otherwise a small ring collapses
          // into a solid gold blob instead of reading as an expanding circle.
          const n = clamp(Math.round(r * 0.62), 10, 96)
          ctx.fillStyle = fx.color
          ctx.globalAlpha = (1 - t) * 0.9
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2
            ctx.fillRect(
              Math.round(sx + Math.cos(a) * r),
              Math.round(sy + Math.sin(a) * r * 0.6),
              2,
              2,
            )
          }
          ctx.globalAlpha = 1
          break
        }
        case 'burst': {
          ctx.fillStyle = fx.color
          ctx.globalAlpha = 1 - t
          for (let i = 0; i < 9; i++) {
            const a = (i / 9) * Math.PI * 2 + fx.angle
            const r = fx.radius * (0.3 + t * 1.5)
            ctx.fillRect(Math.round(sx + Math.cos(a) * r), Math.round(sy + Math.sin(a) * r * 0.7), 2, 2)
          }
          ctx.globalAlpha = 1
          break
        }
        case 'heal': {
          ctx.fillStyle = fx.color
          ctx.globalAlpha = 1 - t
          for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2
            const px = Math.round(sx + Math.cos(a) * fx.radius * 0.7)
            const py = Math.round(sy + Math.sin(a) * fx.radius * 0.3 - t * 26)
            ctx.fillRect(px - 2, py, 5, 1)
            ctx.fillRect(px, py - 2, 1, 5)
          }
          ctx.globalAlpha = 1
          break
        }
        case 'spark': {
          ctx.fillStyle = fx.color
          ctx.globalAlpha = 1 - t
          for (let i = 0; i < 4; i++) {
            const a = fx.angle + i * 1.7
            const r = fx.radius * t * 1.8
            ctx.fillRect(Math.round(sx + Math.cos(a) * r), Math.round(sy + Math.sin(a) * r), 2, 2)
          }
          ctx.globalAlpha = 1
          break
        }
      }
    }

    // Reach indicator while auto-battling, so the swing arc is legible.
    const p = this.game.player
    if (p.auto && p.alive) {
      ctx.fillStyle = 'rgba(230,240,255,0.13)'
      for (let i = 0; i < 40; i++) {
        const a = p.facing - SWING_HALF_ANGLE + (i / 39) * SWING_HALF_ANGLE * 2
        ctx.fillRect(
          Math.round(p.x - ox + Math.cos(a) * SWING_RANGE),
          Math.round(p.y - oy + Math.sin(a) * SWING_RANGE * 0.62),
          2,
          2,
        )
      }
    }
  }

  private drawNameplates(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    const g = this.game
    const targetId = g.player.targetId
    for (const e of g.enemies) {
      if (!e.alive) continue
      const engaged = e.state === 'chase' || e.state === 'attack'
      const hurt = e.hp < e.maxHp
      if (!engaged && !hurt && !e.elite) continue
      const sx = Math.round(e.x - ox)
      const spriteH = e.kind === 'bear' ? 44 : 34
      const sy = Math.round(e.y - oy - spriteH - 8)
      if (sx < -60 || sx > this.vw + 60 || sy < -20 || sy > this.vh + 20) continue

      const w = e.elite ? 40 : 30
      const pct = clamp(e.hp / e.maxHp, 0, 1)
      ctx.fillStyle = '#0a0b11'
      ctx.fillRect(sx - w / 2 - 1, sy - 1, w + 2, 5)
      ctx.fillStyle = '#3a1614'
      ctx.fillRect(sx - w / 2, sy, w, 3)
      ctx.fillStyle = e.elite ? '#f0913a' : '#d8483f'
      ctx.fillRect(sx - w / 2, sy, Math.round(w * pct), 3)
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(sx - w / 2, sy, Math.round(w * pct), 1)

      // Only the beast you are actually fighting gets a name — otherwise a
      // pack of six turns the screen into a wall of text.
      if (e.elite || e.id === targetId) {
        drawTextCentered(
          ctx,
          `${e.name} ${e.level}`,
          sx,
          sy - 10,
          e.elite ? '#ffbe6a' : '#d6dce8',
          1,
        )
      }
    }

    // Marker over the auto-battle target.
    const t = g.enemyById(g.player.targetId)
    if (t && t.alive && g.player.auto) {
      const sx = Math.round(t.x - ox)
      const sy = Math.round(t.y - oy - (t.kind === 'bear' ? 52 : 42))
      ctx.fillStyle = '#f2c14e'
      ctx.fillRect(sx - 3, sy, 7, 2)
      ctx.fillRect(sx - 2, sy + 2, 5, 2)
      ctx.fillRect(sx - 1, sy + 4, 3, 2)
    }
  }

  private drawFloats(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    for (const f of this.game.floats) {
      const a = 1 - Math.pow(f.t / f.life, 2.4)
      if (a <= 0) continue
      ctx.globalAlpha = a
      drawTextCentered(
        ctx,
        f.text,
        Math.round(f.x - ox),
        Math.round(f.y - oy),
        f.color,
        f.size >= 10 ? 2 : 1,
      )
      ctx.globalAlpha = 1
    }
  }

  /* ---------------- helpers ---------------- */

  private sheetByName(name: string): Sheet | null {
    switch (name) {
      case 'wolf':
        return this.art.wolf
      case 'alphaWolf':
        return this.art.alphaWolf
      case 'bear':
        return this.art.bear
      case 'elderBear':
        return this.art.elderBear
      case 'warrior':
        return this.art.warrior
      default:
        return null
    }
  }

  private blitFrame(
    ctx: CanvasRenderingContext2D,
    sheet: Sheet,
    col: number,
    row: number,
    x: number,
    y: number,
  ) {
    ctx.drawImage(
      sheet.cv,
      Math.min(col, sheet.cols - 1) * sheet.fw,
      row * sheet.fh,
      sheet.fw,
      sheet.fh,
      Math.round(x - sheet.fw / 2),
      Math.round(y - sheet.anchorY),
      sheet.fw,
      sheet.fh,
    )
  }
}

/** Hard-edged filled ellipse — canvas arcs would antialias the pixel grid. */
function pixelDisc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
) {
  const top = Math.round(cy - ry)
  const bottom = Math.round(cy + ry)
  for (let y = top; y <= bottom; y++) {
    const dy = (y + 0.5 - cy) / ry
    if (dy * dy > 1) continue
    const half = rx * Math.sqrt(1 - dy * dy)
    const x0 = Math.round(cx - half)
    const x1 = Math.round(cx + half)
    if (x1 > x0) ctx.fillRect(x0, y, x1 - x0, 1)
  }
}
