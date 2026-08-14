/** Neutral asset ids and gameplay geometry. This module has no renderer dependency. */
export const BEAST_SHEET_IDS = [
  'wolf',
  'alphaWolf',
  'bear',
  'elderBear',
  'boar',
  'ironhideBoar',
  'spider',
  'broodmother',
  'corvid',
  'stormcrow',
  'greytooth',
  'stonebrow',
  'thornfellSow',
  'mirefenWidow',
  'gallowsKing',
] as const

export type BeastSheetId = (typeof BEAST_SHEET_IDS)[number]

export type IconKind =
  | 'axe'
  | 'sword'
  | 'mace'
  | 'helm'
  | 'chest'
  | 'gloves'
  | 'boots'
  | 'ring'
  | 'coin'
  | 'pelt'

export type NpcSpriteId = 'warden'

export interface GameplayGeometry {
  collisionRadius: number
  attackReach: number
  renderScale: number
}

const scale = (renderScale: number): GameplayGeometry => ({
  collisionRadius: renderScale,
  attackReach: renderScale,
  renderScale,
})

/** Art scale is content metadata. Gameplay can consume it without importing rendering code. */
export const BEAST_GEOMETRY: Record<BeastSheetId, GameplayGeometry> = {
  wolf: scale(1),
  alphaWolf: scale(1.25),
  bear: scale(1),
  elderBear: scale(1.2),
  boar: scale(1),
  ironhideBoar: scale(1.22),
  spider: scale(1),
  broodmother: scale(1.3),
  corvid: scale(1),
  stormcrow: scale(1.35),
  greytooth: scale(1.7),
  stonebrow: scale(1.5),
  thornfellSow: scale(1.6),
  mirefenWidow: scale(1.7),
  gallowsKing: scale(1.9),
}

export interface AtlasAsset {
  id: 'warriorSheet' | 'wolfSheet' | 'portrait' | 'enemies' | 'support' | 'terrain'
  src: string
  width: number
  height: number
  required: true
}

/**
 * One sprite's true rectangle in its atlas, and where it sits inside a cell.
 *
 * The atlases come from an image model, so their sprites are not on a grid that
 * divides evenly. `tools/measure-atlas.mjs` finds each sprite by its own pixels
 * and writes these numbers into `frames.ts`. Nothing at run time may divide an
 * atlas by a row or column count.
 */
export interface AtlasFrame {
  x: number
  y: number
  w: number
  h: number
  /** Movement inside the clip, in source pixels, with the layout pitch removed. */
  ox: number
  /**
   * Pixels from the top of this frame down to the line it stands on.
   *
   * The line is the sole of the figure in column 0, the pose it rests in. Thus
   * a figure at rest always has its feet on the ground, and a pose that lunges
   * lower reaches below the line instead of lifting everything else off it.
   */
  oy: number
}

export interface AtlasBox {
  x: number
  y: number
  w: number
  h: number
}

export interface AtlasLayout {
  /** The width a cell must have to hold any frame, with its `ox` either way. */
  unitW: number
  /** How far the tallest frame reaches above the line it stands on. */
  unitAbove: number
  /** How far the deepest frame hangs below that line, such as a sword tip. */
  unitBelow: number
  /** `rows[row][col]`, in the order they appear in the atlas. */
  rows: AtlasFrame[][]
  /** Sprites that are not frames, such as the warrior portrait. */
  extras: Record<string, AtlasBox | undefined>
}

export type AtlasFrames = Record<'enemies' | 'support', AtlasLayout>

/**
 * A character sheet this project composed itself.
 *
 * `tools/build-character-atlas.mjs` lays these out on a grid it chooses, at the
 * size the game draws at, with one row for each facing in the order
 * `facingToDir` numbers them. Thus the runtime blits a cell straight to the
 * screen: no measuring, no scaling, and no resampling of the art every frame.
 *
 * These numbers are the tool's output. `preloadArt` checks the image against
 * them, so a rebuild that changes the grid fails at start-up instead of
 * drawing every frame at the wrong offset.
 */
export interface CharacterSheetDef {
  atlas: 'warriorSheet' | 'wolfSheet'
  cellW: number
  cellH: number
  columns: number
  /** The row a figure's feet rest on, and where the entity's position sits. */
  anchorY: number
}

/** Every character sheet has 8 rows, one for each facing. */
export const FACING_ROWS = 8

export const CHARACTER_SHEETS = {
  warrior: { atlas: 'warriorSheet', cellW: 62, cellH: 65, columns: 7, anchorY: 63 },
  wolf: { atlas: 'wolfSheet', cellW: 102, cellH: 42, columns: 6, anchorY: 40 },
} as const satisfies Record<string, CharacterSheetDef>

export type CharacterSheetId = keyof typeof CHARACTER_SHEETS

export const ASSET_MANIFEST = [
  { id: 'warriorSheet', src: '/assets/generated/warrior-atlas-8dir.png', width: 434, height: 520, required: true },
  { id: 'wolfSheet', src: '/assets/generated/wolf-atlas-8dir.png', width: 612, height: 336, required: true },
  { id: 'portrait', src: '/assets/generated/warrior-portrait.png', width: 154, height: 147, required: true },
  { id: 'enemies', src: '/assets/generated/enemy-atlas.png', width: 1402, height: 1122, required: true },
  { id: 'support', src: '/assets/generated/support-atlas.png', width: 1536, height: 1024, required: true },
  { id: 'terrain', src: '/assets/generated/terrain-atlas.png', width: 1254, height: 1254, required: true },
] as const satisfies readonly AtlasAsset[]

export type AtlasId = (typeof ASSET_MANIFEST)[number]['id']
