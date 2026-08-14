/**
 * Tiny pixel-art drawing surface.
 *
 * Everything in this game is authored at "art pixel" resolution (1 unit = 1
 * pixel in the low-res render buffer) and blitted 1:1, so all drawing here is
 * integer rects. No anti-aliasing, ever.
 */
export class PixelCanvas {
  readonly cv: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.cv = document.createElement('canvas')
    this.cv.width = w
    this.cv.height = h
    const ctx = this.cv.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('2d context unavailable')
    ctx.imageSmoothingEnabled = false
    this.ctx = ctx
  }

  /**
   * Filled rect snapped to whole pixels.
   *
   * Both edges are rounded independently rather than rounding the origin and
   * the size: a shape whose edge slides across the grid then has each edge
   * behave as its own rounded ramp, instead of the far edge inheriting the
   * near edge's rounding error and jittering by a pixel. It also means two
   * parts that abut at a fractional coordinate still abut after snapping.
   */
  px(x: number, y: number, w: number, h: number, color: string): this {
    if (w <= 0 || h <= 0) return this
    const x0 = Math.round(x)
    const y0 = Math.round(y)
    const x1 = Math.round(x + w)
    const y1 = Math.round(y + h)
    if (x1 <= x0 || y1 <= y0) return this
    this.ctx.fillStyle = color
    this.ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    return this
  }

  dot(x: number, y: number, color: string): this {
    return this.px(x, y, 1, 1, color)
  }

  /**
   * One scanline from `xa` to `xb` in continuous coordinates, never thinner
   * than a pixel. The two ends round separately so each side of a tapering
   * shape walks the grid on its own — this is what keeps a slanted edge
   * stepping evenly instead of stuttering as the run width flips parity.
   */
  private span(xa: number, xb: number, y: number, color: string): void {
    let x0 = Math.round(xa)
    let x1 = Math.round(xb)
    if (x1 <= x0) {
      // Sub-pixel remainder: keep a single pixel centred on the run.
      x0 = Math.round((xa + xb) / 2 - 0.5)
      x1 = x0 + 1
    }
    this.ctx.fillStyle = color
    this.ctx.fillRect(x0, Math.round(y), x1 - x0, 1)
  }

  /** Axis-aligned ellipse rasterised by scanline — gives clean pixel curves. */
  oval(cx: number, cy: number, rx: number, ry: number, color: string): this {
    this.ctx.fillStyle = color
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      const dy = (y + 0.5 - cy) / ry
      if (dy * dy > 1) continue
      const half = rx * Math.sqrt(1 - dy * dy)
      const x0 = Math.round(cx - half)
      const x1 = Math.round(cx + half)
      if (x1 > x0) this.ctx.fillRect(x0, y, x1 - x0, 1)
    }
    return this
  }

  /** Rect with the four corner pixels knocked out — reads as a soft blob. */
  blob(x: number, y: number, w: number, h: number, color: string): this {
    this.px(x + 1, y, w - 2, 1, color)
    this.px(x, y + 1, w, h - 2, color)
    this.px(x + 1, y + h - 1, w - 2, 1, color)
    return this
  }

  /**
   * Right triangle-ish wedge, used for ears, fangs, spikes.
   *
   * This and the two tapers below hand `span` a pair of continuous edges and
   * let it round each side on its own, and they divide last so a half-step
   * never lands on the wrong side of a rounding tie. Both matter: computing a
   * row width and then centring it couples the two edges, and the shape's
   * slant then stutters with the parity of the width rather than stepping
   * evenly.
   */
  wedge(x: number, y: number, w: number, h: number, color: string, flip = false): this {
    for (let i = 0; i < h; i++) {
      const rowW = (w * (h - i)) / h
      if (flip) this.span(x + w - rowW, x + w, y + i, color)
      else this.span(x, x + rowW, y + i, color)
    }
    return this
  }

  /** Downward taper: full width at the top, a point at the bottom. */
  spike(cx: number, y: number, w: number, h: number, color: string): this {
    for (let i = 0; i < h; i++) {
      const half = (w * (h - i)) / (2 * h)
      this.span(cx - half, cx + half, y + i, color)
    }
    return this
  }

  /** Upward taper: a point at the top widening to `w` at the bottom. */
  cone(cx: number, y: number, w: number, h: number, color: string): this {
    for (let i = 0; i < h; i++) {
      const half = (w * (i + 1)) / (2 * h)
      this.span(cx - half, cx + half, y + i, color)
    }
    return this
  }

  /**
   * Straight line, stepped along whichever axis it travels furthest on and
   * thickened across the other one. Walking the major axis a pixel at a time
   * puts exactly one run per column (or row), so the staircase is the evenly
   * distributed one; stamping a `thick`-sized square at sampled points instead
   * piles overlapping blocks into a lumpy edge.
   *
   * `thick` is measured perpendicular to the line, so a slanted stroke is not
   * thinner than the same stroke drawn straight.
   */
  line(ax: number, ay: number, bx: number, by: number, color: string, thick = 1): this {
    // Snap the endpoints before interpolating. A line that starts on a half
    // pixel makes every sample land on a rounding tie, which shunts the whole
    // staircase one way and dumps all of the step at one end of the run.
    const x0 = Math.round(ax)
    const y0 = Math.round(ay)
    const dx = Math.round(bx) - x0
    const dy = Math.round(by) - y0
    const major = Math.max(Math.abs(dx), Math.abs(dy))
    if (major < 1) {
      this.px(x0 - (thick - 1) / 2, y0 - (thick - 1) / 2, thick, thick, color)
      return this
    }
    this.ctx.fillStyle = color
    // Cross-section along the stepping axis is the perpendicular width divided
    // by the cosine of the line's slope.
    const span = Math.max(1, Math.round((thick * Math.hypot(dx, dy)) / major))
    // Offset the band by a whole pixel rather than centring it on a fraction:
    // folding a half-pixel into the rounding turns every sample into a tie and
    // collapses the staircase to a single step at the end of the run.
    const off = (span - 1) >> 1
    // Divide last. `d * (i / major)` rounds a half-step to the wrong side when
    // `i / major` is not exactly representable, which drops a single step out
    // of an otherwise even staircase and puts a visible kink in the line.
    for (let i = 0; i <= major; i++) {
      const sx = Math.round((dx * i) / major)
      const sy = Math.round((dy * i) / major)
      if (Math.abs(dx) >= Math.abs(dy)) this.ctx.fillRect(x0 + sx, y0 + sy - off, 1, span)
      else this.ctx.fillRect(x0 + sx - off, y0 + sy, span, 1)
    }
    return this
  }

  /**
   * Fills the union of an ellipse swept along a path, resolved one column at a
   * time. Stamping the individual ellipses leaves a scalloped silhouette —
   * each one rounds its own extremes, so the outline bulges a pixel at every
   * stamp and the edge reads as wavy. Taking the envelope first and rounding
   * once per column turns the boundary back into a smooth ramp that steps
   * evenly.
   */
  sweep(
    path: (t: number) => { x: number; y: number; rx: number; ry: number },
    color: string,
    samples = 64,
  ): this {
    const pts = []
    for (let i = 0; i <= samples; i++) pts.push(path(i / samples))
    let lo = Infinity
    let hi = -Infinity
    for (const p of pts) {
      lo = Math.min(lo, p.x - p.rx)
      hi = Math.max(hi, p.x + p.rx)
    }
    if (!(hi > lo)) return this
    this.ctx.fillStyle = color
    for (let x = Math.round(lo); x < Math.round(hi); x++) {
      const xc = x + 0.5
      let top = Infinity
      let bot = -Infinity
      for (const p of pts) {
        const u = (xc - p.x) / p.rx
        if (u * u > 1) continue
        const dy = p.ry * Math.sqrt(1 - u * u)
        top = Math.min(top, p.y - dy)
        bot = Math.max(bot, p.y + dy)
      }
      if (top > bot) continue
      const y0 = Math.round(top)
      this.ctx.fillRect(x, y0, 1, Math.max(1, Math.round(bot) - y0))
    }
    return this
  }

  clear(): this {
    this.ctx.clearRect(0, 0, this.w, this.h)
    return this
  }

  /**
   * Wraps the opaque silhouette in a 1px dark border. This single pass is what
   * makes procedural shapes read as deliberate sprites rather than blobs.
   */
  outline(color = '#0a0b11'): this {
    const img = this.ctx.getImageData(0, 0, this.w, this.h)
    const d = img.data
    const w = this.w
    const h = this.h
    const solid = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) solid[i] = d[i * 4 + 3]! > 8 ? 1 : 0
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (solid[i]) continue
        const near =
          (x > 0 && solid[i - 1]) ||
          (x < w - 1 && solid[i + 1]) ||
          (y > 0 && solid[i - w]) ||
          (y < h - 1 && solid[i + w])
        if (!near) continue
        const o = i * 4
        d[o] = r
        d[o + 1] = g
        d[o + 2] = b
        d[o + 3] = 255
      }
    }
    this.ctx.putImageData(img, 0, 0)
    return this
  }

  /** Multiply every opaque pixel toward a colour — used for elite recolours. */
  tint(color: string, amount: number): this {
    const img = this.ctx.getImageData(0, 0, this.w, this.h)
    const d = img.data
    const tr = parseInt(color.slice(1, 3), 16)
    const tg = parseInt(color.slice(3, 5), 16)
    const tb = parseInt(color.slice(5, 7), 16)
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue
      d[i] = d[i]! + (tr - d[i]!) * amount
      d[i + 1] = d[i + 1]! + (tg - d[i + 1]!) * amount
      d[i + 2] = d[i + 2]! + (tb - d[i + 2]!) * amount
    }
    this.ctx.putImageData(img, 0, 0)
    return this
  }

  toURL(): string {
    return this.cv.toDataURL()
  }
}

/** A sprite sheet laid out as rows = facing, cols = animation frame. */
export interface Sheet {
  cv: CanvasImageSource
  fw: number
  fh: number
  cols: number
  rows: number
  /** Distance from the top of a frame to the character's ground contact point. */
  anchorY: number
  /**
   * True when all 8 rows were drawn at their own angle.
   *
   * A sheet without this holds one side view repeated, so the caller must pick
   * its row from the heading rather than from the facing octant. See
   * `Renderer.drawEnemy`.
   */
  directional: boolean
}

/**
 * Builds a sheet by calling `draw` for every (row, col). Each cell is rendered
 * into its own scratch canvas so the outline pass can't bleed across frames.
 */
export function buildSheet(
  fw: number,
  fh: number,
  rows: number,
  cols: number,
  anchorY: number,
  draw: (c: PixelCanvas, row: number, col: number) => void,
  outlineColor: string | null = '#0a0b11',
): Sheet {
  const sheet = document.createElement('canvas')
  sheet.width = fw * cols
  sheet.height = fh * rows
  const sctx = sheet.getContext('2d')!
  sctx.imageSmoothingEnabled = false
  const cell = new PixelCanvas(fw, fh)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cell.clear()
      draw(cell, r, c)
      if (outlineColor) cell.outline(outlineColor)
      sctx.drawImage(cell.cv, c * fw, r * fh)
    }
  }
  return { cv: sheet, fw, fh, cols, rows, anchorY, directional: true }
}

/** Mixes two hex colours; t=0 returns a, t=1 returns b. */
export function mix(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16)
  const ag = parseInt(a.slice(3, 5), 16)
  const ab = parseInt(a.slice(5, 7), 16)
  const br = parseInt(b.slice(1, 3), 16)
  const bg = parseInt(b.slice(3, 5), 16)
  const bb = parseInt(b.slice(5, 7), 16)
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${h(ar + (br - ar) * t)}${h(ag + (bg - ag) * t)}${h(ab + (bb - ab) * t)}`
}
