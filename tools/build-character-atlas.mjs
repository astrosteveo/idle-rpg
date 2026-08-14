/**
 * Builds a character atlas from one strip of frames per facing.
 *
 * An image model draws one strip at a time. This tool finds the frames in each
 * strip, puts them all on one scale and one baseline, and lays them out as
 * 8 rows of frames — one row for each facing, in the order `facingToDir`
 * numbers them. Nothing is mirrored, so a figure that carries a sword in its
 * right hand still does after it turns.
 *
 * It composes at the size the game draws at, so the runtime blits the result
 * one to one. The art was being drawn at about twice the render size and
 * resampled every frame, which threw away half of the detail on the way.
 *
 * Usage:
 *   node tools/build-character-atlas.mjs <spec.json>
 *
 * The spec names the output, the standing height in art pixels, and the strip
 * for each facing:
 *   {
 *     "out": "public/assets/generated/warrior-atlas-8dir.png",
 *     "standingHeight": 63,
 *     "columns": 7,
 *     "strips": { "S": "art/warrior-s.png", "W": "...", ... }
 *   }
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blank, readPng, writePng } from './lib/png.mjs'
import { alphaMask, fitLine, soleOf } from './lib/segment.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Row order is the order `facingToDir` returns, and it must stay that way. */
export const FACING_ORDER = ['S', 'W', 'E', 'N', 'SE', 'SW', 'NE', 'NW']

/**
 * Splits a strip into frames on the empty columns between them.
 *
 * Connected components is the wrong tool here. A raised sword or a shield held
 * away from the body is its own island of pixels, so it came out as an extra
 * frame and pushed every later frame one place along. A strip is one row of
 * figures with clear air between them, and that air is what separates them.
 */
function splitStrip(image, mask, expected) {
  const occupancy = new Int32Array(image.width)
  for (let x = 0; x < image.width; x++) {
    let n = 0
    for (let y = 0; y < image.height; y++) if (mask[y * image.width + x]) n++
    occupancy[x] = n
  }

  // The frames are drawn at an even pitch, so look for each seam near where it
  // is due and take the emptiest column there. Requiring a wholly empty column
  // is too strict — a sword often reaches into the next frame — and taking the
  // widest gaps anywhere is too loose, because the space inside a stride reads
  // as a gap too.
  let first = 0
  let last = image.width - 1
  while (first < image.width && occupancy[first] === 0) first++
  while (last > first && occupancy[last] === 0) last--
  const pitch = (last - first + 1) / expected
  const cuts = []
  for (let i = 1; i < expected; i++) {
    const centre = first + i * pitch
    const from = Math.max(first + 1, Math.round(centre - pitch * 0.35))
    const to = Math.min(last, Math.round(centre + pitch * 0.35))
    let bestAt = Math.round(centre)
    let best = Infinity
    for (let x = from; x <= to; x++) {
      // Ties go to the column nearest the expected seam.
      const score = occupancy[x] * 1000 + Math.abs(x - centre)
      if (score < best) {
        best = score
        bestAt = x
      }
    }
    cuts.push(bestAt)
  }

  const boxes = []
  const edges = [0, ...cuts, image.width]
  for (let i = 0; i < edges.length - 1; i++) {
    let x0 = image.width
    let y0 = image.height
    let x1 = -1
    let y1 = -1
    for (let x = Math.floor(edges[i]); x < Math.ceil(edges[i + 1]); x++) {
      for (let y = 0; y < image.height; y++) {
        if (!mask[y * image.width + x]) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    if (x1 >= x0 && y1 >= y0) boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 })
  }
  return boxes
}

function framesIn(file, expected) {
  const image = readPng(resolve(ROOT, file))
  const mask = alphaMask(image)
  const boxes = splitStrip(image, mask, expected)
  if (boxes.length > expected) {
    throw new Error(`${file}: found ${boxes.length} frames, expected ${expected}.`)
  }
  if (boxes.length < expected) {
    // An image model sometimes draws one frame fewer than it was asked for.
    // Hold the last pose rather than fail, and say so, because a strip that is
    // quietly short would look like a complete animation that stutters.
    console.warn(
      `  ! ${file}: only ${boxes.length} of ${expected} frames were drawn; holding the last pose for the rest.`,
    )
    while (boxes.length < expected) boxes.push(boxes[boxes.length - 1])
  }
  return {
    image,
    boxes: boxes.map((box) => ({ ...box, sole: soleOf(mask, image.width, box) })),
  }
}

/**
 * Area-average resample of one frame into the destination.
 *
 * A model draws these strips several times larger than the game renders them,
 * so this is a heavy reduction — around seven to one. Picking one source pixel
 * per destination pixel would throw away fifty of every fifty-one and leave a
 * sprite that crawls. Averaging the whole source cell keeps the shape.
 *
 * Colour is averaged with alpha as the weight. Averaging it flat would drag the
 * transparent black outside the silhouette into every edge and leave a dark
 * fringe around the figure.
 */
function blit(dst, src, box, dx, dy, dw, dh) {
  for (let y = 0; y < dh; y++) {
    const sy0 = box.y + Math.floor((y * box.h) / dh)
    const sy1 = Math.max(sy0 + 1, box.y + Math.floor(((y + 1) * box.h) / dh))
    for (let x = 0; x < dw; x++) {
      const sx0 = box.x + Math.floor((x * box.w) / dw)
      const sx1 = Math.max(sx0 + 1, box.x + Math.floor(((x + 1) * box.w) / dw))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const s = (sy * src.width + sx) * 4
          const alpha = src.data[s + 3]
          r += src.data[s] * alpha
          g += src.data[s + 1] * alpha
          b += src.data[s + 2] * alpha
          a += alpha
          n++
        }
      }
      if (!n || a === 0) continue
      const tx = dx + x
      const ty = dy + y
      if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue
      const t = (ty * dst.width + tx) * 4
      dst.data[t] = Math.round(r / a)
      dst.data[t + 1] = Math.round(g / a)
      dst.data[t + 2] = Math.round(b / a)
      // A sprite wants a hard silhouette, so the coverage becomes opaque or
      // nothing rather than a soft rim.
      dst.data[t + 3] = a / n >= 110 ? 255 : 0
    }
  }
}

function build(spec) {
  const columns = spec.columns
  const strips = FACING_ORDER.map((facing) => {
    const file = spec.strips[facing]
    if (!file) throw new Error(`spec has no strip for facing ${facing}.`)
    return { facing, ...framesIn(file, columns) }
  })

  // A scale for each facing, not one for the whole character. The model draws
  // each strip on its own, so it picks its own size: a wolf seen head-on came
  // out twice the size of the same wolf seen from the side. Normalising each
  // facing to the same standing height is what makes the animal keep its size
  // as it turns.
  for (const strip of strips) {
    const tallest = Math.max(...strip.boxes.map((b) => b.sole - b.y + 1))
    strip.scale = spec.standingHeight / tallest
  }

  const below = Math.max(
    0,
    ...strips.flatMap((s) => s.boxes.map((b) => Math.round((b.y + b.h - 1 - b.sole) * s.scale))),
  )
  const widest = Math.max(...strips.flatMap((s) => s.boxes.map((b) => Math.round(b.w * s.scale))))
  // Room for the sway the pitch fit leaves behind, either way round.
  const sway = Math.max(
    ...strips.map((s) => {
      const { a, b } = fitLine(s.boxes.map((f) => f.x + f.w / 2))
      return Math.max(...s.boxes.map((f, i) => Math.abs(f.x + f.w / 2 - (a + b * i)) * s.scale))
    }),
  )
  const cellW = Math.ceil((widest + 2 * sway) / 2) * 2
  const cellH = spec.standingHeight + below + 1
  const anchorY = spec.standingHeight

  const out = blank(cellW * columns, cellH * FACING_ORDER.length)
  strips.forEach((strip, row) => {
    const { a, b } = fitLine(strip.boxes.map((f) => f.x + f.w / 2))
    const scale = strip.scale
    strip.boxes.forEach((box, col) => {
      const ox = box.x + box.w / 2 - (a + b * col)
      // Round each edge on its own and take the size from the difference, so
      // the sole lands on the same line in every frame.
      const centreX = cellW / 2 + ox * scale
      const left = Math.round(centreX - (box.w * scale) / 2)
      const right = Math.round(centreX + (box.w * scale) / 2)
      const top = anchorY - Math.round((box.sole - box.y) * scale)
      const bottom = anchorY + Math.round((box.y + box.h - 1 - box.sole) * scale)
      blit(
        out, strip.image, box,
        col * cellW + left, row * cellH + top,
        Math.max(1, right - left), Math.max(1, bottom - top + 1),
      )
    })
  })

  writePng(resolve(ROOT, spec.out), out)
  console.log(
    `${spec.out}  cell ${cellW}x${cellH}  ${FACING_ORDER.length} facings x ${columns} frames  anchorY ${anchorY}`,
  )
  console.log(
    `  scale per facing: ${strips.map((s) => `${s.facing} ${s.scale.toFixed(3)}`).join('  ')}`,
  )
}

const specPath = process.argv[2]
if (!specPath) {
  console.error('usage: node tools/build-character-atlas.mjs <spec.json>')
  process.exit(1)
}
build(JSON.parse(readFileSync(resolve(ROOT, specPath), 'utf8')))
