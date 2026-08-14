/**
 * The world is drawn into a small offscreen buffer (roughly 900x500 "art
 * pixels") and then blitted to the full-size canvas with nearest-neighbour
 * scaling. That keeps every pixel square and uniform at any window size, and
 * makes the fill cost independent of the display resolution.
 */
import { clamp, hash2 } from '../core/math'
import { CAMPS, NPCS, TILE, WORLD_SIZE, type Npc, type PropInstance } from '../game/world'
import type { EcsSimulation } from '../game/state'
import type { Enemy } from '../game/types'
import { CHUNK_PX, CHUNK_TILES, Terrain } from './terrain'
import { drawTextCentered } from './font'
import type { Art } from './assets'
import type { Sheet } from './pixel'

/** Sheet rows, as `facingToDir` numbers them. */
const DIR_W = 1
const DIR_E = 2

type Drawable =
  | { y: number; sort: number; kind: 'prop'; prop: PropInstance }
  | { y: number; sort: number; kind: 'enemy'; enemy: Enemy }
  | { y: number; sort: number; kind: 'npc'; npc: Npc }
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
    private game: EcsSimulation,
    private art: Art,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    this.buf = document.createElement('canvas')
    const bctx = this.buf.getContext('2d', { alpha: false })
    if (!bctx) throw new Error('2d buffer unavailable')
    this.bctx = bctx
    this.terrain = new Terrain(game.world, art.terrainAtlas)
    this.camX = game.player.x
    this.camY = game.player.y
    this.resize()
  }

  resize() {
    // The real ratio, neither floored nor capped. Either one leaves the backing
    // store smaller than the panel, and the compositor makes up the difference
    // with a fractional bilinear upscale: standing still that softens the art,
    // and while the world scrolls each art pixel lands on a different
    // device-pixel phase every frame, so fine detail crawls.
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const cssW = Math.max(320, window.innerWidth)
    const cssH = Math.max(240, window.innerHeight)
    // Framing is chosen in CSS space so the visible slice of world stays
    // consistent across displays regardless of their pixel density.
    const zoom = clamp(Math.round(Math.min(cssW / 760, cssH / 440)), 1, 4)
    // ...but the blit has to land on whole device pixels, so the art-to-device
    // scale is rounded to an integer. On a fractional-DPR screen that shifts
    // the slice by a few percent, which is invisible; a non-integer scale would
    // make neighbouring art pixels cover different numbers of device pixels.
    const scale = Math.max(1, Math.round(zoom * dpr))
    // Device pixels actually on the panel. The canvas backing store is sized to
    // this exactly and then given a CSS size of cssW/cssH, which is the same
    // measurement divided back out — so the browser presents it 1:1.
    const devW = Math.round(cssW * dpr)
    const devH = Math.round(cssH * dpr)
    // Two art pixels of bleed beyond what the screen needs. `render` offsets the
    // blit by up to half an art pixel in either direction to scroll smoothly, so
    // the buffer has to overhang the canvas on both sides or that offset would
    // drag an uncovered edge into view.
    const wantW = Math.ceil(devW / scale) + 2
    const wantH = Math.ceil(devH / scale) + 2
    // Keep the buffer even in both axes. With an odd width, viewX0 lands on a
    // half pixel and Math.round flips direction depending on the camera's
    // fractional part — a guaranteed one-pixel shimmer as you walk.
    this.vw = wantW + (wantW % 2)
    this.vh = wantH + (wantH % 2)
    this.scale = scale
    this.buf.width = this.vw
    this.buf.height = this.vh
    this.canvas.width = devW
    this.canvas.height = devH
    this.canvas.style.width = `${cssW}px`
    this.canvas.style.height = `${cssH}px`
    this.ctx.imageSmoothingEnabled = false
    this.bctx.imageSmoothingEnabled = false
  }

  kick(amount: number) {
    this.shake = Math.min(6, this.shake + amount)
  }

  /** Locked to the player, not eased, so the world scrolls under a fixed sprite. */
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
    // Where the view really is, before the grid snap.
    const fx = this.viewX0 + (this.shake ? (hash2(time * 60, 1) - 0.5) * this.shake : 0)
    const fy = this.viewY0 + (this.shake ? (hash2(2, time * 60) - 0.5) * this.shake : 0)
    // Everything inside the buffer is drawn against a whole-art-pixel origin —
    // that snap is what keeps the low-res art crisp and stops the player sliding
    // against the ground. The fraction it discards is not thrown away though;
    // the blit below re-applies it at display resolution.
    const ox = Math.round(fx)
    const oy = Math.round(fy)

    this.drawTerrain(ctx, ox, oy)
    this.drawCampAuras(ctx, ox, oy)
    this.drawGrounds(ctx, ox, oy, time)
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
    // Sub-pixel scroll. Snapping the origin quantises the world's motion to
    // whole art pixels, so when the player moves less than one per frame the
    // world stalls and then jumps. Handing the discarded fraction to the blit
    // spends it at device resolution instead, the finest step the screen can
    // show. One art pixel of the bleed sits off the left/top edge so either
    // sign of the offset stays covered.
    const dx = -this.scale - Math.round((fx - ox) * this.scale)
    const dy = -this.scale - Math.round((fy - oy) * this.scale)
    this.ctx.drawImage(
      this.buf,
      0,
      0,
      this.vw,
      this.vh,
      dx,
      dy,
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

  /**
   * Burning ground, drawn on the ground layer so beasts and props stand *in*
   * it. Embers are placed from a hash of their index rather than a random
   * number, so a patch keeps the same scatter for its whole life instead of
   * boiling from frame to frame.
   */
  private drawGrounds(
    ctx: CanvasRenderingContext2D,
    ox: number,
    oy: number,
    time: number,
  ) {
    for (const g of this.game.grounds) {
      const life = clamp(1 - g.t / g.life, 0, 1)
      const sx = g.x - ox
      const sy = g.y - oy
      if (sx < -g.radius || sy < -g.radius) continue
      if (sx > this.vw + g.radius || sy > this.vh + g.radius) continue

      // The wash stays faint — a solid disc reads as scorched dirt, and what
      // makes it read as fire is the flames standing up out of it.
      const flicker = 1 + Math.sin(time * 11 + g.x) * 0.04
      ctx.fillStyle = `rgba(150,44,12,${0.17 * life})`
      pixelDisc(ctx, sx, sy, g.radius * flicker, g.radius * 0.6 * flicker)
      ctx.fillStyle = `rgba(240,110,30,${0.13 * life})`
      pixelDisc(ctx, sx, sy, g.radius * 0.6 * flicker, g.radius * 0.36 * flicker)

      const n = 46
      for (let i = 0; i < n; i++) {
        const a = hash2(i, g.x) * Math.PI * 2
        // sqrt keeps the scatter even across the area instead of crowding
        // the middle, which is where a uniform radius would pile them.
        const r = Math.sqrt(hash2(g.y, i)) * g.radius
        const px = Math.round(sx + Math.cos(a) * r)
        const py = Math.round(sy + Math.sin(a) * r * 0.6)
        // Each flame keeps its own phase, so the patch crackles rather than
        // pulsing in unison.
        const beat = (time * 2.2 + hash2(i, i * 3 + 1)) % 1
        if (beat > life) continue
        const h = 1 + Math.round((1 - Math.abs(beat * 2 - 1)) * 4)
        ctx.fillStyle = '#c9481a'
        ctx.fillRect(px, py - h, 2, h)
        ctx.fillStyle = beat < 0.45 ? '#ffd27a' : '#ff8a3c'
        ctx.fillRect(px, py - h, 2, Math.max(1, h - 2))
        if (h > 3) {
          ctx.fillStyle = '#fff2cd'
          ctx.fillRect(px, py - h, 2, 1)
        }
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
    for (const e of g.enemiesInRect({ x0: ox, y0: oy, x1: ox + this.vw, y1: oy + this.vh }, 90)) {
      if (!e.alive) continue
      list.push({ y: e.y, sort: e.y, kind: 'enemy', enemy: e })
    }
    for (const n of NPCS) {
      if (n.x < ox - 60 || n.x > ox + this.vw + 60) continue
      if (n.y < oy - 90 || n.y > oy + this.vh + 60) continue
      list.push({ y: n.y, sort: n.y, kind: 'npc', npc: n })
    }
    list.push({ y: g.player.y, sort: g.player.y + 0.5, kind: 'player' })
    list.sort((a, b) => a.sort - b.sort)

    for (const d of list) {
      if (d.kind === 'prop') this.drawProp(ctx, d.prop, ox, oy, time)
      else if (d.kind === 'enemy') this.drawEnemy(ctx, d.enemy, ox, oy)
      else if (d.kind === 'npc') this.drawNpc(ctx, d.npc, ox, oy, time)
      else this.drawPlayer(ctx, ox, oy)
    }
  }

  /**
   * A person, their name, and a mark over the head when they are holding work.
   * The mark bobs: a still figure among still props is easy to walk past, and
   * the one thing that moves is the one thing you look at.
   */
  private drawNpc(
    ctx: CanvasRenderingContext2D,
    n: Npc,
    ox: number,
    oy: number,
    time: number,
  ) {
    const img = this.art.npcs[n.sprite]
    const sx = Math.round(n.x - ox)
    const sy = Math.round(n.y - oy)
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    pixelDisc(ctx, sx, sy, 11, 4)
    ctx.drawImage(img, sx - Math.round(img.width / 2), sy - img.height)

    const top = sy - img.height
    if (this.game.offerFrom(n)) {
      const bob = Math.round(Math.sin(time * 3.4) * 2)
      const my = top - 18 + bob
      ctx.fillStyle = '#0a0b11'
      ctx.fillRect(sx - 3, my - 1, 6, 16)
      // Tapered stem and a separate dot: a solid bar of gold reads as a post.
      ctx.fillStyle = '#f2c14e'
      ctx.fillRect(sx - 2, my, 4, 6)
      ctx.fillRect(sx - 1, my + 6, 2, 3)
      ctx.fillRect(sx - 2, my + 11, 4, 3)
      ctx.fillStyle = '#fbe6a8'
      ctx.fillRect(sx - 2, my, 2, 6)
      ctx.fillRect(sx - 2, my + 11, 2, 3)
    }
    drawTextCentered(ctx, n.name, sx, top - 28, '#cbe4c9', 1)
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
    const sheet = this.sheetOf(e)
    const sx = e.x - ox
    const sy = e.y - oy

    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    pixelDisc(ctx, sx, sy, e.radius * 1.15, e.radius * 0.42)

    if (e.elite) {
      ctx.fillStyle = 'rgba(255,138,60,0.18)'
      pixelDisc(ctx, sx, sy, e.radius * 1.7, e.radius * 0.7)
    }

    // An apex stands on ground of its own — a wide pool with a dashed ring at
    // its edge, so it reads as a fixed encounter from across the field rather
    // than as a slightly larger elite.
    if (e.bossId) {
      const rx = e.radius * 2.9
      const ry = e.radius * 1.2
      ctx.fillStyle = 'rgba(242,193,78,0.1)'
      pixelDisc(ctx, sx, sy, rx, ry)
      ctx.fillStyle = 'rgba(242,193,78,0.45)'
      for (let i = 0; i < 72; i++) {
        if (i % 4 === 0) continue
        const a = (i / 72) * Math.PI * 2
        ctx.fillRect(Math.round(sx + Math.cos(a) * rx), Math.round(sy + Math.sin(a) * ry), 2, 2)
      }
    }

    // A boar pawing the ground holds the wind-up pose; the run itself is the
    // walk cycle at speed, so the tell is unmistakable and the charge is not.
    let col: number
    if (e.state === 'attack') col = e.windup > 0.12 ? 4 : 5
    else if (e.state === 'charge') col = e.windup > 0 ? 4 : Math.floor(e.anim) % 4
    else if (e.moving) col = Math.floor(e.anim) % 4
    else col = 0

    // A beast with a sheet drawn at all 8 angles uses its facing octant. One
    // drawn only from the side has no row for up or down, so it takes its row
    // from the heading instead: asking such a sheet for `e.dir` left the two
    // vertical octants on the eastward art, and each of those covers a wedge 45
    // degrees wide, so a wolf running down and to the left ran facing right.
    const row = sheet.directional ? e.dir : Math.cos(e.facing) < 0 ? DIR_W : DIR_E

    ctx.globalAlpha = e.state === 'return' ? 0.62 : 1
    this.blitFrame(ctx, sheet, col, row, sx, sy)
    if (e.hitFlash > 0) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = clamp(e.hitFlash / 0.12, 0, 1) * 0.75
      this.blitFrame(ctx, sheet, col, row, sx, sy)
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
          // A crescent sweeping through the swing arc — which the build can
          // widen, so it is read from the game rather than the constant.
          const spread = this.game.swingArc * 1.05
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
      const arc = this.game.swingArc
      const reach = this.game.swingRange
      ctx.fillStyle = 'rgba(230,240,255,0.13)'
      for (let i = 0; i < 40; i++) {
        const a = p.facing - arc + (i / 39) * arc * 2
        ctx.fillRect(
          Math.round(p.x - ox + Math.cos(a) * reach),
          Math.round(p.y - oy + Math.sin(a) * reach * 0.62),
          2,
          2,
        )
      }
    }
  }

  private drawNameplates(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    const g = this.game
    const targetId = g.player.targetId
    for (const e of g.enemiesInRect({ x0: ox, y0: oy, x1: ox + this.vw, y1: oy + this.vh }, 80)) {
      if (!e.alive) continue
      const engaged = e.state === 'chase' || e.state === 'attack'
      const hurt = e.hp < e.maxHp
      if (!engaged && !hurt && !e.elite) continue
      const sx = Math.round(e.x - ox)
      // Read the height off the sheet rather than the species: five bodies at
      // five scales, and a hard-coded pair put the bar through a rook's chest.
      const sy = Math.round(e.y - oy - this.sheetOf(e).fh - 8)
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
      const sy = Math.round(t.y - oy - this.sheetOf(t).fh - 8)
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

  /** The sheet a beast is drawn from — ordinary body, elite or apex. */
  private sheetOf(e: Enemy): Sheet {
    return this.art.beasts[e.sheet]
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
