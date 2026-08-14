import { clamp, hash2 } from '../core/math'
import { MAP_TILES, T, type World } from '../game/world'

/** Rendering owns the baked map. World remains deterministic domain data. */
export function bakeMinimap(world: World): HTMLCanvasElement {
  const size = MAP_TILES
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')!
  const image = context.createImageData(size, size)
  const colors: Record<number, readonly [number, number, number]> = {
    [T.Water]: [24, 43, 58], [T.Shallow]: [42, 70, 76], [T.Sand]: [103, 88, 59],
    [T.Grass]: [51, 69, 35], [T.GrassLush]: [42, 62, 31], [T.Meadow]: [72, 85, 38],
    [T.Forest]: [24, 43, 25], [T.Dirt]: [75, 57, 36], [T.Road]: [99, 76, 45],
    [T.Gravel]: [73, 72, 65], [T.Rock]: [78, 77, 70], [T.Snow]: [161, 166, 163],
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const color = colors[world.tileAt(x, y)] ?? [45, 58, 35]
      const shade = 0.78 + hash2(x, y, 7) * 0.28
      const offset = (y * size + x) * 4
      image.data[offset] = clamp(color[0] * shade, 0, 255)
      image.data[offset + 1] = clamp(color[1] * shade, 0, 255)
      image.data[offset + 2] = clamp(color[2] * shade, 0, 255)
      image.data[offset + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  return canvas
}
