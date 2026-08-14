import { ATLAS_FRAMES } from '../assets/frames'
import {
  ASSET_MANIFEST,
  BEAST_GEOMETRY,
  BEAST_SHEET_IDS,
  CHARACTER_SHEETS,
  FACING_ROWS,
  type AtlasFrame,
  type AtlasId,
  type AtlasLayout,
  type BeastSheetId,
  type CharacterSheetId,
  type IconKind,
  type NpcSpriteId,
} from '../assets/types'
import type { Sheet } from './pixel'

export type Prop = HTMLCanvasElement

export interface Art {
  warrior: Sheet
  beasts: Record<BeastSheetId, Sheet>
  props: Record<string, Prop[]>
  npcs: Record<NpcSpriteId, Prop>
  corpses: Record<string, HTMLCanvasElement>
  terrainAtlas: HTMLImageElement
}

export class AssetLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetLoadError'
  }
}

type Images = Record<AtlasId, HTMLImageElement>
let images: Images | null = null
const iconCache = new Map<string, string>()

/**
 * How tall a beast stands above its feet, in art pixels, before its own scale.
 *
 * This keeps the species the size the balance was tuned against. The cell is
 * then this, plus whatever the deepest pose hangs below the feet.
 */
const BEAST_STANDING_H = 49

export async function preloadArt(): Promise<Art> {
  const entries = await Promise.all(
    ASSET_MANIFEST.map(async (asset) => {
      const image = await loadImage(asset.src)
      if (image.naturalWidth !== asset.width || image.naturalHeight !== asset.height) {
        throw new AssetLoadError(
          `${asset.id} atlas has size ${image.naturalWidth}x${image.naturalHeight}; expected ${asset.width}x${asset.height}.`,
        )
      }
      return [asset.id, image] as const
    }),
  )
  images = Object.fromEntries(entries) as Images
  return buildArt(images)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new AssetLoadError(`Required asset did not load: ${src}`))
    image.src = src
  })
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const ctx = out.getContext('2d')
  if (!ctx) throw new AssetLoadError('A 2D canvas is required to prepare art.')
  ctx.imageSmoothingEnabled = false
  return out
}

/** The measured frame at a place in an atlas. Missing means the table is stale. */
function frameAt(layout: AtlasLayout, row: number, col: number): AtlasFrame {
  const frame = layout.rows[row]?.[col]
  if (!frame) throw new AssetLoadError(`No measured frame at row ${row}, column ${col}.`)
  return frame
}

/** A cell holds the figure standing, plus whatever hangs below its feet. */
function cellOf(layout: AtlasLayout, standingH: number) {
  const scale = standingH / layout.unitAbove
  return {
    scale,
    /** Even, so the centre of the cell lands on a whole pixel. */
    fw: Math.ceil((layout.unitW * scale) / 2) * 2,
    fh: standingH + 1 + Math.round(layout.unitBelow * scale),
    /** The row the feet rest on. `blitFrame` puts this at the entity's y. */
    anchorY: standingH,
  }
}

/**
 * Draws one measured frame into one cell.
 *
 * `oy` is the distance from the top of the frame to the line it stands on, so
 * the feet land on `anchorY` in every pose and in every facing. `ox` is the
 * movement inside the clip.
 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  frame: AtlasFrame,
  scale: number,
  cellX: number,
  cellY: number,
  cellW: number,
  anchorY: number,
  mirror = false,
  lift = 0,
) {
  // Round each edge on its own and take the size from the difference. Rounding
  // a size instead lets the parity of the height decide whether the sole lands
  // on the contact line or one pixel above it, and the figure then flutters by
  // a pixel as the player turns. This is the rule `render/pixel.ts` follows.
  const centreX = cellW / 2 + frame.ox * scale
  const left = Math.round(centreX - (frame.w * scale) / 2)
  const top = anchorY - Math.round(frame.oy * scale) - lift
  const bottom = anchorY + Math.round((frame.h - 1 - frame.oy) * scale) - lift
  const w = Math.max(1, Math.round(centreX + (frame.w * scale) / 2) - left)
  const h = Math.max(1, bottom - top + 1)
  const dx = left
  const dy = top
  if (!mirror) {
    ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, cellX + dx, cellY + dy, w, h)
    return
  }
  // Reflecting the whole cell flips `ox` with the art, so a mirrored walk sways
  // the correct way.
  ctx.save()
  ctx.translate(cellX + cellW, cellY)
  ctx.scale(-1, 1)
  ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, dx, dy, w, h)
  ctx.restore()
}

/**
 * A beast carries nothing, so a mirror costs it nothing. It is drawn once from
 * the side facing right, and the octants that face west use that pose flipped.
 */
const BEAST_MIRRORED: readonly boolean[] = [
  false, // S
  true, // W
  false, // E
  false, // N
  false, // SE
  true, // SW
  false, // NE
  true, // NW
]

/**
 * Wraps a composed character atlas as a sheet.
 *
 * Nothing is cut, scaled or redrawn. The tool already laid the grid out at the
 * size the game draws at, with the feet of every frame on `anchorY` and one row
 * for each facing, so the image is the sheet.
 */
function composedSheet(id: CharacterSheetId, loaded: Images): Sheet {
  const def = CHARACTER_SHEETS[id]
  const image = loaded[def.atlas]
  const width = def.cellW * def.columns
  const height = def.cellH * FACING_ROWS
  if (image.naturalWidth !== width || image.naturalHeight !== height) {
    throw new AssetLoadError(
      `${id} sheet is ${image.naturalWidth}x${image.naturalHeight}; ` +
        `${def.columns} x ${FACING_ROWS} cells of ${def.cellW}x${def.cellH} need ${width}x${height}. ` +
        'Run npm run atlas:characters and update CHARACTER_SHEETS.',
    )
  }
  return {
    cv: image,
    fw: def.cellW,
    fh: def.cellH,
    cols: def.columns,
    rows: FACING_ROWS,
    anchorY: def.anchorY,
    directional: true,
  }
}

const BEAST_ROW: Record<BeastSheetId, number> = {
  wolf: 0, alphaWolf: 0, greytooth: 0,
  bear: 1, elderBear: 1, stonebrow: 1,
  boar: 2, ironhideBoar: 2, thornfellSow: 2,
  spider: 3, broodmother: 3, mirefenWidow: 3,
  corvid: 4, stormcrow: 4, gallowsKing: 4,
}

const ELITE_SHEETS: readonly BeastSheetId[] = ['alphaWolf', 'elderBear', 'ironhideBoar', 'broodmother', 'stormcrow']
const APEX_SHEETS: readonly BeastSheetId[] = ['greytooth', 'stonebrow', 'thornfellSow', 'mirefenWidow', 'gallowsKing']

/** Each species row holds three pairs of columns: ordinary, elite, then apex. */
function beastVariant(id: BeastSheetId): 0 | 1 | 2 {
  if (ELITE_SHEETS.includes(id)) return 1
  if (APEX_SHEETS.includes(id)) return 2
  return 0
}

/**
 * The enemy atlas holds two poses for each beast, an idle and an attack. It
 * holds no walk cycle, so columns 0 to 3 are the idle with a one pixel bob and
 * the animation cannot do better than that until the art has real frames.
 */
function beastSheet(image: HTMLImageElement, id: BeastSheetId): Sheet {
  const layout = ATLAS_FRAMES.enemies
  const geometry = BEAST_GEOMETRY[id]
  const { scale, fw, fh, anchorY } = cellOf(
    layout,
    Math.round(BEAST_STANDING_H * geometry.renderScale),
  )
  const cols = 6
  const out = canvas(fw * cols, fh * BEAST_MIRRORED.length)
  const ctx = out.getContext('2d')!
  const row = BEAST_ROW[id]
  const idleCol = beastVariant(id) * 2
  const bobHeight = Math.max(1, Math.round(geometry.renderScale))
  BEAST_MIRRORED.forEach((mirror, dir) => {
    for (let col = 0; col < cols; col++) {
      const attacking = col >= 4
      const frame = frameAt(layout, row, attacking ? idleCol + 1 : idleCol)
      const lift = attacking ? 0 : (col % 2) * bobHeight
      drawFrame(ctx, image, frame, scale, col * fw, dir * fh, fw, anchorY, mirror, lift)
    }
  })
  return { cv: out, fw, fh, cols, rows: BEAST_MIRRORED.length, anchorY, directional: false }
}

/**
 * A prop is one sprite on its own, so it is cropped to its own pixels and
 * scaled by its true aspect. Naming a width and a height separately, as the
 * code before this did, stretched a tall flame into a square.
 */
function propFrom(image: HTMLImageElement, row: number, col: number, height: number): Prop {
  const frame = frameAt(ATLAS_FRAMES.support, row, col)
  const scale = height / frame.h
  const width = Math.max(1, Math.round(frame.w * scale))
  const out = canvas(width, height)
  out.getContext('2d')!.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, width, height)
  return out
}

/**
 * Where each prop lives in the support atlas, with the height it draws at.
 *
 * Row 1 holds seven props, not six. The code before this assumed six even
 * columns, so every name in that row pointed one place to the left: the pine
 * drew a dead tree, the oak drew a pine, and the dead tree drew a standing
 * stone.
 */
const PROP_CELLS: Record<string, { row: number; col: number; height: number }> = {
  tent: { row: 0, col: 3, height: 92 },
  campfire: { row: 0, col: 4, height: 72 },
  chest: { row: 0, col: 5, height: 72 },
  banner: { row: 1, col: 0, height: 94 },
  crate: { row: 1, col: 1, height: 62 },
  barrel: { row: 1, col: 2, height: 62 },
  cairn: { row: 1, col: 3, height: 76 },
  pillar: { row: 1, col: 3, height: 96 },
  deadTree: { row: 1, col: 4, height: 122 },
  stump: { row: 1, col: 4, height: 48 },
  pine: { row: 1, col: 5, height: 122 },
  pineSnow: { row: 1, col: 5, height: 122 },
  oak: { row: 1, col: 6, height: 128 },
  boulder: { row: 2, col: 0, height: 48 },
  rock: { row: 2, col: 0, height: 36 },
}

/** Props with no art of their own borrow the rock rather than go missing. */
const PROP_FALLBACKS = ['bush', 'bones', 'flower', 'tuft', 'mushroom', 'signpost', 'stake']

function supportArt(image: HTMLImageElement): Pick<Art, 'props' | 'npcs'> {
  const props: Record<string, Prop[]> = {}
  for (const [name, cell] of Object.entries(PROP_CELLS)) {
    props[name] = [propFrom(image, cell.row, cell.col, cell.height)]
  }
  const fallback = props.rock![0]!
  for (const name of PROP_FALLBACKS) props[name] = [fallback]
  return { props, npcs: { warden: propFrom(image, 0, 0, 92) } }
}

function makeCorpse(sheet: Sheet): HTMLCanvasElement {
  const out = canvas(sheet.fw, Math.max(14, Math.round(sheet.fh * 0.45)))
  const ctx = out.getContext('2d')!
  ctx.globalAlpha = 0.72
  ctx.drawImage(sheet.cv, 0, sheet.fh * 2, sheet.fw, sheet.fh, 0, 0, out.width, out.height)
  return out
}

/** Species that have a composed 8-facing sheet of their own. */
const COMPOSED_BEASTS: Partial<Record<BeastSheetId, CharacterSheetId>> = { wolf: 'wolf' }

function buildArt(loaded: Images): Art {
  const beasts = {} as Record<BeastSheetId, Sheet>
  const corpses: Record<string, HTMLCanvasElement> = {}
  for (const id of BEAST_SHEET_IDS) {
    const composed = COMPOSED_BEASTS[id]
    const sheet = composed ? composedSheet(composed, loaded) : beastSheet(loaded.enemies, id)
    beasts[id] = sheet
    corpses[id] = makeCorpse(sheet)
  }
  const support = supportArt(loaded.support)
  return {
    warrior: composedSheet('warrior', loaded),
    beasts,
    corpses,
    terrainAtlas: loaded.terrain,
    ...support,
  }
}

/** The icons share a row, and one scale across it keeps their sizes relative. */
const ICON_ROW = 4

const ICON_COLUMN: Record<IconKind, number> = {
  sword: 0, axe: 1, mace: 1, helm: 2, chest: 3, gloves: 4,
  boots: 5, ring: 6, coin: 6, pelt: 3,
}

const ABILITY_COLUMN = { whirlwind: 7, secondwind: 8 } as const

function iconUnit(): number {
  const row = ATLAS_FRAMES.support.rows[ICON_ROW]
  if (!row?.length) throw new AssetLoadError('The support atlas has no measured icon row.')
  return Math.max(...row.map((f) => Math.max(f.w, f.h)))
}

/**
 * Renders one icon into a square, scaled by one factor on both axes.
 *
 * The icons are not on an even pitch. The two ability discs are the widest in
 * the row, so dividing the atlas by the column count cut their left edge off
 * and let the neighbouring disc bleed in on the right. Squeezing the resulting
 * oblong into a square then turned a round disc into an oval.
 */
function iconSquare(col: number, side: number): HTMLCanvasElement {
  const frame = frameAt(ATLAS_FRAMES.support, ICON_ROW, col)
  const scale = side / iconUnit()
  const w = Math.max(1, Math.round(frame.w * scale))
  const h = Math.max(1, Math.round(frame.h * scale))
  const out = canvas(side, side)
  out
    .getContext('2d')!
    .drawImage(
      images!.support,
      frame.x, frame.y, frame.w, frame.h,
      Math.round((side - w) / 2), Math.round((side - h) / 2), w, h,
    )
  return out
}

export function itemIcon(kind: IconKind, rarity: number): string {
  const key = `${kind}:${rarity}`
  const hit = iconCache.get(key)
  if (hit) return hit
  if (!images) return ''
  const side = 64
  const out = iconSquare(ICON_COLUMN[kind], side)
  const ctx = out.getContext('2d')!
  const trim = ['#9aa3b2', '#62c46a', '#4e9df5', '#b064e8', '#f0913a'][rarity] ?? '#9aa3b2'
  ctx.strokeStyle = trim
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, side - 2, side - 2)
  const url = out.toDataURL('image/png')
  iconCache.set(key, url)
  return url
}

export function abilityIcon(id: 'whirlwind' | 'secondwind'): string {
  const key = `ability:${id}`
  const hit = iconCache.get(key)
  if (hit) return hit
  if (!images) return ''
  const url = iconSquare(ABILITY_COLUMN[id], 96).toDataURL('image/png')
  iconCache.set(key, url)
  return url
}

export function warriorPortrait(): string {
  const key = 'portrait'
  const hit = iconCache.get(key)
  if (hit) return hit
  if (!images) return ''
  const image = images.portrait
  const side = 112
  const scale = side / Math.max(image.naturalWidth, image.naturalHeight)
  const w = Math.max(1, Math.round(image.naturalWidth * scale))
  const h = Math.max(1, Math.round(image.naturalHeight * scale))
  const out = canvas(side, side)
  out
    .getContext('2d')!
    .drawImage(image, Math.round((side - w) / 2), Math.round((side - h) / 2), w, h)
  const url = out.toDataURL('image/png')
  iconCache.set(key, url)
  return url
}
