export interface Vec {
  x: number
  y: number
}

export const TAU = Math.PI * 2

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Frame-rate independent exponential approach. */
export function damp(a: number, b: number, rate: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-rate * dt))
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by)
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

/** Shortest signed delta between two angles, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

/**
 * Sprite facing bucket, one per sheet row:
 * 0 = down, 1 = left, 2 = right, 3 = up,
 * 4 = down-right, 5 = down-left, 6 = up-right, 7 = up-left.
 *
 * The cardinals keep rows 0..3 so anything indexing a single row (the corpse
 * bake pulls the side view from row 2) is unaffected by the diagonals.
 */
const DIR_BY_OCTANT = [2, 4, 0, 5, 1, 7, 3, 6] as const

export function facingToDir(angle: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const a = ((angle % TAU) + TAU) % TAU
  // Octants are centred on each of the eight headings, so a heading sits in
  // the middle of its bucket rather than on a boundary.
  return DIR_BY_OCTANT[Math.round(a / (TAU / 8)) % 8]!
}

/** Deterministic 32-bit PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rng {
  (): number
  range(lo: number, hi: number): number
  int(lo: number, hi: number): number
  pick<T>(arr: readonly T[]): T
  chance(p: number): boolean
}

export function rng(seed: number): Rng {
  const base = makeRng(seed)
  const r = (() => base()) as Rng
  r.range = (lo, hi) => lo + base() * (hi - lo)
  r.int = (lo, hi) => Math.floor(lo + base() * (hi - lo + 1))
  r.pick = <T,>(arr: readonly T[]) => arr[Math.floor(base() * arr.length)]!
  r.chance = (p) => base() < p
  return r
}

/** Stable integer hash — used for per-tile detail so terrain never shimmers. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const smooth = (t: number) => t * t * (3 - 2 * t)

/** Smoothed value noise on an integer lattice. */
export function valueNoise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = smooth(x - xi)
  const yf = smooth(y - yi)
  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)
  return lerp(lerp(a, b, xf), lerp(c, d, xf), yf)
}

/** Fractal brownian motion over valueNoise. Returns roughly 0..1. */
export function fbm(x: number, y: number, octaves = 4, seed = 0): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  let fx = x
  let fy = y
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(fx, fy, seed + i * 1013) * amp
    norm += amp
    amp *= 0.5
    fx *= 2.03
    fy *= 2.03
  }
  return sum / norm
}

/** Squared distance from point p to segment ab — used for carving roads. */
export function distToSegment2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1)
  return dist2(px, py, ax + dx * t, ay + dy * t)
}
