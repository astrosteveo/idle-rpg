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
import type { NpcSpriteId } from '../assets/types'
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

export type BiomeId = 'vale' | 'thicket' | 'ridge' | 'downs' | 'fen' | 'crags' | 'wilds'

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
  /**
   * Placement data only — whether a camp is *known* is per-player progress and
   * lives on `Game.discovered`. Keeping it here would make one player's
   * exploration everyone's the moment the world is shared.
   */
  startDiscovered: boolean
}

/**
 * A named place inside a region. Regions have names; until now nothing inside
 * them did, which is what makes a map a set of coloured blobs rather than
 * somewhere you can give someone directions to.
 *
 * Placement data only, exactly like `Camp` — which of these a character has
 * stood in is per-player progress and lives on `Game.seenLandmarks`.
 */
export interface Landmark {
  id: string
  name: string
  x: number
  y: number
  radius: number
  /** Decides what is built here, and the line the log greets it with. */
  kind: 'cairn' | 'ruin' | 'grove' | 'crossing' | 'roost'
  /** One-line description, shown on arrival. */
  blurb: string
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
  {
    id: 'downs',
    name: 'Thornfell Downs',
    x: 820,
    y: 3860,
    radius: 700,
    kind: 'boar',
    levelMin: 5,
    levelMax: 9,
    nodes: 8,
    packMin: 2,
    packMax: 3,
    eliteNodes: 2,
    color: '#8a7a44',
  },
  {
    id: 'fen',
    name: 'Mirefen Hollow',
    x: 4020,
    y: 3620,
    radius: 660,
    kind: 'spider',
    levelMin: 10,
    levelMax: 14,
    nodes: 8,
    packMin: 2,
    packMax: 4,
    eliteNodes: 2,
    color: '#3f6a52',
  },
  {
    id: 'crags',
    name: 'Ravencrag',
    x: 2500,
    y: 760,
    radius: 560,
    kind: 'corvid',
    levelMin: 14,
    levelMax: 18,
    // Fewer, fuller roosts: the crag is the smallest region on the map, and a
    // node count it cannot physically place is a number that lies.
    nodes: 6,
    packMin: 4,
    packMax: 6,
    eliteNodes: 2,
    color: '#565270',
  },
]

/** The level a region is reckoned at — the middle of its band. */
export function groundLevelOf(r: Region): number {
  return Math.round((r.levelMin + r.levelMax) / 2)
}

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
  { id: 'hearthglen', name: 'Hearthglen Camp', x: 2400, y: 3660, radius: 250, startDiscovered: true },
  { id: 'rangers', name: "Ranger's Rest", x: 3420, y: 2440, radius: 235, startDiscovered: false },
  { id: 'stonewatch', name: 'Stonewatch Hold', x: 1520, y: 2380, radius: 235, startDiscovered: false },
  { id: 'thornrest', name: 'Thornrest', x: 1560, y: 3800, radius: 230, startDiscovered: false },
  { id: 'mirewatch', name: 'Mirewatch Post', x: 3820, y: 2980, radius: 230, startDiscovered: false },
  { id: 'rookrest', name: 'Rookrest', x: 2440, y: 1560, radius: 230, startDiscovered: false },
]

/**
 * A person who stands in one place and hands out work.
 *
 * Placement data, exactly like `Camp` and `Landmark`. Which lines a character
 * has heard is not stored at all — the dialogue a person offers is a function
 * of the quest chain, so the state that decides it is already in the save.
 */
export interface Npc {
  id: string
  name: string
  /** Shown under the name in the dialogue box. */
  title: string
  x: number
  y: number
  /** How close the player stands before the prompt to speak appears. */
  radius: number
  /** Which art this person wears. */
  sprite: NpcSpriteId
  /** One line to a page, said before the task is offered. */
  intro: string[]
  /** Said while the task they gave is still running. */
  waiting: string
  /** Said once their task is behind you. */
  done: string
}

export const NPCS: Npc[] = [
  {
    id: 'aldric',
    name: 'Warden Aldric',
    title: 'Hearthglen Camp',
    // North-west of the fire, on the ground a new character walks in across.
    x: 2344,
    y: 3704,
    radius: 58,
    sprite: 'warden',
    intro: [
      'Hearthglen still stands. That is the most I will claim for it.',
      'Wolves come off the Vale bolder every night. The stock is thin and we burn the fires late.',
      'Thin the pack and the rest will keep their distance. Six would be a start.',
    ],
    waiting: 'Six wolves. Come back to the fire when the grass is red.',
    done: 'The Vale is quieter for what you did. Keep it that way.',
  },
]

export function npcById(id: string): Npc | null {
  return NPCS.find((n) => n.id === id) ?? null
}

/**
 * Seven named places, one to a region plus a crossroads in the open. They are
 * deliberately not quest targets or reward sites — a landmark earns its keep by
 * being somewhere you can name, which is what turns "the north-west bit" into
 * "the Wind Altar".
 */
export const LANDMARKS: Landmark[] = [
  {
    id: 'standing-stone',
    name: 'The Standing Stone',
    x: 2760,
    y: 3180,
    radius: 165,
    kind: 'cairn',
    blurb: 'Older than the camp, and nobody at the camp will say who raised it.',
  },
  {
    id: 'hollow-oak',
    name: 'The Hollow Oak',
    // Moved off the lake it originally straddled: a landmark's whole disc has
    // to be dry, or a third of its grove is planted in water and the apex that
    // holds it stands in the shallows.
    x: 3150,
    y: 1600,
    radius: 175,
    kind: 'grove',
    blurb: 'Struck once, a long time ago, and still holding the whole clearing open.',
  },
  {
    id: 'wind-altar',
    name: 'The Wind Altar',
    x: 1100,
    y: 1300,
    radius: 170,
    kind: 'ruin',
    blurb: 'Three walls of a hall the ridge has been taking back for a century.',
  },
  {
    id: 'bonefield',
    name: 'The Bonefield',
    x: 1060,
    y: 3600,
    radius: 175,
    kind: 'cairn',
    blurb: 'Something was driven through here in numbers, and it did not get out.',
  },
  {
    id: 'drowned-chapel',
    name: 'The Drowned Chapel',
    x: 3900,
    y: 3350,
    radius: 170,
    kind: 'ruin',
    blurb: 'It stood on dry ground once. The hollow disagreed.',
  },
  {
    id: 'rookstone',
    name: 'The Rookstone',
    x: 2620,
    y: 950,
    radius: 160,
    kind: 'roost',
    blurb: 'Every bird on the crag can see it, and every bird on the crag watches it.',
  },
  {
    id: 'crowfoot',
    name: 'Crowfoot Crossing',
    x: 2620,
    y: 2960,
    radius: 150,
    kind: 'crossing',
    blurb: 'Where the Hearthglen road forks. Everyone passes it; nobody stops.',
  },
]

/**
 * Roads connect the camps; they carve dirt tiles and keep spawns at bay.
 *
 * An explicit link list rather than every pair: a road suppresses spawn nodes
 * within 190px of itself, so a fully-connected map would quietly starve the
 * regions it crosses. Each entry is a dog-leg, which reads better than a
 * straight line drawn across half the world.
 */
const ROAD_LINKS: [string, string, number, number][] = [
  ['hearthglen', 'rangers', 220, 90],
  ['hearthglen', 'stonewatch', -240, 60],
  ['rangers', 'stonewatch', 40, -300],
  ['hearthglen', 'thornrest', -40, 170],
  ['rangers', 'mirewatch', 190, 30],
  ['rangers', 'rookrest', -300, -140],
]

const ROADS: [number, number, number, number][] = []
function buildRoads() {
  for (const [from, to, bendX, bendY] of ROAD_LINKS) {
    const p = CAMPS.find((c) => c.id === from)
    const q = CAMPS.find((c) => c.id === to)
    if (!p || !q) continue
    const mx = (p.x + q.x) / 2 + bendX
    const my = (p.y + q.y) / 2 + bendY
    ROADS.push([p.x, p.y, mx, my], [mx, my, q.x, q.y])
  }
}
buildRoads()

export class World {
  readonly seed: number
  readonly props: PropInstance[] = []
  readonly nodes: SpawnNode[] = []
  /** props bucketed by 512px cell for cheap view queries */
  readonly propGrid = new Map<string, PropInstance[]>()

  private tileCache = new Map<number, Tile>()

  constructor(seed = 20260812) {
    this.seed = seed
    this.generateProps()
    this.generateNodes()
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

  /** The person close enough to speak to, or null. */
  npcAt(wx: number, wy: number): Npc | null {
    for (const n of NPCS) {
      if (dist2(wx, wy, n.x, n.y) < n.radius * n.radius) return n
    }
    return null
  }

  landmarkAt(wx: number, wy: number): Landmark | null {
    for (const l of LANDMARKS) {
      if (dist2(wx, wy, l.x, l.y) < l.radius * l.radius) return l
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
      case 'downs':
        // Open heath: cropped meadow over bare pasture, worn through to
        // gravel where the herds have rooted it up.
        if (detail > 0.62) return T.Meadow
        if (patch > 0.68) return T.Dirt
        return detail < 0.38 ? T.Gravel : T.Grass
      case 'fen': {
        // Standing water everywhere, but *shallow* water: the hollow has to be
        // walkable, or half of it is unreachable and its dens never place.
        const bog = fbm(tx * 0.075, ty * 0.075, 3, s + 613) * 0.7 + str * 0.3
        if (bog > 0.63) return T.Shallow
        if (bog > 0.57) return T.Sand
        return detail < 0.42 ? T.Dirt : T.GrassLush
      }
      case 'crags': {
        const elev = fbm(tx * 0.05, ty * 0.05, 4, s + 227) * 0.6 + str * 0.4
        if (elev > 0.6) return T.Rock
        if (elev > 0.46) return T.Gravel
        return detail > 0.54 ? T.Dirt : T.Gravel
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

  /* ---------------- travel ---------------- */

  /**
   * A route from one world point to another, as a short list of world points.
   *
   * A straight walk is not enough: the mover slides along whichever axis is
   * free, so a bay in a lake holds it against the shore for as long as it
   * pushes. This searches the 32 px tile grid instead. The map is 148 tiles
   * square, so the worst search is a few thousand tiles, and it runs once for
   * each journey rather than once for each frame.
   *
   * The first attempt keeps one tile of clearance from water, because the
   * mover collides with a padded box and a route that shaves a shoreline
   * catches on it. A land bridge one tile wide has no such route, thus a
   * failed search tries again on the bare walkable grid.
   */
  findPath(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] | null {
    const sx = Math.floor(x0 / TILE)
    const sy = Math.floor(y0 / TILE)
    const gx = Math.floor(x1 / TILE)
    const gy = Math.floor(y1 / TILE)
    for (const margin of [true, false]) {
      const start = this.nearestWalkable(sx, sy, margin)
      const goal = this.nearestWalkable(gx, gy, margin)
      if (!start || !goal) continue
      const tiles = this.search(start, goal, margin)
      if (tiles) return this.smooth(tiles, x1, y1)
    }
    return null
  }

  /** A tile the mover fits in, at or near the one asked for. */
  private nearestWalkable(tx: number, ty: number, margin: boolean): [number, number] | null {
    if (this.walkable(tx, ty, margin)) return [tx, ty]
    for (let r = 1; r <= 5; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          if (this.walkable(tx + dx, ty + dy, margin)) return [tx + dx, ty + dy]
        }
      }
    }
    return null
  }

  private walkable(tx: number, ty: number, margin: boolean): boolean {
    if (tx < 1 || ty < 1 || tx >= MAP_TILES - 1 || ty >= MAP_TILES - 1) return false
    if (isSolidTile(this.tileAt(tx, ty))) return false
    if (!margin) return true
    return (
      !isSolidTile(this.tileAt(tx - 1, ty)) &&
      !isSolidTile(this.tileAt(tx + 1, ty)) &&
      !isSolidTile(this.tileAt(tx, ty - 1)) &&
      !isSolidTile(this.tileAt(tx, ty + 1))
    )
  }

  /** A* over the tile grid, eight ways, no cutting a blocked corner. */
  private search(
    start: [number, number],
    goal: [number, number],
    margin: boolean,
  ): [number, number][] | null {
    const N = MAP_TILES
    const size = N * N
    const startId = start[1] * N + start[0]
    const goalId = goal[1] * N + goal[0]
    if (startId === goalId) return [start]

    const g = new Float32Array(size).fill(Infinity)
    const f = new Float32Array(size).fill(Infinity)
    const from = new Int32Array(size).fill(-1)
    const closed = new Uint8Array(size)
    const heap: number[] = []

    const h = (id: number) => {
      const dx = Math.abs((id % N) - goal[0])
      const dy = Math.abs(Math.floor(id / N) - goal[1])
      // Octile: the diagonal steps cost more, so the estimate stays admissible.
      return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy)
    }
    const swap = (a: number, b: number) => {
      const t = heap[a]!
      heap[a] = heap[b]!
      heap[b] = t
    }
    const push = (id: number) => {
      heap.push(id)
      let i = heap.length - 1
      while (i > 0) {
        const p = (i - 1) >> 1
        if (f[heap[p]!]! <= f[heap[i]!]!) break
        swap(p, i)
        i = p
      }
    }
    const pop = (): number => {
      const top = heap[0]!
      const last = heap.pop()!
      if (heap.length) {
        heap[0] = last
        let i = 0
        for (;;) {
          const l = i * 2 + 1
          const r = l + 1
          let m = i
          if (l < heap.length && f[heap[l]!]! < f[heap[m]!]!) m = l
          if (r < heap.length && f[heap[r]!]! < f[heap[m]!]!) m = r
          if (m === i) break
          swap(m, i)
          i = m
        }
      }
      return top
    }

    g[startId] = 0
    f[startId] = h(startId)
    push(startId)

    while (heap.length) {
      const cur = pop()
      if (cur === goalId) break
      if (closed[cur]) continue
      closed[cur] = 1
      const cx = cur % N
      const cy = Math.floor(cur / N)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = cx + dx
          const ny = cy + dy
          if (!this.walkable(nx, ny, margin)) continue
          // A diagonal that squeezes between two blocked tiles is a route the
          // collision box cannot take.
          if (dx && dy) {
            if (!this.walkable(cx + dx, cy, margin)) continue
            if (!this.walkable(cx, cy + dy, margin)) continue
          }
          const id = ny * N + nx
          if (closed[id]) continue
          const step = dx && dy ? 1.4142 : 1
          const cost = g[cur]! + step
          if (cost >= g[id]!) continue
          g[id] = cost
          f[id] = cost + h(id)
          from[id] = cur
          push(id)
        }
      }
    }

    if (from[goalId] === -1) return null
    const out: [number, number][] = []
    for (let id = goalId; id !== -1; id = from[id]!) {
      out.push([id % N, Math.floor(id / N)])
      if (id === startId) break
    }
    out.reverse()
    return out
  }

  /**
   * Drop every waypoint the mover can see past. Without this the walk follows
   * the grid, and a route across open ground reads as a staircase.
   */
  private smooth(tiles: [number, number][], gx: number, gy: number): { x: number; y: number }[] {
    const pts = tiles.map(([tx, ty]) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 }))
    pts[pts.length - 1] = { x: gx, y: gy }
    // One tile means the goal is the only waypoint; the loop below needs two.
    if (pts.length < 2) return [{ x: gx, y: gy }]
    const out: { x: number; y: number }[] = []
    let i = 0
    while (i < pts.length - 1) {
      let j = pts.length - 1
      while (j > i + 1 && !this.clearLine(pts[i]!, pts[j]!)) j--
      out.push(pts[j]!)
      i = j
    }
    return out
  }

  /** True when nothing solid stands between two points. */
  private clearLine(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
    const steps = Math.ceil(dist(a.x, a.y, b.x, b.y) / 8)
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      if (this.isSolid(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false
    }
    return true
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
          case 'downs':
            density = 0.17
            kind =
              pick < 0.34
                ? 'tuft'
                : pick < 0.54
                  ? 'bush'
                  : pick < 0.7
                    ? 'stump'
                    : pick < 0.83
                      ? 'rock'
                      : pick < 0.93
                        ? 'deadTree'
                        : 'bones'
            break
          case 'fen':
            density = 0.28
            kind =
              pick < 0.3
                ? 'deadTree'
                : pick < 0.5
                  ? 'mushroom'
                  : pick < 0.68
                    ? 'bush'
                    : pick < 0.84
                      ? 'tuft'
                      : pick < 0.94
                        ? 'stump'
                        : 'bones'
            break
          case 'crags':
            density = 0.22
            kind =
              pick < 0.36
                ? 'rock'
                : pick < 0.6
                  ? 'boulder'
                  : pick < 0.78
                    ? 'deadTree'
                    : pick < 0.9
                      ? 'bones'
                      : 'tuft'
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
    this.decorateLandmarks()
  }

  /**
   * What actually makes a landmark a landmark: something built or piled at the
   * spot, so it reads from across the field rather than only in the HUD. Each
   * arrangement is seeded from the landmark's own position, so the same place
   * is the same shape for everybody.
   */
  private decorateLandmarks() {
    for (const l of LANDMARKS) {
      const r = rng(Math.round(l.x) * 131 + Math.round(l.y) * 17)
      const ring = (n: number, kind: string, rad: number, jitter = 0.5) => {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + r() * jitter
          this.addProp({
            x: l.x + Math.cos(a) * rad * (0.8 + r() * 0.4),
            y: l.y + Math.sin(a) * rad * 0.8 * (0.8 + r() * 0.4),
            kind,
            variant: Math.floor(r() * 3),
          })
        }
      }
      switch (l.kind) {
        case 'cairn':
          this.addProp({ x: l.x, y: l.y, kind: 'cairn', variant: 0 })
          ring(5, 'rock', l.radius * 0.55)
          ring(3, 'bones', l.radius * 0.34)
          break
        case 'ruin':
          for (let i = 0; i < 4; i++) {
            this.addProp({ x: l.x - 54 + i * 36, y: l.y - 30, kind: 'pillar', variant: i % 3 })
          }
          this.addProp({ x: l.x - 60, y: l.y + 34, kind: 'pillar', variant: 1 })
          this.addProp({ x: l.x + 62, y: l.y + 30, kind: 'pillar', variant: 2 })
          ring(4, 'boulder', l.radius * 0.6)
          break
        case 'grove':
          this.addProp({ x: l.x, y: l.y, kind: 'deadTree', variant: 0 })
          ring(6, 'oak', l.radius * 0.68)
          ring(5, 'mushroom', l.radius * 0.3)
          break
        case 'roost':
          this.addProp({ x: l.x, y: l.y, kind: 'cairn', variant: 0 })
          ring(5, 'deadTree', l.radius * 0.6)
          ring(4, 'bones', l.radius * 0.35)
          break
        case 'crossing':
          this.addProp({ x: l.x, y: l.y - 8, kind: 'signpost', variant: 0 })
          this.addProp({ x: l.x - 30, y: l.y + 16, kind: 'crate', variant: 0 })
          this.addProp({ x: l.x + 26, y: l.y + 22, kind: 'banner', variant: 0 })
          ring(4, 'stake', l.radius * 0.5)
          break
      }
    }
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
      let elites = 0
      let ordinary = 0
      let guard = 0
      while (placed.length < want && guard++ < 6000) {
        // Elites go down first, because they demand the most clearance from
        // their neighbours. Placing them last meant a crowded region filled up
        // on ordinary dens and then failed to fit a single elite — which is
        // how Wolfden Thicket ended up with no alphas at all, and therefore no
        // relics, while the offline ledger went on paying for them.
        const elite = elites < region.eliteNodes
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

        // Level spreads across the band within each kind of node, so an elite
        // placed first is still the region's hardest rather than its easiest.
        const rank = elite ? elites : ordinary
        const span = elite ? region.eliteNodes : region.nodes
        const t = span > 1 ? rank / (span - 1) : 0.5
        const level = Math.round(region.levelMin + (region.levelMax - region.levelMin) * t)
        if (elite) elites++
        else ordinary++
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

}
