/**
 * Terrain is baked into 8x8-tile chunks the first time they come into view and
 * kept in an LRU cache, so the per-frame cost is a handful of drawImage calls
 * no matter how detailed the ground is.
 *
 * Two things stop the 32px tile grid from showing through. Terrain *type* is
 * sampled every 8px rather than once per tile, so a shoreline or a snow line
 * follows the underlying noise. Terrain *shading* comes from world-space noise
 * evaluated every 4px, so it flows across tile borders instead of restarting
 * at each one.
 */
import { fbm, hash2 } from '../core/math'
import { T, TILE, type Tile, type World } from '../game/world'

export const CHUNK_TILES = 8
export const CHUNK_PX = CHUNK_TILES * TILE

/** Terrain type is resolved on this grid; shading on half of it. */
const TYPE_PX = 8
const SHADE_PX = 4

interface Palette {
  base: string
  alt: string
  dark: string
  light: string
  /** How many flecks of hand-placed grit to scatter per block. */
  detail: number
}

const PALETTES: Record<Tile, Palette> = {
  [T.Water]: { base: '#26405f', alt: '#2d4c70', dark: '#1c3049', light: '#3c6489', detail: 1 },
  [T.Shallow]: { base: '#3a6285', alt: '#457296', dark: '#2f5273', light: '#5b8bab', detail: 1 },
  [T.Sand]: { base: '#9a8c64', alt: '#a89a70', dark: '#857a56', light: '#b6a97f', detail: 1 },
  [T.Grass]: { base: '#456b3c', alt: '#4d7643', dark: '#3a5c33', light: '#568049', detail: 1 },
  [T.GrassLush]: { base: '#3a6134', alt: '#436e3b', dark: '#31532c', light: '#4c7a41', detail: 1 },
  [T.Meadow]: { base: '#5c7a3f', alt: '#688647', dark: '#4e6a36', light: '#799551', detail: 2 },
  [T.Forest]: { base: '#2b4a30', alt: '#325538', dark: '#233d28', light: '#3b6140', detail: 1 },
  [T.Dirt]: { base: '#6b563a', alt: '#766046', dark: '#5b4931', light: '#836c50', detail: 1 },
  [T.Road]: { base: '#7a6446', alt: '#866f50', dark: '#68553b', light: '#937c5b', detail: 2 },
  [T.Gravel]: { base: '#6a6860', alt: '#77746b', dark: '#5b5951', light: '#848178', detail: 2 },
  [T.Rock]: { base: '#74736c', alt: '#807f77', dark: '#63625c', light: '#8e8d84', detail: 2 },
  [T.Snow]: { base: '#c3ccd6', alt: '#d2dae2', dark: '#adb7c4', light: '#e4eaf0', detail: 1 },
}

function paletteFor(t: Tile): Palette {
  return PALETTES[t] ?? PALETTES[T.Grass]
}

export class Terrain {
  private cache = new Map<string, HTMLCanvasElement>()
  private order: string[] = []
  private readonly limit = 320

  constructor(private world: World) {}

  chunk(cx: number, cy: number): HTMLCanvasElement {
    const key = `${cx},${cy}`
    const hit = this.cache.get(key)
    if (hit) return hit
    const cv = this.bake(cx, cy)
    this.cache.set(key, cv)
    this.order.push(key)
    if (this.order.length > this.limit) {
      const drop = this.order.shift()!
      this.cache.delete(drop)
    }
    return cv
  }

  private bake(cx: number, cy: number): HTMLCanvasElement {
    const cv = document.createElement('canvas')
    cv.width = CHUNK_PX
    cv.height = CHUNK_PX
    const ctx = cv.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    const ox = cx * CHUNK_PX
    const oy = cy * CHUNK_PX
    const n = CHUNK_PX / TYPE_PX

    // Pass 1 — resolve the terrain type of every 8px block.
    const types: Tile[] = new Array(n * n)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        types[j * n + i] = this.world.sampleTile(
          ox + i * TYPE_PX + TYPE_PX / 2,
          oy + j * TYPE_PX + TYPE_PX / 2,
        )
      }
    }

    // Pass 2 — shade each block from continuous world-space noise.
    const per = TYPE_PX / SHADE_PX
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const p = paletteFor(types[j * n + i]!)
        for (let sy = 0; sy < per; sy++) {
          for (let sx = 0; sx < per; sx++) {
            const wx = ox + i * TYPE_PX + sx * SHADE_PX
            const wy = oy + j * TYPE_PX + sy * SHADE_PX
            const broad = fbm(wx * 0.013, wy * 0.013, 3, 17)
            const fine = fbm(wx * 0.08, wy * 0.08, 2, 823)
            const v = broad * 0.58 + fine * 0.42
            ctx.fillStyle = v > 0.6 ? p.light : v > 0.5 ? p.alt : v > 0.41 ? p.base : p.dark
            ctx.fillRect(
              i * TYPE_PX + sx * SHADE_PX,
              j * TYPE_PX + sy * SHADE_PX,
              SHADE_PX,
              SHADE_PX,
            )
          }
        }
      }
    }

    // Pass 3 — soften the remaining 8px steps and add per-terrain flourishes.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const here = types[j * n + i]!
        this.featherBlock(ctx, types, n, i, j, here)
        this.decorateBlock(ctx, ox, oy, i, j, here)
      }
    }
    return cv
  }

  /** Scatters a few of the neighbour's pixels across an 8px type boundary. */
  private featherBlock(
    ctx: CanvasRenderingContext2D,
    types: Tile[],
    n: number,
    i: number,
    j: number,
    here: Tile,
  ) {
    const px = i * TYPE_PX
    const py = j * TYPE_PX
    const neighbours: [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]
    for (const [dx, dy] of neighbours) {
      const ni = i + dx
      const nj = j + dy
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
      const other = types[nj * n + ni]!
      if (other === here) continue
      const p = paletteFor(other)
      // Two pixels deep, thinning as it goes — enough to break the step
      // without drawing a second visible border.
      for (let a = 0; a < TYPE_PX; a++) {
        for (let d = 0; d < 3; d++) {
          const h = hash2(px + a * 3 + d * 7, py + a * 5 - d * 11, 1601 + dx * 3 + dy * 9)
          if (h < 0.3 + d * 0.26) continue
          const x = dx === 0 ? px + a : dx > 0 ? px + TYPE_PX - 1 - d : px + d
          const y = dy === 0 ? py + a : dy > 0 ? py + TYPE_PX - 1 - d : py + d
          ctx.fillStyle = h > 0.75 ? p.base : p.dark
          ctx.fillRect(x, y, 1, 1)
        }
      }
    }
  }

  private decorateBlock(
    ctx: CanvasRenderingContext2D,
    ox: number,
    oy: number,
    i: number,
    j: number,
    tile: Tile,
  ) {
    const px = i * TYPE_PX
    const py = j * TYPE_PX
    const wx = ox + px
    const wy = oy + py
    const p = paletteFor(tile)

    for (let k = 0; k < p.detail; k++) {
      const h = hash2(wx * 3 + k, wy * 7 - k, 307)
      if (h < 0.55) continue
      ctx.fillStyle = h > 0.8 ? p.light : p.dark
      ctx.fillRect(px + Math.floor(hash2(wx, wy + k, 101) * 6), py + Math.floor(h * 6), 2, 1)
    }

    switch (tile) {
      case T.Water:
        if (hash2(wx, wy, 55) > 0.86) {
          ctx.fillStyle = '#4a7397'
          ctx.fillRect(px + 1, py + Math.floor(hash2(wx, wy, 77) * 6), 6, 1)
        }
        break
      case T.Road:
        if (hash2(wx, wy, 901) > 0.72) {
          ctx.fillStyle = '#5f4d36'
          ctx.fillRect(px + Math.floor(hash2(wx, wy, 907) * 6), py + 2, 2, 2)
        }
        break
      case T.Meadow:
        if (hash2(wx, wy, 601) > 0.62) {
          ctx.fillStyle = '#87a75e'
          ctx.fillRect(px + Math.floor(hash2(wx, wy, 607) * 7), py + 3, 1, 3)
        }
        break
      case T.Gravel:
      case T.Rock:
        if (hash2(wx, wy, 411) > 0.8) {
          ctx.fillStyle = p.light
          ctx.fillRect(px + 2, py + 2, 3, 2)
          ctx.fillStyle = p.dark
          ctx.fillRect(px + 2, py + 4, 3, 1)
        }
        break
      case T.Snow:
        if (hash2(wx, wy, 701) > 0.7) {
          ctx.fillStyle = '#f2f6fa'
          ctx.fillRect(px + Math.floor(hash2(wx, wy, 709) * 4), py + 2, 4, 2)
        }
        break
      default:
        break
    }
  }
}
