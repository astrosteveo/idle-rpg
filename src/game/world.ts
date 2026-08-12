/**
 * World generation.
 *
 * The map is deterministic from a single seed: terrain is sampled on demand
 * from noise, while props, camps and enemy spawn nodes are placed once at
 * boot. Spawn nodes are deliberately clustered (wolf dens, bear grounds) and
 * kept clear of the roads, so travelling between camps is mostly peaceful and
 * a fight feels like somewhere you chose to go.
 */
import { clamp, dist, dist2, distToSegment2, fbm, hash2, rng, type Rng } from '../core/math'
import type { EnemyKind } from './types'

export const TILE = 32
export const MAP_TILES = 148
export const WORLD_SIZE = TILE * MAP_TILES

export const T = {
  Water: 0,
  Shallow: 1,
  Sand: 2,
  Grass: 3,
  GrassLush: 4,
  Meadow: 5,
  Forest: 6,
  Dirt: 7,
  Road: 8,
  Gravel: 9,
  Rock: 10,
  Snow: 11,
} as const
export type Tile = (typeof T)[keyof typeof T]

export function isSolidTile(t: Tile): boolean {
  return t === T.Water
}

export type BiomeId = 'vale' | 'thicket' | 'ridge' | 'wilds'

export interface Region {
  id: BiomeId
  name: string
  x: number
  y: number
  radius: number
  /** Enemy make-up of this region. */
  kind: EnemyKind | null
  levelMin: number
  levelMax: number
  /** Number of spawn nodes and how many enemies each holds. */
  nodes: number
  packMin: number
  packMax: number
  eliteNodes: number
  color: string
}

export interface Camp {
  id: string
  name: string
  x: number
  y: number
  radius: number
  discovered: boolean
}

export interface SpawnNode {
  id: number
  region: BiomeId
  kind: EnemyKind
  elite: boolean
  level: number
  x: number
  y: number
  radius: number
  cap: number
  /** Ids of live enemies belonging to this node. */
  alive: number[]
  respawnAt: number
}

export interface PropInstance {
  x: number
  y: number
  kind: string
  variant: number
}

export const REGIONS: Region[] = [
  {
    id: 'vale',
    name: 'Greenwood Vale',
    x: 2400,
    y: 3450,
    radius: 900,
    kind: 'wolf',
    levelMin: 1,
    levelMax: 3,
    nodes: 7,
    packMin: 2,
    packMax: 3,
    eliteNodes: 0,
    color: '#4d7f3c',
  },
  {
    id: 'thicket',
    name: 'Wolfden Thicket',
    x: 3550,
    y: 1750,
    radius: 860,
    kind: 'wolf',
    levelMin: 4,
    levelMax: 8,
    nodes: 10,
    packMin: 3,
    packMax: 5,
    eliteNodes: 2,
    color: '#2f5c37',
  },
  {
    id: 'ridge',
    name: 'Stonewatch Ridge',
    x: 1250,
    y: 1650,
    radius: 900,
    kind: 'bear',
    levelMin: 6,
    levelMax: 11,
    nodes: 9,
    packMin: 1,
    packMax: 2,
    eliteNodes: 2,
    color: '#6b6a5d',
  },
]

export const WILDS: Region = {
  id: 'wilds',
  name: 'The Open Wilds',
  x: 0,
  y: 0,
  radius: 0,
  kind: null,
  levelMin: 1,
  levelMax: 1,
  nodes: 0,
  packMin: 0,
  packMax: 0,
  eliteNodes: 0,
  color: '#5d7a49',
}

export const CAMPS: Camp[] = [
  { id: 'hearthglen', name: 'Hearthglen Camp', x: 2400, y: 3660, radius: 250, discovered: true },
  { id: 'rangers', name: "Ranger's Rest", x: 3420, y: 2440, radius: 235, discovered: false },
  { id: 'stonewatch', name: 'Stonewatch Hold', x: 1520, y: 2380, radius: 235, discovered: false },
]

/** Roads connect the camps; they carve dirt tiles and keep spawns at bay. */
const ROADS: [number, number, number, number][] = []
function buildRoads() {
  const [a, b, c] = CAMPS as [Camp, Camp, Camp]
  // A gentle dog-leg reads better than a straight line across the map.
  const leg = (p: Camp, q: Camp, bendX: number, bendY: number) => {
    const mx = (p.x + q.x) / 2 + bendX
    const my = (p.y + q.y) / 2 + bendY
    ROADS.push([p.x, p.y, mx, my], [mx, my, q.x, q.y])
  }
  leg(a, b, 220, 90)
  leg(a, c, -240, 60)
  leg(b, c, 40, -300)
}
buildRoads()

export class World {
  readonly seed: number
  readonly props: PropInstance[] = []
  readonly nodes: SpawnNode[] = []
  /** props bucketed by 512px cell for cheap view queries */
  readonly propGrid = new Map<string, PropInstance[]>()
  readonly minimap: HTMLCanvasElement

  private tileCache = new Map<number, Tile>()

  constructor(seed = 20260812) {
    this.seed = seed
    this.generateProps()
    this.generateNodes()
    this.minimap = this.bakeMinimap()
  }

  /* ---------------- terrain ---------------- */

  regionAt(wx: number, wy: number): Region {
    let best: Region | null = null
    let bestW = 0
    for (const r of REGIONS) {
      const d = dist(wx, wy, r.x, r.y)
      const w = 1 - d / r.radius
      if (w > bestW) {
        bestW = w
        best = r
      }
    }
    return best ?? WILDS
  }

  /** Blend factor 0..1 of how strongly a point sits inside its region. */
  regionStrength(wx: number, wy: number, r: Region): number {
    if (r.radius === 0) return 0
    return clamp(1 - dist(wx, wy, r.x, r.y) / r.radius, 0, 1)
  }

  campAt(wx: number, wy: number): Camp | null {
    for (const c of CAMPS) {
      if (dist2(wx, wy, c.x, c.y) < c.radius * c.radius) return c
    }
    return null
  }

  nearRoad(wx: number, wy: number, width: number): boolean {
    const w2 = width * width
    for (const s of ROADS) {
      if (distToSegment2(wx, wy, s[0], s[1], s[2], s[3]) < w2) return true
    }
    return false
  }

  tileAt(tx: number, ty: number): Tile {
    if (tx < 0 || ty < 0 || tx >= MAP_TILES || ty >= MAP_TILES) return T.Water
    const key = ty * MAP_TILES + tx
    const hit = this.tileCache.get(key)
    if (hit !== undefined) return hit
    const t = this.sampleTile(tx * TILE + TILE / 2, ty * TILE + TILE / 2)
    // Cache is bounded by the map size, so it simply warms up as you explore.
    this.tileCache.set(key, t)
    return t
  }

  /**
   * Terrain type at an arbitrary world point. Gameplay reads it through the
   * 32px tile grid, but the renderer samples it far more finely so biome
   * boundaries follow the noise instead of the tile grid.
   */
  sampleTile(wx: number, wy: number): Tile {
    const tx = wx / TILE
    const ty = wy / TILE
    const s = this.seed

    // Camps are packed earth with a road-worn centre.
    const camp = this.campAt(wx, wy)
    if (camp) {
      const d = dist(wx, wy, camp.x, camp.y) / camp.radius
      if (d < 0.72) return T.Dirt
      if (d < 0.84 + fbm(tx * 0.55, ty * 0.55, 2, s + 5) * 0.2) return T.Dirt
    }

    // Roads, with a ragged noise-driven edge.
    const roadW = 34 + fbm(tx * 0.14, ty * 0.14, 2, s + 91) * 22
    if (this.nearRoad(wx, wy, roadW)) return T.Road

    const moisture = fbm(tx * 0.028, ty * 0.028, 4, s)
    const region = this.regionAt(wx, wy)
    const str = this.regionStrength(wx, wy, region)

    // Lakes sit in the wettest low ground between the regions. Inside a
    // region they are pushed out entirely, so a wolf den never ends up at the
    // bottom of a lake.
    const waterLine = 0.3 - str * 0.34
    if (moisture < waterLine) return T.Water
    if (moisture < waterLine + 0.022) return T.Shallow
    if (moisture < waterLine + 0.04) return T.Sand

    const detail = fbm(tx * 0.1, ty * 0.1, 3, s + 400)
    // Bare-earth patches, as blobs rather than whole squares of tile.
    const patch = fbm(tx * 0.42, ty * 0.42, 2, s + 77)

    switch (region.id) {
      case 'vale':
        if (detail > 0.6) return T.Meadow
        if (detail < 0.36) return T.GrassLush
        return patch > 0.7 ? T.Dirt : T.Grass
      case 'thicket': {
        const deep = str * 0.6 + detail * 0.4
        if (deep > 0.55) return T.Forest
        if (detail < 0.38) return T.Dirt
        return T.GrassLush
      }
      case 'ridge': {
        const elev = fbm(tx * 0.042, ty * 0.042, 4, s + 31) * 0.65 + str * 0.35
        if (elev > 0.66) return T.Snow
        if (elev > 0.52) return T.Rock
        return detail > 0.55 ? T.Gravel : T.Grass
      }
      default:
        if (detail > 0.66) return T.GrassLush
        if (detail < 0.33) return patch > 0.62 ? T.Dirt : T.Grass
        return T.Grass
    }
  }

  isSolid(wx: number, wy: number): boolean {
    return isSolidTile(this.tileAt(Math.floor(wx / TILE), Math.floor(wy / TILE)))
  }

  /* ---------------- props ---------------- */

  private generateProps() {
    const s = this.seed
    for (let ty = 1; ty < MAP_TILES - 1; ty++) {
      for (let tx = 1; tx < MAP_TILES - 1; tx++) {
        const roll = hash2(tx, ty, s + 9001)
        const tile = this.tileAt(tx, ty)
        if (tile === T.Water || tile === T.Shallow || tile === T.Road) continue
        const wx = tx * TILE + hash2(tx, ty, s + 12) * TILE
        const wy = ty * TILE + hash2(tx, ty, s + 13) * TILE
        if (this.campAt(wx, wy)) continue
        if (this.nearRoad(wx, wy, 48)) continue

        const region = this.regionAt(wx, wy)
        const pick = hash2(tx, ty, s + 555)
        let kind: string | null = null
        let density = 0.06

        switch (region.id) {
          case 'thicket':
            density = 0.34
            kind =
              pick < 0.62
                ? 'pine'
                : pick < 0.76
                  ? 'oak'
                  : pick < 0.86
                    ? 'bush'
                    : pick < 0.92
                      ? 'mushroom'
                      : pick < 0.97
                        ? 'stump'
                        : 'deadTree'
            break
          case 'ridge':
            density = 0.2
            if (tile === T.Snow) {
              kind = pick < 0.5 ? 'rock' : pick < 0.78 ? 'pineSnow' : 'boulder'
            } else {
              kind =
                pick < 0.38
                  ? 'rock'
                  : pick < 0.58
                    ? 'boulder'
                    : pick < 0.74
                      ? 'deadTree'
                      : pick < 0.9
                        ? 'tuft'
                        : 'bones'
            }
            break
          case 'vale':
            density = 0.16
            kind =
              pick < 0.3
                ? 'flower'
                : pick < 0.55
                  ? 'tuft'
                  : pick < 0.72
                    ? 'oak'
                    : pick < 0.84
                      ? 'bush'
                      : pick < 0.94
                        ? 'rock'
                        : 'stump'
            break
          default:
            density = 0.1
            kind =
              pick < 0.34
                ? 'tuft'
                : pick < 0.52
                  ? 'bush'
                  : pick < 0.7
                    ? 'oak'
                    : pick < 0.82
                      ? 'pine'
                      : pick < 0.93
                        ? 'rock'
                        : 'flower'
        }
        if (!kind || roll > density) continue
        this.addProp({ x: wx, y: wy, kind, variant: Math.floor(hash2(tx, ty, s + 31) * 3) })
      }
    }
    this.decorateCamps()
  }

  private decorateCamps() {
    for (const c of CAMPS) {
      const r = rng(c.x * 31 + c.y)
      this.addProp({ x: c.x, y: c.y + 6, kind: 'campfire', variant: 0 })
      const tents = 3
      for (let i = 0; i < tents; i++) {
        const a = (i / tents) * Math.PI * 2 + 0.6
        this.addProp({
          x: c.x + Math.cos(a) * (c.radius * 0.52),
          y: c.y + Math.sin(a) * (c.radius * 0.42),
          kind: 'tent',
          variant: 0,
        })
      }
      this.addProp({ x: c.x - 62, y: c.y - 40, kind: 'banner', variant: 0 })
      this.addProp({ x: c.x + 62, y: c.y - 40, kind: 'banner', variant: 0 })
      this.addProp({ x: c.x + 34, y: c.y + 46, kind: 'crate', variant: 0 })
      this.addProp({ x: c.x + 54, y: c.y + 52, kind: 'crate', variant: 0 })
      this.addProp({ x: c.x - 46, y: c.y + 54, kind: 'chest', variant: 0 })
      this.addProp({ x: c.x - 8, y: c.y + c.radius * 0.8, kind: 'signpost', variant: 0 })
      // A ring of stakes marks where the camp's protection ends.
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + r() * 0.12
        this.addProp({
          x: c.x + Math.cos(a) * c.radius * 0.95,
          y: c.y + Math.sin(a) * c.radius * 0.95,
          kind: 'stake',
          variant: 0,
        })
      }
    }
  }

  private addProp(p: PropInstance) {
    this.props.push(p)
    const key = `${Math.floor(p.x / 512)},${Math.floor(p.y / 512)}`
    let cell = this.propGrid.get(key)
    if (!cell) this.propGrid.set(key, (cell = []))
    cell.push(p)
  }

  propsInView(x0: number, y0: number, x1: number, y1: number): PropInstance[] {
    const out: PropInstance[] = []
    const cx0 = Math.floor((x0 - 64) / 512)
    const cy0 = Math.floor((y0 - 96) / 512)
    const cx1 = Math.floor((x1 + 64) / 512)
    const cy1 = Math.floor((y1 + 64) / 512)
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = this.propGrid.get(`${cx},${cy}`)
        if (!cell) continue
        for (const p of cell) {
          if (p.x > x0 - 64 && p.x < x1 + 64 && p.y > y0 - 96 && p.y < y1 + 64) out.push(p)
        }
      }
    }
    return out
  }

  /* ---------------- spawn nodes ---------------- */

  private generateNodes() {
    let id = 0
    for (const region of REGIONS) {
      if (!region.kind) continue
      const r = rng(region.x * 7919 + region.y * 104729)
      const placed: SpawnNode[] = []
      const want = region.nodes + region.eliteNodes
      let guard = 0
      while (placed.length < want && guard++ < 3000) {
        const elite = placed.length >= region.nodes
        const a = r() * Math.PI * 2
        // sqrt keeps nodes evenly spread rather than bunched at the centre
        const rad = Math.sqrt(r()) * region.radius * 0.86
        const x = region.x + Math.cos(a) * rad
        const y = region.y + Math.sin(a) * rad
        if (x < 300 || y < 300 || x > WORLD_SIZE - 300 || y > WORLD_SIZE - 300) continue
        // Require dry ground across the whole den, not just its centre point.
        if (
          this.isSolid(x, y) ||
          this.isSolid(x - 90, y) ||
          this.isSolid(x + 90, y) ||
          this.isSolid(x, y - 90) ||
          this.isSolid(x, y + 90)
        ) {
          continue
        }
        if (this.nearRoad(x, y, 190)) continue
        let clear = true
        for (const c of CAMPS) {
          if (dist(x, y, c.x, c.y) < c.radius + 340) clear = false
        }
        for (const n of placed) {
          if (dist(x, y, n.x, n.y) < (elite ? 420 : 300)) clear = false
        }
        if (!clear) continue

        const t = placed.length / Math.max(1, want - 1)
        const level = Math.round(region.levelMin + (region.levelMax - region.levelMin) * t)
        placed.push({
          id: id++,
          region: region.id,
          kind: region.kind,
          elite,
          level: elite ? level + 2 : level,
          x,
          y,
          radius: elite ? 150 : 190,
          cap: elite ? 1 : Math.round(region.packMin + r() * (region.packMax - region.packMin)),
          alive: [],
          respawnAt: 0,
        })
      }
      this.nodes.push(...placed)
    }
  }

  /** A scattered wandering point inside a node's territory. */
  nodeWanderPoint(n: SpawnNode, r: Rng): { x: number; y: number } {
    for (let i = 0; i < 8; i++) {
      const a = r() * Math.PI * 2
      const rad = Math.sqrt(r()) * n.radius
      const x = n.x + Math.cos(a) * rad
      const y = n.y + Math.sin(a) * rad
      if (!this.isSolid(x, y)) return { x, y }
    }
    return { x: n.x, y: n.y }
  }

  /* ---------------- minimap ---------------- */

  private bakeMinimap(): HTMLCanvasElement {
    const size = MAP_TILES
    const cv = document.createElement('canvas')
    cv.width = size
    cv.height = size
    const ctx = cv.getContext('2d')!
    const img = ctx.createImageData(size, size)
    const colors: Record<number, [number, number, number]> = {
      [T.Water]: [38, 62, 96],
      [T.Shallow]: [56, 92, 124],
      [T.Sand]: [154, 140, 100],
      [T.Grass]: [66, 96, 56],
      [T.GrassLush]: [58, 88, 50],
      [T.Meadow]: [92, 118, 60],
      [T.Forest]: [34, 60, 38],
      [T.Dirt]: [92, 74, 52],
      [T.Road]: [116, 96, 68],
      [T.Gravel]: [96, 94, 86],
      [T.Rock]: [110, 108, 100],
      [T.Snow]: [196, 204, 212],
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = colors[this.tileAt(x, y)] ?? [60, 80, 50]
        const shade = 0.86 + hash2(x, y, 7) * 0.28
        const o = (y * size + x) * 4
        img.data[o] = clamp(c[0] * shade, 0, 255)
        img.data[o + 1] = clamp(c[1] * shade, 0, 255)
        img.data[o + 2] = clamp(c[2] * shade, 0, 255)
        img.data[o + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    return cv
  }
}
