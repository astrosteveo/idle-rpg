/**
 * A 5x7 bitmap font. The world is drawn into a low-resolution buffer that gets
 * upscaled with nearest-neighbour, so canvas `fillText` would come out blurry.
 * Damage numbers and nameplates are stamped from these glyphs instead.
 */

const GLYPHS: Record<string, string> = {
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#',
  B: '####./#...#/#...#/####./#...#/#...#/####.',
  C: '.####/#..../#..../#..../#..../#..../.####',
  D: '####./#...#/#...#/#...#/#...#/#...#/####.',
  E: '#####/#..../#..../####./#..../#..../#####',
  F: '#####/#..../#..../####./#..../#..../#....',
  G: '.####/#..../#..../#..##/#...#/#...#/.####',
  H: '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '.###./..#../..#../..#../..#../..#../.###.',
  J: '..###/...#./...#./...#./...#./#..#./.##..',
  K: '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#...#/#...#/#...#/#...#',
  N: '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#',
  O: '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  P: '####./#...#/#...#/####./#..../#..../#....',
  Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.',
  T: '#####/..#../..#../..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..',
  Z: '#####/....#/...#./..#../.#.../#..../#####',
  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  '1': '..#../.##../..#../..#../..#../..#../.###.',
  '2': '.###./#...#/....#/...#./..#../.#.../#####',
  '3': '####./....#/....#/.###./....#/....#/####.',
  '4': '...#./..##./.#.#./#..#./#####/...#./...#.',
  '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '.###./#..../#..../####./#...#/#...#/.###.',
  '7': '#####/....#/...#./..#../.#.../.#.../.#...',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###.',
  '9': '.###./#...#/#...#/.####/....#/....#/.###.',
  ' ': '...../...../...../...../...../...../.....',
  '-': '...../...../...../.###./...../...../.....',
  '+': '...../..#../..#../.###./..#../..#../.....',
  '.': '...../...../...../...../...../.##../.##..',
  ',': '...../...../...../...../.##../.##../.#...',
  ':': '...../.##../.##../...../.##../.##../.....',
  '!': '..#../..#../..#../..#../..#../...../..#..',
  "'": '..#../..#../...../...../...../...../.....',
  '/': '....#/...#./...#./..#../.#.../.#.../#....',
  '%': '##..#/##..#/...#./..#../.#.../#..##/#..##',
  '(': '...#./..#../.#.../.#.../.#.../..#../...#.',
  ')': '.#.../..#../...#./...#./...#./..#../.#...',
  '*': '...../#.#.#/.###./#####/.###./#.#.#/.....',
  '?': '.###./#...#/....#/..##./..#../...../..#..',
  '<': '...#./..#../.#.../#..../.#.../..#../...#.',
  '>': '.#.../..#../...#./....#/...#./..#../.#...',
}

export const GLYPH_W = 5
export const GLYPH_H = 7
const TRACK = 1

interface Glyph {
  cols: number[]
}

const parsed = new Map<string, Glyph>()
for (const [ch, art] of Object.entries(GLYPHS)) {
  const rows = art.split('/')
  const cols: number[] = new Array(GLYPH_W).fill(0)
  rows.forEach((row, y) => {
    for (let x = 0; x < GLYPH_W; x++) {
      if (row[x] === '#') cols[x]! |= 1 << y
    }
  })
  parsed.set(ch, { cols })
}

export function textWidth(text: string, scale = 1): number {
  return (text.length * (GLYPH_W + TRACK) - TRACK) * scale
}

/** Stamps text a pixel at a time. Everything is integer-aligned. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  scale = 1,
) {
  ctx.fillStyle = color
  const s = scale
  let cx = Math.round(x)
  const cy = Math.round(y)
  for (const raw of text) {
    const g = parsed.get(raw.toUpperCase())
    if (g) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        const bits = g.cols[gx]!
        if (!bits) continue
        let run = -1
        for (let gy = 0; gy <= GLYPH_H; gy++) {
          const on = gy < GLYPH_H && (bits & (1 << gy)) !== 0
          if (on && run < 0) run = gy
          else if (!on && run >= 0) {
            // Draw each vertical run as one rect instead of per-pixel.
            ctx.fillRect(cx + gx * s, cy + run * s, s, (gy - run) * s)
            run = -1
          }
        }
      }
    }
    cx += (GLYPH_W + TRACK) * s
  }
}

/** Text with a 1px dark halo so it stays legible over any terrain. */
export function drawTextShadow(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  scale = 1,
  shadow = '#0a0b11',
) {
  const s = scale
  drawText(ctx, text, x - s, y, shadow, s)
  drawText(ctx, text, x + s, y, shadow, s)
  drawText(ctx, text, x, y - s, shadow, s)
  drawText(ctx, text, x, y + s, shadow, s)
  drawText(ctx, text, x, y, color, s)
}

export function drawTextCentered(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  color: string,
  scale = 1,
) {
  drawTextShadow(ctx, text, Math.round(cx - textWidth(text, scale) / 2), y, color, scale)
}
