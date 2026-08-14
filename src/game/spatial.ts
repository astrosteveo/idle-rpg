import type { EntityId } from './contracts'

export interface SpatialPoint {
  id: EntityId
  x: number
  y: number
}

/** Fixed-cell index for targeting, separation, rendering, and minimap candidates. */
export class SpatialHash<T extends SpatialPoint> {
  readonly cells = new Map<string, T[]>()
  comparisons = 0

  constructor(readonly cellSize = 256) {}

  rebuild(values: Iterable<T>) {
    this.cells.clear()
    for (const value of values) this.insert(value)
  }

  insert(value: T) {
    const key = this.key(value.x, value.y)
    const bucket = this.cells.get(key)
    if (bucket) bucket.push(value)
    else this.cells.set(key, [value])
  }

  remove(value: T) {
    const bucket = this.cells.get(this.key(value.x, value.y))
    if (!bucket) return
    const index = bucket.findIndex((candidate) => candidate.id === value.id)
    if (index >= 0) bucket.splice(index, 1)
  }

  queryRadius(x: number, y: number, radius: number): T[] {
    this.comparisons = 0
    const out: T[] = []
    const minX = Math.floor((x - radius) / this.cellSize)
    const maxX = Math.floor((x + radius) / this.cellSize)
    const minY = Math.floor((y - radius) / this.cellSize)
    const maxY = Math.floor((y + radius) / this.cellSize)
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const bucket = this.cells.get(`${cx},${cy}`)
        if (!bucket) continue
        for (const value of bucket) {
          this.comparisons++
          if (Math.hypot(value.x - x, value.y - y) <= radius) out.push(value)
        }
      }
    }
    return out
  }

  queryRect(x0: number, y0: number, x1: number, y1: number): T[] {
    this.comparisons = 0
    const out: T[] = []
    const minX = Math.floor(x0 / this.cellSize)
    const maxX = Math.floor(x1 / this.cellSize)
    const minY = Math.floor(y0 / this.cellSize)
    const maxY = Math.floor(y1 / this.cellSize)
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const bucket = this.cells.get(`${cx},${cy}`)
        if (!bucket) continue
        for (const value of bucket) {
          this.comparisons++
          if (value.x >= x0 && value.x <= x1 && value.y >= y0 && value.y <= y1) out.push(value)
        }
      }
    }
    return out
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`
  }
}
