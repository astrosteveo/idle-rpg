/**
 * Measures the real frame rectangles in each generated atlas and writes
 * src/assets/frames.ts.
 *
 * The atlases come out of an image model. Their sprites do not sit on a grid
 * that divides evenly, and no prompt makes them. Dividing the image by a row
 * and column count therefore reads each frame at the wrong place, and the error
 * grows across the sheet. This tool finds each sprite instead, by its own
 * pixels, and records where it truly is.
 *
 * Run it again after any atlas changes:  npm run atlas:measure
 */
import { inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `radius` joins the parts of one sprite (a sword tip, a lifted paw) without
 * bridging to its neighbour. Raise it and rows merge; lower it and a sprite
 * splits in two. The row and column counts are asserted, so a regenerated
 * atlas that changed shape fails here instead of rendering wrongly.
 *
 * `clips` groups the columns that belong to one animation. The layout pitch is
 * fitted inside a clip and nowhere else, because a sheet lays its clips out
 * differently and one fit across the whole row splits the difference, which
 * reads as a steady drift and slides the body across the ground.
 *
 * Characters are not measured here. `build-character-atlas.mjs` composes them
 * onto a grid it chooses, so their geometry is known exactly and lives in
 * `CHARACTER_SHEETS`.
 */
const ATLASES = [
  {
    id: 'enemies',
    src: 'public/assets/generated/enemy-atlas.png',
    radius: 7,
    rows: 5,
    cols: 6,
    clips: [[0, 2], [2, 4], [4, 6]], // ordinary, elite, apex — each idle then attack
  },
  {
    id: 'support',
    src: 'public/assets/generated/support-atlas.png',
    radius: 7,
    cols: [6, 7, 6, 5, 9],
    // Props and icons are unrelated to each other, so each one is its own clip.
    clips: null,
  },
]

const ALPHA = 16
const MIN_AREA = 400
/** Two sprite centres closer than this on the y axis belong to the same row. */
const ROW_TOLERANCE = 90
/**
 * A scanline this wide, as a part of the frame width, is a boot and not the tip
 * of a blade. The lowest such line is where the figure meets the ground.
 */
const SOLE_WIDTH = 0.08

// ---------------------------------------------------------------- png decode

/** Minimal reader for the one format the atlases use: 8-bit RGBA, no interlace. */
function decodePng(file) {
  const buf = readFileSync(file)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG.`)
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const depth = buf[24]
  const colour = buf[25]
  const interlace = buf[28]
  if (depth !== 8 || colour !== 6 || interlace !== 0) {
    throw new Error(`${file}: expected 8-bit RGBA without interlace, got depth ${depth} colour ${colour}.`)
  }

  const parts = []
  for (let at = 8; at + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(at)
    const type = buf.toString('ascii', at + 4, at + 8)
    if (type === 'IDAT') parts.push(buf.subarray(at + 8, at + 8 + length))
    at += length + 12
    if (type === 'IEND') break
  }
  const raw = inflateSync(Buffer.concat(parts))

  // Undo the per-scanline filter. Each byte is predicted from its left (a),
  // upper (b) and upper-left (c) neighbour, four bytes to a pixel.
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]
      const a = i >= bpp ? out[dst + i - bpp] : 0
      const b = y > 0 ? out[up + i] : 0
      const c = y > 0 && i >= bpp ? out[up + i - bpp] : 0
      let value
      switch (filter) {
        case 0: value = x; break
        case 1: value = x + a; break
        case 2: value = x + b; break
        case 3: value = x + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`${file}: unknown scanline filter ${filter}.`)
      }
      out[dst + i] = value & 0xff
    }
  }
  return { width, height, data: out }
}

// ------------------------------------------------------------- segmentation

function alphaMask({ width, height, data }) {
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > ALPHA ? 1 : 0
  return mask
}

/** Grows the mask by `radius`, so one sprite becomes one blob. */
function dilate(mask, width, height, radius) {
  let src = mask
  for (let pass = 0; pass < radius; pass++) {
    const dst = new Uint8Array(src.length)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (
          src[i] ||
          (x > 0 && src[i - 1]) ||
          (x < width - 1 && src[i + 1]) ||
          (y > 0 && src[i - width]) ||
          (y < height - 1 && src[i + width])
        ) {
          dst[i] = 1
        }
      }
    }
    src = dst
  }
  return src
}

/** One box per blob, tight around the blob's *original* pixels. */
function components(mask, width, height, radius) {
  const blob = dilate(mask, width, height, radius)
  const seen = new Uint8Array(blob.length)
  const queue = new Int32Array(blob.length)
  const boxes = []
  for (let start = 0; start < blob.length; start++) {
    if (!blob[start] || seen[start]) continue
    let head = 0
    let tail = 0
    queue[tail++] = start
    seen[start] = 1
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    let area = 0
    while (head < tail) {
      const i = queue[head++]
      const x = i % width
      const y = (i - x) / width
      if (mask[i]) {
        area++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      if (x > 0 && blob[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; queue[tail++] = i - 1 }
      if (x < width - 1 && blob[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; queue[tail++] = i + 1 }
      if (y > 0 && blob[i - width] && !seen[i - width]) { seen[i - width] = 1; queue[tail++] = i - width }
      if (y < height - 1 && blob[i + width] && !seen[i + width]) { seen[i + width] = 1; queue[tail++] = i + width }
    }
    if (area >= MIN_AREA) boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 })
  }
  return boxes
}

function intoRows(boxes) {
  const sorted = [...boxes].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))
  const rows = []
  let current = []
  for (const box of sorted) {
    const centre = box.y + box.h / 2
    if (current.length && centre - (current[0].y + current[0].h / 2) > ROW_TOLERANCE) {
      rows.push(current.sort((a, b) => a.x - b.x))
      current = []
    }
    current.push(box)
  }
  if (current.length) rows.push(current.sort((a, b) => a.x - b.x))
  return rows
}

// ------------------------------------------------------------------ fitting

/** Least-squares line through (i, value) pairs. */
function fitLine(values) {
  const n = values.length
  if (n < 2) return { a: values[0] ?? 0, b: 0 }
  const mx = (n - 1) / 2
  const my = values.reduce((s, v) => s + v, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (values[i] - my)
    den += (i - mx) ** 2
  }
  const b = den ? num / den : 0
  return { a: my - b * mx, b }
}

/**
 * Where the figure in a frame stands, as an absolute y in the atlas.
 *
 * The lowest pixel is not reliable. A sword can hang below a boot, and then the
 * frame would sit on the point of its blade. So the sole is the lowest
 * scanline that is wide enough to be a foot.
 */
function soleOf(mask, width, box) {
  const need = Math.max(3, Math.round(box.w * SOLE_WIDTH))
  for (let y = box.y + box.h - 1; y >= box.y; y--) {
    let n = 0
    for (let x = box.x; x < box.x + box.w; x++) if (mask[y * width + x]) n++
    if (n >= need) return y
  }
  return box.y + box.h - 1
}

/**
 * Places every frame of a row on the line its own feet rest on.
 *
 * `oy` runs from the top of the frame down to its own sole. Thus every frame
 * stands on the line, in every pose and in every facing.
 *
 * An earlier rule took one line for the whole row, from the lowest point
 * anything in it reached. A swing that was drawn three pixels higher than the
 * rest then decided where a standing figure's feet went, and the figure hovered
 * — by a different amount in each facing, so it bobbed as the player turned.
 *
 * `ox` is what is left of the frame's centre once the layout pitch is removed.
 * The pitch is fitted rather than assumed, because it is not constant — a
 * measured strip of four frames ran 483, 486, 486 px where an even division
 * would have used 494. What remains after the fit is movement inside the clip,
 * and nothing else.
 */
function place(row, clips, soles) {
  const spans = clips ?? row.map((_, i) => [i, i + 1])
  const out = []
  for (const [from, to] of spans) {
    const clip = row.slice(from, to)
    const { a, b } = fitLine(clip.map((c) => c.x + c.w / 2))
    clip.forEach((c, i) => {
      const col = from + i
      out[col] = {
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        ox: round2(c.x + c.w / 2 - (a + b * i)),
        oy: soles[col] - c.y,
      }
    })
  }
  if (out.length !== row.length || out.some((f) => !f)) {
    throw new Error(`clips do not cover all ${row.length} columns.`)
  }
  return out
}

const round2 = (v) => Math.round(v * 100) / 100

// -------------------------------------------------------------------- build

function measure(spec) {
  const image = decodePng(resolve(ROOT, spec.src))
  const mask = alphaMask(image)
  let boxes = components(mask, image.width, image.height, spec.radius)

  const extras = {}
  for (const extra of spec.extras ?? []) {
    const index = boxes.findIndex((b) => b.x >= extra.minX)
    if (index < 0) throw new Error(`${spec.id}: no sprite found for extra "${extra.name}".`)
    const [box] = boxes.splice(index, 1)
    extras[extra.name] = box
  }

  const rows = intoRows(boxes)
  const expected = spec.cols ?? []
  const wanted = Array.isArray(expected) ? expected : Array(spec.rows).fill(expected)
  if (rows.length !== wanted.length) {
    throw new Error(`${spec.id}: found ${rows.length} rows, expected ${wanted.length}.`)
  }
  rows.forEach((row, i) => {
    if (row.length !== wanted[i]) {
      throw new Error(`${spec.id}: row ${i} has ${row.length} frames, expected ${wanted[i]}.`)
    }
  })

  const placed = rows.map((row) => {
    const soles = row.map((box) => soleOf(mask, image.width, box))
    return place(row, spec.clips, soles)
  })
  const flat = placed.flat()
  return {
    unitW: Math.ceil(Math.max(...flat.map((f) => f.w + 2 * Math.abs(f.ox)))),
    // How far the tallest frame reaches above the baseline, and how far the
    // deepest one hangs below it. A cell is built from the two together.
    unitAbove: Math.max(...flat.map((f) => f.oy)),
    unitBelow: Math.max(0, ...flat.map((f) => f.h - 1 - f.oy)),
    rows: placed,
    extras,
  }
}

const frame = (f) => `{ x: ${f.x}, y: ${f.y}, w: ${f.w}, h: ${f.h}, ox: ${f.ox}, oy: ${f.oy} }`
const box = (b) => `{ x: ${b.x}, y: ${b.y}, w: ${b.w}, h: ${b.h} }`

const layouts = ATLASES.map((spec) => {
  const m = measure(spec)
  console.log(
    `${spec.id.padEnd(8)} unit w${m.unitW} above ${m.unitAbove} below ${m.unitBelow}  rows ${m.rows.map((r) => r.length).join(',')}` +
      `${Object.keys(m.extras).length ? `  extras ${Object.keys(m.extras).join(',')}` : ''}`,
  )
  const rows = m.rows
    .map((row) => `      [\n${row.map((f) => `        ${frame(f)},`).join('\n')}\n      ],`)
    .join('\n')
  const extras = Object.entries(m.extras)
    .map(([name, b]) => `      ${name}: ${box(b)},`)
    .join('\n')
  return (
    `  ${spec.id}: {\n` +
    `    unitW: ${m.unitW},\n` +
    `    unitAbove: ${m.unitAbove},\n` +
    `    unitBelow: ${m.unitBelow},\n` +
    `    rows: [\n${rows}\n    ],\n` +
    (extras ? `    extras: {\n${extras}\n    },\n` : `    extras: {},\n`) +
    `  },`
  )
})

const source = `/**
 * GENERATED FILE. Do not edit by hand.
 *
 * Written by tools/measure-atlas.mjs from the atlases in public/assets/generated.
 * Run \`npm run atlas:measure\` after any atlas changes.
 *
 * Each frame is the sprite's true rectangle in its atlas, with two offsets that
 * say where it belongs inside a cell. See the tool for what they mean.
 */
import type { AtlasFrames } from './types'

export const ATLAS_FRAMES: AtlasFrames = {
${layouts.join('\n')}
}
`

const out = resolve(ROOT, 'src/assets/frames.ts')
writeFileSync(out, source)
console.log(`wrote ${out}`)
