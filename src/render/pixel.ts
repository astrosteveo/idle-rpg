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

  /** Filled rect, rounded to whole pixels. */
  px(x: number, y: number, w: number, h: number, color: string): this {
    if (w <= 0 || h <= 0) return this
    this.ctx.fillStyle = color
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
    return this
  }

  dot(x: number, y: number, color: string): this {
    return this.px(x, y, 1, 1, color)
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

  /** Right triangle-ish wedge, used for ears, fangs, spikes. */
  wedge(x: number, y: number, w: number, h: number, color: string, flip = false): this {
    for (let i = 0; i < h; i++) {
      const rowW = Math.max(1, Math.round(w * (1 - i / h)))
      this.px(flip ? x + w - rowW : x, y + i, rowW, 1, color)
    }
    return this
  }

  /** Downward taper: full width at the top, a point at the bottom. */
  spike(cx: number, y: number, w: number, h: number, color: string): this {
    for (let i = 0; i < h; i++) {
      const rowW = Math.max(1, Math.round(w * (1 - i / h)))
      this.px(cx - rowW / 2, y + i, rowW, 1, color)
    }
    return this
  }

  /** Upward taper: a point at the top widening to `w` at the bottom. */
  cone(cx: number, y: number, w: number, h: number, color: string): this {
    for (let i = 0; i < h; i++) {
      const rowW = Math.max(1, Math.round((w * (i + 1)) / h))
      this.px(cx - rowW / 2, y + i, rowW, 1, color)
    }
    return this
  }

  line(x0: number, y0: number, x1: number, y1: number, color: string, thick = 1): this {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps
      this.px(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thick, thick, color)
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
    for (let i = 0; i < w * h; i++) solid[i] = d[i * 4 + 3] > 8 ? 1 : 0
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
      d[i] += (tr - d[i]) * amount
      d[i + 1] += (tg - d[i + 1]) * amount
      d[i + 2] += (tb - d[i + 2]) * amount
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
  cv: HTMLCanvasElement
  fw: number
  fh: number
  cols: number
  rows: number
  /** Distance from the top of a frame to the character's ground contact point. */
  anchorY: number
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
  return { cv: sheet, fw, fh, cols, rows, anchorY }
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
