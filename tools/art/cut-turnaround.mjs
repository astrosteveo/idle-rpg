/**
 * Cuts a 2x4 turnaround into one reference image per facing.
 *
 * Step 2 of the character pipeline. See tools/art/README.md.
 *
 *   node tools/art/cut-turnaround.mjs <turnaround.png> <outDir>
 *
 * Writes ref-S.png, ref-SE.png ... one for each facing, on the magenta ground
 * the image model generates against, so each one can go straight back in as the
 * reference for that facing's frame strip.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { blank, readPng, writePng } from '../lib/png.mjs'
import { alphaMask, components, intoRows } from '../lib/segment.mjs'

const [src, outDir] = process.argv.slice(2)
if (!src || !outDir) {
  console.error('usage: node tools/art/cut-turnaround.mjs <turnaround.png> <outDir>')
  process.exit(1)
}
/** The order the turnaround prompt asks for, reading left to right, top row first. */
const READING_ORDER = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW']

mkdirSync(outDir, { recursive: true })

const image = readPng(src)
const mask = alphaMask(image)
const rows = intoRows(components(mask, image.width, image.height, 6, 800), image.height / 4)
const cells = rows.flat()
console.log(`${src}: ${image.width}x${image.height}, rows ${rows.map((r) => r.length).join(',')}`)
if (cells.length !== 8) throw new Error(`expected 8 cells, found ${cells.length}`)

cells.forEach((b, i) => {
  const pad = 12
  const out = blank(b.w + pad * 2, b.h + pad * 2)
  // Magenta ground so the model sees a clean key, same as it generates with.
  for (let j = 0; j < out.width * out.height; j++) {
    out.data[j * 4] = 255
    out.data[j * 4 + 1] = 0
    out.data[j * 4 + 2] = 255
    out.data[j * 4 + 3] = 255
  }
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const s = ((b.y + y) * image.width + (b.x + x)) * 4
      if (image.data[s + 3] <= 16) continue
      image.data.copy(out.data, ((y + pad) * out.width + (x + pad)) * 4, s, s + 4)
    }
  }
  const file = resolve(outDir, `ref-${READING_ORDER[i]}.png`)
  writePng(file, out)
  console.log(`  ${READING_ORDER[i].padEnd(2)} ${b.w}x${b.h} -> ${file}`)
})
