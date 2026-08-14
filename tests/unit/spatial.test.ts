import { describe, expect, it } from 'vitest'
import { SpatialHash } from '../../src/game/spatial'

describe('SpatialHash', () => {
  it('matches a brute-force radius query', () => {
    const values = Array.from({ length: 500 }, (_, id) => ({
      id,
      x: (id * 83) % 5000,
      y: (id * 137) % 5000,
    }))
    const index = new SpatialHash<(typeof values)[number]>(256)
    index.rebuild(values)
    const actual = index.queryRadius(2200, 1900, 420).map((value) => value.id).sort((a, b) => a - b)
    const expected = values
      .filter((value) => Math.hypot(value.x - 2200, value.y - 1900) <= 420)
      .map((value) => value.id)
      .sort((a, b) => a - b)
    expect(actual).toEqual(expected)
    expect(index.comparisons).toBeLessThan(values.length / 2)
  })

  it('limits comparisons to occupied neighboring cells', () => {
    const values = Array.from({ length: 500 }, (_, id) => ({ id, x: id * 300, y: id * 300 }))
    const index = new SpatialHash<(typeof values)[number]>()
    index.rebuild(values)
    index.queryRadius(0, 0, 200)
    expect(index.comparisons).toBeLessThan(5)
  })
})
