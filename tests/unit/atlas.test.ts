import { describe, expect, it } from 'vitest'
import { ATLAS_FRAMES } from '../../src/assets/frames'
import {
  ASSET_MANIFEST,
  CHARACTER_SHEETS,
  FACING_ROWS,
  type AtlasFrame,
  type AtlasLayout,
} from '../../src/assets/types'

const SIZES = new Map(ASSET_MANIFEST.map((a) => [a.id, { w: a.width, h: a.height }]))

const layouts: [keyof typeof ATLAS_FRAMES, AtlasLayout][] = [
  ['enemies', ATLAS_FRAMES.enemies],
  ['support', ATLAS_FRAMES.support],
]

const every = (layout: AtlasLayout): AtlasFrame[] => layout.rows.flat()

describe('atlas frame table', () => {
  it('matches the shape each atlas is drawn with', () => {
    expect(ATLAS_FRAMES.enemies.rows.map((r) => r.length)).toEqual([6, 6, 6, 6, 6])
    expect(ATLAS_FRAMES.support.rows.map((r) => r.length)).toEqual([6, 7, 6, 5, 9])
  })

  it.each(layouts)('keeps every %s frame inside its atlas', (id, layout) => {
    const size = SIZES.get(id)!
    expect(size).toBeDefined()
    for (const f of every(layout)) {
      expect(f.w).toBeGreaterThan(0)
      expect(f.h).toBeGreaterThan(0)
      expect(f.x).toBeGreaterThanOrEqual(0)
      expect(f.y).toBeGreaterThanOrEqual(0)
      expect(f.x + f.w).toBeLessThanOrEqual(size.w)
      expect(f.y + f.h).toBeLessThanOrEqual(size.h)
    }
  })

  it.each(layouts)('never lets two %s frames claim the same pixels', (_id, layout) => {
    const all = every(layout)
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!
        const b = all[j]!
        const overlaps =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlaps).toBe(false)
      }
    }
  })

  it.each(layouts)('sizes the %s reference box to hold every frame', (_id, layout) => {
    for (const f of every(layout)) {
      // A cell must fit the frame both ways round, because mirroring flips ox.
      expect(f.w + 2 * Math.abs(f.ox)).toBeLessThanOrEqual(layout.unitW)
      // oy runs from the top of the frame down to the line it stands on, so it
      // falls inside the frame and the cell has room above and below it.
      expect(f.oy).toBeGreaterThanOrEqual(0)
      expect(f.oy).toBeLessThan(f.h)
      expect(f.oy).toBeLessThanOrEqual(layout.unitAbove)
      expect(f.h - 1 - f.oy).toBeLessThanOrEqual(layout.unitBelow)
    }
  })

  it.each(layouts)('stands every %s frame on its own feet', (_id, layout) => {
    // oy is each frame's own sole, so no pose can hover. Almost nothing hangs
    // below the feet; a couple of pixels of sword tip is the most there is.
    for (const f of every(layout)) {
      expect(f.h - 1 - f.oy).toBeLessThanOrEqual(layout.unitBelow)
      expect(f.oy).toBeGreaterThan(f.h * 0.5)
    }
  })

  it('gives every composed character sheet 8 facings and a whole grid', () => {
    // A composed sheet is blitted a cell at a time with no measuring, so its
    // declared grid must be exactly the image. `preloadArt` checks the image
    // against these numbers at start-up; this checks they are self-consistent.
    for (const [id, def] of Object.entries(CHARACTER_SHEETS)) {
      expect(def.columns, id).toBeGreaterThan(0)
      expect(def.cellW, id).toBeGreaterThan(0)
      expect(def.cellH, id).toBeGreaterThan(0)
      // The feet sit inside the cell, with room for anything hanging below.
      expect(def.anchorY, id).toBeGreaterThan(0)
      expect(def.anchorY, id).toBeLessThan(def.cellH)
    }
    expect(FACING_ROWS).toBe(8)
  })

  it('gives the two ability icons room of their own', () => {
    // These are the widest icons in the row. Dividing the atlas by the column
    // count cut them and let each bleed into its neighbour's cell.
    const icons = ATLAS_FRAMES.support.rows[4]!
    expect(icons).toHaveLength(9)
    const whirlwind = icons[7]!
    const secondwind = icons[8]!
    expect(whirlwind.x + whirlwind.w).toBeLessThanOrEqual(secondwind.x)
  })
})
