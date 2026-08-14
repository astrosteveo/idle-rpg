/** Generated terrain textures applied to deterministic world classification. */
import { T, TILE, type Tile, type World } from '../game/world'

export const CHUNK_TILES = 8
export const CHUNK_PX = CHUNK_TILES * TILE
const SAMPLE = 8

const TILE_SOURCE: Record<Tile, number> = {
  [T.Water]: 0,
  [T.Shallow]: 1,
  [T.Sand]: 6,
  [T.Grass]: 2,
  [T.GrassLush]: 3,
  [T.Meadow]: 2,
  [T.Forest]: 3,
  [T.Dirt]: 7,
  [T.Road]: 6,
  [T.Gravel]: 5,
  [T.Rock]: 5,
  [T.Snow]: 10,
}

export class Terrain {
  private cache = new Map<string, HTMLCanvasElement>()
  private order: string[] = []
  private readonly limit = 320

  constructor(
    private world: World,
    private atlas: HTMLImageElement,
  ) {}

  chunk(cx: number, cy: number): HTMLCanvasElement {
    const key = `${cx},${cy}`
    const hit = this.cache.get(key)
    if (hit) return hit
    const baked = this.bake(cx, cy)
    this.cache.set(key, baked)
    this.order.push(key)
    if (this.order.length > this.limit) {
      const drop = this.order.shift()
      if (drop) this.cache.delete(drop)
    }
    return baked
  }

  private bake(cx: number, cy: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = CHUNK_PX
    canvas.height = CHUNK_PX
    const context = canvas.getContext('2d')!
    context.imageSmoothingEnabled = false
    const originX = cx * CHUNK_PX
    const originY = cy * CHUNK_PX
    const cellW = this.atlas.naturalWidth / 4
    const cellH = this.atlas.naturalHeight / 3

    for (let y = 0; y < CHUNK_PX; y += SAMPLE) {
      for (let x = 0; x < CHUNK_PX; x += SAMPLE) {
        const worldX = originX + x
        const worldY = originY + y
        const tile = this.world.sampleTile(worldX + SAMPLE / 2, worldY + SAMPLE / 2)
        this.drawSample(context, tile, worldX, worldY, x, y, cellW, cellH)

        // A two-pixel transition mask softens classification edges while the
        // source textures remain the complete visible art.
        const east = this.world.sampleTile(worldX + SAMPLE + 1, worldY + SAMPLE / 2)
        if (east !== tile) {
          context.globalAlpha = 0.45
          context.drawImage(canvas, x + SAMPLE - 2, y, 2, SAMPLE, x + SAMPLE - 2, y, 2, SAMPLE)
          context.globalAlpha = 1
        }
      }
    }
    return canvas
  }

  private drawSample(
    context: CanvasRenderingContext2D,
    tile: Tile,
    worldX: number,
    worldY: number,
    x: number,
    y: number,
    cellW: number,
    cellH: number,
  ) {
    const source = TILE_SOURCE[tile]
    const column = source % 4
    const row = Math.floor(source / 4)
    const localX = ((worldX % Math.floor(cellW - SAMPLE)) + Math.floor(cellW - SAMPLE)) % Math.floor(cellW - SAMPLE)
    const localY = ((worldY % Math.floor(cellH - SAMPLE)) + Math.floor(cellH - SAMPLE)) % Math.floor(cellH - SAMPLE)
    context.drawImage(
      this.atlas,
      column * cellW + localX,
      row * cellH + localY,
      SAMPLE,
      SAMPLE,
      x,
      y,
      SAMPLE,
      SAMPLE,
    )
  }
}
