/**
 * Every pixel of art in the game is generated here at boot — there are no
 * image files. Sprites are built from parametric body parts (torso, haunch,
 * snout, legs...) so a wolf and a bear come out of the same routine with
 * different numbers, and elite variants are the same body at a bigger scale
 * with a different palette.
 */
import { PixelCanvas, buildSheet, type Sheet } from './pixel'

/* ------------------------------------------------------------------ *
 * Palettes
 * ------------------------------------------------------------------ */

const W = {
  skin: '#dda06f',
  skinD: '#ab7247',
  hair: '#3a2a1c',
  steel: '#98a4bb',
  steelL: '#cdd6e6',
  steelD: '#5b6479',
  steelXD: '#39404f',
  leather: '#7c5230',
  leatherD: '#4c3119',
  cloth: '#ab332c',
  clothD: '#6c1e1a',
  gold: '#d8a63c',
  wood: '#7a5533',
  woodD: '#4a3220',
  edge: '#e9eff9',
}

export interface BeastPalette {
  fur: string
  furD: string
  furL: string
  belly: string
  nose: string
  eye: string
  claw: string
}

/* ------------------------------------------------------------------ *
 * Warrior
 * ------------------------------------------------------------------ */

const PW = 34 // frame width
const PH = 42 // frame height
const PGROUND = 39

/** Walk bob and per-leg swing for frames 0..3, plus the 3 attack frames. */
function warriorPose(col: number) {
  const walk = [
    { bob: 0, a: 0, b: 0 },
    { bob: -1, a: -2, b: 2 },
    { bob: 0, a: 0, b: 0 },
    { bob: -1, a: 2, b: -2 },
  ]
  if (col < 4) return { ...walk[col]!, swing: -1, lunge: 0 }
  // 4 = wind up, 5 = strike, 6 = recover
  const atk = [
    { bob: 0, a: -1, b: 1, swing: 0, lunge: -1 },
    { bob: -1, a: 2, b: -2, swing: 1, lunge: 2 },
    { bob: 0, a: 1, b: -1, swing: 2, lunge: 1 },
  ]
  return atk[col - 4]!
}

function drawAxe(c: PixelCanvas, x: number, y: number, angle: 'up' | 'out' | 'down') {
  // Handle runs from the grip outward; the head is a wedge of steel.
  if (angle === 'up') {
    c.px(x, y - 13, 2, 14, W.wood)
    c.px(x, y - 13, 1, 14, W.woodD)
    c.px(x - 3, y - 16, 8, 5, W.steel)
    c.px(x - 3, y - 16, 8, 2, W.steelL)
    c.px(x - 4, y - 15, 2, 3, W.steelL)
    c.px(x + 4, y - 15, 2, 3, W.steelD)
  } else if (angle === 'out') {
    c.px(x, y - 4, 13, 2, W.wood)
    c.px(x, y - 4, 13, 1, W.woodD)
    c.px(x + 11, y - 8, 5, 8, W.steel)
    c.px(x + 11, y - 8, 2, 8, W.steelL)
    c.px(x + 15, y - 7, 1, 6, W.edge)
  } else {
    c.px(x, y - 2, 3, 12, W.wood)
    c.px(x, y - 2, 1, 12, W.woodD)
    c.px(x - 2, y + 8, 7, 5, W.steel)
    c.px(x - 2, y + 11, 7, 2, W.steelD)
    c.px(x - 3, y + 9, 2, 3, W.edge)
  }
}

function warriorLegs(c: PixelCanvas, cx: number, bob: number, a: number, b: number, wide: number) {
  const top = 27 + bob
  const lx = cx - wide
  const rx = cx + wide - 5
  // Greave, then boot. A raised leg is shorter and its boot sits higher.
  const leg = (x: number, off: number) => {
    const len = 7 - Math.abs(off) * 0.5
    c.px(x, top, 5, len, W.steelD)
    c.px(x, top, 2, len, W.steel)
    c.px(x - 1, top + len, 7, 4 - Math.max(0, off) * 0.5, W.leatherD)
    c.px(x - 1, top + len, 7, 2, W.leather)
  }
  leg(lx, a)
  leg(rx, b)
}

function warriorTorso(c: PixelCanvas, cx: number, bob: number, halfW: number) {
  const top = 15 + bob
  const h = 13
  // Chest plate with a highlight down the left edge and a belt at the waist.
  c.blob(cx - halfW, top, halfW * 2, h, W.steel)
  c.px(cx - halfW, top + 1, 3, h - 2, W.steelL)
  c.px(cx + halfW - 3, top + 1, 3, h - 2, W.steelD)
  c.px(cx - halfW, top + h - 4, halfW * 2, 3, W.leather)
  c.px(cx - halfW, top + h - 4, halfW * 2, 1, W.leatherD)
  c.px(cx - 2, top + h - 4, 4, 3, W.gold)
}

/**
 * Head views. 0 = head-on, 2 = profile (facing right), 3 = back of the helm,
 * 4 = three-quarter front turned right, 5 = three-quarter back turned right.
 * The two three-quarter poses are what sell a 45-degree heading: the face is
 * still visible but its features are crowded toward the leading edge.
 */
function warriorHead(c: PixelCanvas, cx: number, bob: number, dir: 0 | 1 | 2 | 3 | 4 | 5) {
  const top = 5 + bob
  // Helm dome. On a turned head the lit side slides toward the leading edge.
  const lean = dir === 4 || dir === 5 ? 1 : 0
  c.blob(cx - 5 + lean, top, 10, 7, W.steel)
  c.px(cx - 5 + lean, top + 1, 2, 5, W.steelL)
  c.px(cx + 3 + lean, top + 1, 2, 5, W.steelD)
  c.px(cx - 6 + lean, top + 5, 12, 2, W.steelD)
  if (dir === 3 || dir === 5) {
    // Back of the head: helm skirt and a tuft of hair.
    c.px(cx - 5 + lean, top + 7, 10, 5, W.steelD)
    c.px(cx - 3 + lean, top + 10, 6, 3, W.hair)
    if (dir === 5) {
      // Turned away but not straight away — a sliver of jaw and cheek guard
      // wraps around the leading side of the helm.
      c.px(cx + 3, top + 7, 3, 4, W.skinD)
      c.px(cx + 2, top + 6, 2, 5, W.steelD)
    }
    c.px(cx - 1 + lean, top - 3, 2, 4, W.cloth)
    return
  }
  // Face
  c.blob(cx - 4 + lean, top + 6, 8, 6, W.skin)
  c.px(cx - 4 + lean, top + 9, 8, 3, W.skinD)
  if (dir === 0) {
    c.px(cx - 1, top + 5, 2, 7, W.steel) // nasal guard
    c.dot(cx - 3, top + 8, '#20242e')
    c.dot(cx + 2, top + 8, '#20242e')
    c.px(cx - 3, top + 11, 6, 1, W.hair)
  } else if (dir === 4) {
    // Three-quarter. The give-away is asymmetry: the far cheek is swallowed by
    // the helm, the far eye is foreshortened to a single pixel tight against
    // the nasal guard, and the near eye stays full width out on the cheek.
    c.px(cx - 4, top + 6, 3, 6, W.steelD)
    c.px(cx, top + 5, 2, 7, W.steel) // nasal guard, pushed to the lead
    c.dot(cx - 1, top + 8, '#20242e')
    c.px(cx + 3, top + 8, 2, 1, '#20242e')
    c.px(cx + 4, top + 9, 2, 2, W.skinD) // jaw corner catching the light
    c.px(cx, top + 11, 4, 1, W.hair)
  } else {
    // Side profile: one eye, jaw shaded toward the back of the head.
    c.px(cx - 5, top + 6, 4, 6, W.steelD)
    c.dot(cx + 2, top + 8, '#20242e')
    c.px(cx + 4, top + 9, 2, 2, W.skinD)
  }
  c.px(cx - 1 + lean, top - 3, 2, 4, W.cloth) // plume
}

function drawWarriorFront(c: PixelCanvas, col: number, back: boolean) {
  const p = warriorPose(col)
  const cx = PW / 2
  warriorLegs(c, cx, p.bob, p.a, p.b, 6)
  // Far arm first so it sits behind the torso.
  c.px(cx + 7, 18 + p.bob, 5, 9, W.steelD)
  warriorTorso(c, cx, p.bob, 8)
  // Pauldrons
  c.blob(cx - 11, 15 + p.bob, 6, 6, W.steel)
  c.px(cx - 11, 15 + p.bob, 6, 2, W.steelL)
  c.blob(cx + 5, 15 + p.bob, 6, 6, W.steel)
  c.px(cx + 5, 15 + p.bob, 6, 2, W.steelL)
  // Near arm + hand
  const armY = 20 + p.bob + (p.swing >= 1 ? -2 : 0)
  c.px(cx - 12, armY, 5, 8, W.steel)
  c.px(cx - 12, armY, 2, 8, W.steelL)
  c.px(cx - 12, armY + 8, 5, 3, W.skin)
  if (back) c.px(cx - 12, armY, 5, 8, W.steelD)
  const grip = { x: cx - 12, y: armY + 9 }
  if (p.swing === -1) drawAxe(c, grip.x - 2, grip.y, 'up')
  else if (p.swing === 0) drawAxe(c, grip.x - 1, grip.y - 4, 'up')
  else if (p.swing === 1) drawAxe(c, grip.x - 6, grip.y + 4, 'down')
  else drawAxe(c, grip.x - 4, grip.y + 2, 'down')
  if (back) {
    // Cloak draped over the shoulders, hiding the plate underneath.
    c.blob(cx - 9, 15 + p.bob, 18, 15, W.clothD)
    c.px(cx - 8, 16 + p.bob, 4, 13, W.cloth)
  }
  warriorHead(c, cx, p.bob, back ? 3 : 0)
}

function drawWarriorSide(c: PixelCanvas, col: number) {
  const p = warriorPose(col)
  const cx = PW / 2 - 1 + p.lunge
  // Back arm
  c.px(cx - 5, 19 + p.bob, 4, 9, W.steelD)
  warriorLegs(c, cx, p.bob, p.a, p.b, 4)
  warriorTorso(c, cx, p.bob, 6)
  // Cloak trailing behind
  c.px(cx - 8, 16 + p.bob, 4, 13, W.clothD)
  c.px(cx - 9, 20 + p.bob, 3, 8, W.cloth)
  // Pauldron
  c.blob(cx - 3, 14 + p.bob, 7, 6, W.steel)
  c.px(cx - 3, 14 + p.bob, 7, 2, W.steelL)
  const armY = 20 + p.bob + (p.swing >= 1 ? 1 : -1)
  c.px(cx + 2, armY, 5, 8, W.steel)
  c.px(cx + 2, armY, 2, 8, W.steelL)
  c.px(cx + 3, armY + 8, 4, 3, W.skin)
  const gx = cx + 5
  const gy = armY + 9
  if (p.swing === -1) drawAxe(c, gx, gy, 'up')
  else if (p.swing === 0) drawAxe(c, gx - 1, gy - 5, 'up')
  else if (p.swing === 1) drawAxe(c, gx, gy - 6, 'out')
  else drawAxe(c, gx - 1, gy - 1, 'down')
  warriorHead(c, cx, p.bob, 2)
}

/**
 * Legs for a three-quarter stance. Straddling the diagonal means one leg is
 * further from the camera than the other, so it sits higher up the frame and
 * is drawn a shade darker — that vertical stagger is most of what reads as
 * "turned 45 degrees" while the character is walking.
 */
function warriorDiagLegs(c: PixelCanvas, cx: number, bob: number, a: number, b: number, nearRight: boolean) {
  const top = 27 + bob
  const leg = (x: number, y: number, off: number, far: boolean) => {
    const len = 7 - Math.abs(off) * 0.5
    c.px(x, y, 5, len, far ? W.steelXD : W.steelD)
    c.px(x, y, 2, len, far ? W.steelD : W.steel)
    c.px(x - 1, y + len, 7, 4 - Math.max(0, off) * 0.5, far ? '#2e1d0e' : W.leatherD)
    c.px(x - 1, y + len, 7, 2, far ? W.leatherD : W.leather)
  }
  const nearX = nearRight ? cx : cx - 5
  const farX = nearRight ? cx - 6 : cx + 1
  leg(farX, top - 2, a, true)
  leg(nearX, top + 1, b, false)
}

/**
 * Chest plate for a turned body. Same silhouette as the head-on torso, but the
 * plate's centre seam is pushed off-centre toward the leading edge and the far
 * side is dropped into shadow — the eye reads that as the chest having rotated
 * away rather than as flat armour.
 */
function warriorDiagTorso(c: PixelCanvas, cx: number, bob: number, tiltY: number) {
  const top = 15 + bob
  const h = 13
  const halfW = 7
  c.blob(cx - halfW, top, halfW * 2, h, W.steel)
  c.px(cx - halfW, top + 1, 4, h - 2, W.steelD) // far side, turned away
  c.px(cx + 1, top + 1, 3, h - 2, W.steelL) // seam catching light off-centre
  c.px(cx + halfW - 2, top + 1, 2, h - 2, W.steel)
  // Belt follows the slant of the hips.
  c.px(cx - halfW, top + h - 4 + tiltY, halfW * 2, 3, W.leather)
  c.px(cx - halfW, top + h - 4 + tiltY, halfW * 2, 1, W.leatherD)
  c.px(cx + 1, top + h - 4 + tiltY, 4, 3, W.gold)
}

/**
 * Three-quarter warrior, heading right and either toward the camera (`back`
 * false, i.e. down-right) or away from it (up-right). Built off the profile
 * rather than the head-on view because the profile already has a leading edge:
 * widening the torso, restoring the trailing shoulder and turning the face
 * back toward the camera rotates it the remaining 45 degrees.
 */
function drawWarriorDiag(c: PixelCanvas, col: number, back: boolean) {
  const p = warriorPose(col)
  const cx = PW / 2 - 1 + p.lunge * 0.7
  const bob = p.bob
  // The shoulder line slants across the heading: whichever shoulder is further
  // from the camera rides higher up the frame. Heading up-screen flips it.
  const lead = back ? -2 : 2
  // Trailing arm, tucked behind the torso on the far side.
  c.px(cx - 7, 19 + bob - lead, 5, 9, W.steelD)
  warriorDiagLegs(c, cx, bob, p.a, p.b, back)
  warriorDiagTorso(c, cx, bob, back ? -1 : 1)
  if (back) {
    // Cloak hangs across the shoulders, skewed off the trailing side.
    c.blob(cx - 9, 15 + bob, 16, 15, W.clothD)
    c.px(cx - 8, 16 + bob, 4, 13, W.cloth)
  } else {
    // Only the trailing edge of the cloak clears the body.
    c.px(cx - 9, 16 + bob, 4, 13, W.clothD)
    c.px(cx - 10, 20 + bob, 3, 8, W.cloth)
  }
  // Far pauldron: smaller, darker, and offset up the slant.
  c.blob(cx - 10, 15 + bob - lead, 6, 6, W.steelD)
  c.px(cx - 10, 15 + bob - lead, 6, 2, W.steel)
  // Near pauldron leads the turn.
  c.blob(cx - 1, 15 + bob + lead, 8, 7, W.steel)
  c.px(cx - 1, 15 + bob + lead, 8, 2, W.steelL)
  // Leading arm + axe, reaching out along the heading.
  const armY = 21 + bob + lead + (p.swing >= 1 ? 1 : -1)
  c.px(cx + 4, armY, 5, 8, W.steel)
  c.px(cx + 4, armY, 2, 8, W.steelL)
  c.px(cx + 5, armY + 8, 4, 3, W.skin)
  const gx = cx + 7
  const gy = armY + 9
  if (p.swing === -1) drawAxe(c, gx, gy, 'up')
  else if (p.swing === 0) drawAxe(c, gx - 1, gy - 5, 'up')
  else if (p.swing === 1) drawAxe(c, gx, gy - 6, 'out')
  else drawAxe(c, gx - 1, gy - 1, 'down')
  warriorHead(c, cx + 1, bob, back ? 5 : 4)
}

/**
 * Every sheet uses the eight rows of `facingToDir`, and only ever authors the
 * five right-facing poses: west, south-west and north-west are their eastern
 * counterparts flipped. Shared by the warrior and beast sheets.
 */
const MIRRORED_ROWS = new Set([1, 5, 7])

export function makeWarriorSheet(): Sheet {
  return buildSheet(PW, PH, 8, 7, PGROUND, (c, row, col) => {
    c.ctx.save()
    if (MIRRORED_ROWS.has(row)) {
      c.ctx.translate(c.w, 0)
      c.ctx.scale(-1, 1)
    }
    if (row === 0) drawWarriorFront(c, col, false)
    else if (row === 3) drawWarriorFront(c, col, true)
    else if (row === 1 || row === 2) drawWarriorSide(c, col)
    else if (row === 4 || row === 5) drawWarriorDiag(c, col, false)
    else drawWarriorDiag(c, col, true)
    c.ctx.restore()
  })
}

/* ------------------------------------------------------------------ *
 * Beasts (wolf / bear, and their elite variants)
 * ------------------------------------------------------------------ */

export interface BeastSpec {
  fw: number
  fh: number
  ground: number
  /** Side-view body box. */
  bodyX: number
  bodyLen: number
  bodyY: number
  bodyH: number
  haunchR: number
  chestR: number
  headR: number
  headX: number
  headY: number
  snout: number
  ear: 'point' | 'round'
  earSize: number
  legLen: number
  legW: number
  tail: 'bushy' | 'stub'
  hump: boolean
  frontW: number
  pal: BeastPalette
}

export const WOLF_SPEC: BeastSpec = {
  fw: 46,
  fh: 34,
  ground: 31,
  bodyX: 9,
  bodyLen: 23,
  bodyY: 13,
  bodyH: 8,
  haunchR: 6,
  chestR: 5,
  headR: 5,
  headX: 36,
  headY: 12,
  snout: 6,
  ear: 'point',
  earSize: 4,
  legLen: 9,
  legW: 3,
  tail: 'bushy',
  hump: false,
  frontW: 8,
  pal: {
    fur: '#6f7688',
    furD: '#454b5b',
    furL: '#99a1b3',
    belly: '#c6ccd8',
    nose: '#191b22',
    eye: '#f2c14e',
    claw: '#e2e6ee',
  },
}

export const BEAR_SPEC: BeastSpec = {
  fw: 58,
  fh: 44,
  ground: 41,
  bodyX: 10,
  bodyLen: 30,
  bodyY: 15,
  bodyH: 13,
  haunchR: 9,
  chestR: 8,
  headR: 7,
  headX: 45,
  headY: 15,
  snout: 6,
  ear: 'round',
  earSize: 4,
  legLen: 11,
  legW: 5,
  tail: 'stub',
  hump: true,
  frontW: 12,
  pal: {
    fur: '#6d4a2e',
    furD: '#48301d',
    furL: '#8f6941',
    belly: '#a57d51',
    nose: '#231a12',
    eye: '#f0d089',
    claw: '#efe8d4',
  },
}

export const ALPHA_WOLF_PAL: BeastPalette = {
  fur: '#3f4358',
  furD: '#272a3b',
  furL: '#6c7391',
  belly: '#8d93a8',
  nose: '#12131a',
  eye: '#ff6a3d',
  claw: '#fbe9d2',
}

export const ELDER_BEAR_PAL: BeastPalette = {
  fur: '#4e443a',
  furD: '#332c25',
  furL: '#8b8073',
  belly: '#9a8f7f',
  nose: '#1a1510',
  eye: '#ff8a3c',
  claw: '#fff3dc',
}

/** Frame 0..3 walk, 4..5 lunge/bite. */
function beastPose(col: number) {
  const walk = [
    { bob: 0, fa: 0, fb: 0, ba: 0, bb: 0, lunge: 0, head: 0, mouth: 0 },
    { bob: -1, fa: 2, fb: -2, ba: -2, bb: 2, lunge: 0, head: 0, mouth: 0 },
    { bob: 0, fa: 0, fb: 0, ba: 0, bb: 0, lunge: 0, head: 0, mouth: 0 },
    { bob: -1, fa: -2, fb: 2, ba: 2, bb: -2, lunge: 0, head: 0, mouth: 0 },
  ]
  if (col < 4) return walk[col]!
  const atk = [
    { bob: -1, fa: -2, fb: -2, ba: 1, bb: 1, lunge: -2, head: -2, mouth: 1 },
    { bob: 1, fa: 3, fb: 3, ba: -1, bb: -1, lunge: 3, head: 1, mouth: 2 },
  ]
  return atk[col - 4]!
}

function beastLeg(c: PixelCanvas, s: BeastSpec, x: number, top: number, off: number, dark: boolean) {
  const len = s.legLen - Math.abs(off) * 0.4
  c.px(x, top, s.legW, len, dark ? s.pal.furD : s.pal.fur)
  c.px(x, top + len - 2, s.legW + 1, 2, dark ? s.pal.furD : s.pal.furL)
  c.px(x + s.legW - 1, top + len - 1, 2, 1, s.pal.claw)
}

function drawBeastSide(c: PixelCanvas, s: BeastSpec, col: number) {
  const p = beastPose(col)
  const P = s.pal
  const bodyTop = s.bodyY + p.bob
  const bodyCY = bodyTop + s.bodyH / 2
  const legTop = bodyTop + s.bodyH - 1
  const rearX = s.bodyX + p.lunge * 0.3
  const frontX = s.bodyX + s.bodyLen + p.lunge

  // Tail
  if (s.tail === 'bushy') {
    c.oval(rearX - 4, bodyCY - 2, 6, 4, P.furD)
    c.oval(rearX - 5, bodyCY - 3, 4, 3, P.fur)
  } else {
    c.oval(rearX - 1, bodyCY - 2, 3, 3, P.furD)
  }

  // Far legs (drawn dark, behind the body)
  beastLeg(c, s, rearX + 2, legTop, p.ba, true)
  beastLeg(c, s, frontX - s.legW - 3, legTop, p.fa, true)

  // Torso: haunch + barrel + chest reads as one animal
  c.oval(rearX + s.haunchR - 1, bodyCY, s.haunchR, s.bodyH / 2 + 1, P.fur)
  c.px(rearX + 2, bodyTop, s.bodyLen - 4, s.bodyH, P.fur)
  c.oval(frontX - s.chestR, bodyCY, s.chestR, s.bodyH / 2 + 1, P.fur)
  if (s.hump) c.oval(frontX - s.chestR - 2, bodyTop, s.chestR, 4, P.furL)
  // Top light, belly light
  c.px(rearX + 3, bodyTop, s.bodyLen - 6, 2, P.furL)
  c.px(rearX + 4, bodyTop + s.bodyH - 2, s.bodyLen - 9, 2, P.belly)

  // Near legs
  beastLeg(c, s, rearX + 5, legTop, p.bb, false)
  beastLeg(c, s, frontX - s.legW - 1, legTop, p.fb, false)

  // Neck + head
  const hx = s.headX + p.lunge
  const hy = s.headY + p.bob + p.head
  c.px(frontX - 5, hy + 2, 7, s.bodyH - 1, P.fur)
  c.oval(hx, hy, s.headR, s.headR - 0.5, P.fur)
  c.oval(hx, hy - s.headR * 0.4, s.headR - 1, s.headR * 0.5, P.furL)

  // Ears
  if (s.ear === 'point') {
    c.cone(hx - 2, hy - s.headR - s.earSize + 1, 4, s.earSize, P.furD)
    c.cone(hx + 2, hy - s.headR - s.earSize + 1, 4, s.earSize, P.fur)
  } else {
    c.oval(hx - 2, hy - s.headR + 1, s.earSize / 2, s.earSize / 2, P.furD)
    c.oval(hx + 3, hy - s.headR + 1, s.earSize / 2, s.earSize / 2, P.fur)
  }

  // Snout + jaw. Attack frames open the mouth.
  const sx = hx + s.headR - 1
  c.px(sx, hy - 1, s.snout, 4, P.furL)
  c.px(sx + s.snout - 2, hy - 1, 2, 2, P.nose)
  if (p.mouth > 0) {
    c.px(sx, hy + 3 + p.mouth, s.snout - 1, 2, P.furD)
    c.px(sx + 1, hy + 2, 2, 2, '#f4f0e6')
    c.px(sx + 1, hy + 3 + p.mouth, 2, 1, '#f4f0e6')
    c.px(sx - 1, hy + 2, 2, 2 + p.mouth, '#2a1620')
  }
  // Eye
  c.px(hx + 1, hy - 2, 2, 2, P.eye)
  c.dot(hx + 2, hy - 2, P.nose)
}

function drawBeastFacing(c: PixelCanvas, s: BeastSpec, col: number, back: boolean) {
  const p = beastPose(col)
  const P = s.pal
  const cx = s.fw / 2
  const bodyTop = s.bodyY + 2 + p.bob
  const bodyH = s.bodyH + 4
  const legTop = bodyTop + bodyH - 2
  const fw = s.frontW

  // Rear legs peeking out at the sides
  beastLeg(c, s, cx - fw + 1, legTop - 2, p.ba, true)
  beastLeg(c, s, cx + fw - s.legW - 1, legTop - 2, p.bb, true)

  // Barrel
  c.oval(cx, bodyTop + bodyH / 2, fw, bodyH / 2 + 1, P.fur)
  c.px(cx - fw + 2, bodyTop, fw * 2 - 4, 2, P.furL)
  if (!back) c.oval(cx, bodyTop + bodyH - 2, fw - 3, 3, P.belly)
  else c.oval(cx, bodyTop + 2, fw - 4, 3, P.furL)

  // Front legs
  beastLeg(c, s, cx - fw + 3, legTop, p.fa, false)
  beastLeg(c, s, cx + fw - s.legW - 3, legTop, p.fb, false)

  const hy = s.headY + p.bob + p.head + (back ? 1 : -1)
  if (back) {
    // Rear view: haunches, tail, and the back of the ears.
    if (s.tail === 'bushy') c.oval(cx, hy + 4, 4, 6, P.furD)
    else c.oval(cx, hy + 3, 3, 3, P.furD)
    c.oval(cx, hy, s.headR - 1, s.headR - 2, P.fur)
    if (s.ear === 'point') {
      c.cone(cx - s.headR + 1, hy - s.headR, 4, s.earSize, P.furD)
      c.cone(cx + s.headR - 1, hy - s.headR, 4, s.earSize, P.furD)
    } else {
      c.oval(cx - s.headR + 1, hy - s.headR + 2, s.earSize / 2, s.earSize / 2, P.furD)
      c.oval(cx + s.headR - 1, hy - s.headR + 2, s.earSize / 2, s.earSize / 2, P.furD)
    }
    return
  }

  // Head-on
  c.oval(cx, hy, s.headR + 1, s.headR, P.fur)
  c.oval(cx, hy - 2, s.headR, s.headR * 0.5, P.furL)
  if (s.ear === 'point') {
    c.cone(cx - s.headR, hy - s.headR - s.earSize + 2, 4, s.earSize, P.fur)
    c.cone(cx + s.headR, hy - s.headR - s.earSize + 2, 4, s.earSize, P.fur)
  } else {
    c.oval(cx - s.headR, hy - s.headR + 2, s.earSize / 2 + 0.5, s.earSize / 2 + 0.5, P.fur)
    c.oval(cx + s.headR, hy - s.headR + 2, s.earSize / 2 + 0.5, s.earSize / 2 + 0.5, P.fur)
  }
  // Muzzle
  c.oval(cx, hy + s.headR - 1, s.headR - 2, 2.5, P.furL)
  c.px(cx - 1, hy + s.headR - 3, 2, 2, P.nose)
  if (p.mouth > 0) {
    c.px(cx - 3, hy + s.headR, 6, 2 + p.mouth, '#2a1620')
    c.px(cx - 3, hy + s.headR, 2, 2, '#f4f0e6')
    c.px(cx + 1, hy + s.headR, 2, 2, '#f4f0e6')
  }
  // Eyes
  c.px(cx - s.headR + 1, hy - 1, 2, 2, P.eye)
  c.px(cx + s.headR - 2, hy - 1, 2, 2, P.eye)
}

/**
 * Three-quarter beast, heading right and either toward the camera (`back`
 * false, i.e. down-right) or away from it (up-right).
 *
 * The spine is laid along a diagonal — rump at the trailing corner, head at
 * the leading one — and foreshortened to about half its profile length. A
 * geometrically honest projection would barely tilt at all (the head-on view
 * squashes the whole body into two pixels of depth), so the rise here is
 * deliberately exaggerated: without it a diagonal is indistinguishable from a
 * short side view. The feet spread less than the spine does, since splayed
 * legs converge toward the ground.
 */
function drawBeastDiag(c: PixelCanvas, s: BeastSpec, col: number, back: boolean) {
  const p = beastPose(col)
  const P = s.pal
  const cx = s.fw / 2
  const len = s.bodyLen * 0.5
  const rise = s.bodyLen * 0.13
  const legRise = rise * 0.6
  const sign = back ? -1 : 1 // +1 puts the head at the bottom of the frame
  const nearSide = back ? 1 : -1 // side of the spine that faces the camera
  const flank = s.frontW * 0.95 // legs sit this far apart across the spine
  const hip = s.bodyH * 0.42
  // Anchor from the feet up: the near leg at the low end of the spine is the
  // one that has to land on the ground line.
  const cy = s.ground - s.legLen - 2 - hip - legRise + p.bob
  const hx = cx + len / 2 + p.lunge * 0.55
  const hy = cy + rise * sign
  const rx = cx - len / 2 - p.lunge * 0.2
  const ry = cy - rise * sign

  /**
   * One leg, splayed off the spine at horizontal position `ex`. `endRise` is
   * the spine's own rise at that end; the legs take a damped share of it so
   * the feet stay closer together than the shoulders do. The far legs go down
   * before the body and the near ones after, or a dark far leg paints itself
   * across the animal's back.
   */
  const leg = (ex: number, endRise: number, off: number, far: boolean) => {
    const top = cy + endRise * (legRise / rise) * sign + hip
    // The far pair is set wide enough to clear the barrel's silhouette; tucked
    // any closer they vanish entirely and the animal reads as two-legged.
    const out = far ? -nearSide * flank * 0.75 : nearSide * flank * 0.42
    beastLeg(c, s, ex + out - s.legW / 2, top - (far ? 2 : 0), off, far)
  }
  const tail = () => {
    // Clear of the haunch, or the barrel swallows it whole.
    const tx = rx - s.haunchR - 2
    const ty = ry - rise * sign * 0.4
    if (s.tail === 'bushy') {
      c.oval(tx, ty, 5, 4, P.furD)
      c.oval(tx - 1, ty - sign, 3, 3, P.fur)
    } else {
      c.oval(tx + 3, ty, 3, 3, P.furD)
    }
  }
  const head = () => {
    // Thrown clear of the shoulder along the heading so the skull reads as a
    // separate mass rather than merging into the barrel.
    const hcx = hx + s.headR * 1.25
    const hcy = hy + (s.headR * 0.8 + p.head) * sign
    c.oval((hx + hcx) / 2, (hy + hcy) / 2, s.chestR * 0.72, s.bodyH * 0.42, P.fur)
    c.oval(hcx, hcy, s.headR, s.headR - 0.5, P.fur)
    // Ears ride the dome, not the shoulders — set them out at the skull's full
    // radius and the far one detaches into a dark blob on the animal's back.
    if (s.ear === 'point') {
      c.cone(hcx - s.headR * 0.55, hcy - s.headR - s.earSize + 2, 4, s.earSize, P.furD)
      c.cone(hcx + s.headR * 0.5, hcy - s.headR - s.earSize + 2, 4, s.earSize, back ? P.furD : P.fur)
    } else {
      c.oval(hcx - s.headR * 0.6, hcy - s.headR * 0.75, s.earSize / 2, s.earSize / 2, P.furD)
      c.oval(hcx + s.headR * 0.55, hcy - s.headR * 0.8, s.earSize / 2, s.earSize / 2, back ? P.furD : P.fur)
    }
    if (back) {
      // Turned away: skull cap only, with the muzzle just clearing its edge.
      c.oval(hcx, hcy - s.headR * 0.35, s.headR - 1, s.headR * 0.5, P.furL)
      c.oval(hcx + s.headR * 0.75, hcy - s.headR * 0.55, s.snout * 0.3, 1.5, P.furL)
      return
    }
    c.oval(hcx, hcy - s.headR * 0.35, s.headR - 1, s.headR * 0.45, P.furL)
    // Muzzle thrown out along the heading, nose at its tip.
    const mx = hcx + s.headR * 0.7
    const my = hcy + s.headR * 0.6
    c.oval(mx, my, s.snout * 0.48, s.snout * 0.4, P.furL)
    c.px(mx + s.snout * 0.12, my - 1, 2, 2, P.nose)
    if (p.mouth > 0) {
      c.px(mx - 2, my + 1, 5, 2 + p.mouth, '#2a1620')
      c.px(mx - 2, my + 1, 2, 2, '#f4f0e6')
      c.px(mx + 1, my + 1, 2, 2, '#f4f0e6')
    }
    // Both eyes visible, but crowded toward the leading side of the skull and
    // kept tight — spread wide on a small skull they read as headlights.
    c.px(hcx - 2, hcy - 1, 2, 2, P.eye)
    c.dot(hcx - 1, hcy - 1, P.nose)
    c.px(hcx + 1, hcy - 2, 2, 2, P.eye)
    c.dot(hcx + 2, hcy - 2, P.nose)
  }
  const body = () => {
    // Waisted, not a tube: the haunch and chest keep their own mass at either
    // end so the animal doesn't read as one tapered log lying on a slope.
    //
    // Swept rather than stamped: a row of discrete ovals along the spine each
    // round their own extremes, and the union of those roundings is a visibly
    // scalloped back. `sweep` takes the envelope first, so the slanted edge
    // steps once per column.
    const wide = (t: number) =>
      (s.haunchR + (s.chestR - s.haunchR) * t) * (0.82 + 0.24 * Math.abs(t * 2 - 1))
    const tall = (t: number) => s.bodyH * (0.34 + 0.14 * Math.abs(t * 2 - 1)) + 1
    const at = (t: number) => [rx + (hx - rx) * t, ry + (hy - ry) * t] as const
    c.sweep((t) => {
      const [bx, by] = at(t)
      return { x: bx, y: by, rx: wide(t), ry: tall(t) }
    }, P.fur)
    if (s.hump) c.oval(hx - s.chestR * 0.3, hy - sign * 3, s.chestR * 0.9, 3, P.furL)
    // Spine highlight rides the up-frame edge; the belly catches light below.
    // Both are kept to a single scanline — swept along a diagonal, a thicker
    // band smears into a pale wedge across the middle of the animal.
    c.sweep((t) => {
      const [bx, by] = at(t)
      return { x: bx, y: by - tall(t) * 0.52, rx: wide(t) * 0.5, ry: 0.55 }
    }, P.furL)
    if (!back) {
      c.sweep((u) => {
        const t = 0.3 + 0.7 * u
        const [bx, by] = at(t)
        return { x: bx, y: by + tall(t) * 0.6, rx: wide(t) * 0.4, ry: 0.55 }
      }, P.belly)
    }
  }

  // Painter's order down the frame, so near limbs and the leading end overlap
  // correctly: heading away puts the head at the back of the stack.
  if (back) {
    head()
    leg(hx, rise, p.fa, true)
    leg(rx, -rise, p.ba, true)
    body()
    leg(hx, rise, p.fb, false)
    leg(rx, -rise, p.bb, false)
    tail()
  } else {
    tail()
    leg(rx, -rise, p.ba, true)
    leg(hx, rise, p.fa, true)
    body()
    leg(rx, -rise, p.bb, false)
    leg(hx, rise, p.fb, false)
    head()
  }
}

/**
 * Grows a beast by its numbers rather than by a canvas transform. A fractional
 * `ctx.scale` lands every rect edge on a fraction of a pixel, and `fillRect`
 * answers that with anti-aliasing — the elites came out soft-edged, and the
 * outline pass then traced the blur. Redrawing the body parametrically at the
 * larger size keeps every edge on the grid. Radii stay fractional on purpose;
 * only the parts that become rect edges or offsets need whole pixels.
 */
function scaleSpec(s: BeastSpec, k: number): BeastSpec {
  const r = (v: number) => Math.round(v * k)
  return {
    ...s,
    fw: r(s.fw),
    fh: r(s.fh),
    ground: r(s.ground),
    bodyX: r(s.bodyX),
    bodyLen: r(s.bodyLen),
    bodyY: r(s.bodyY),
    bodyH: r(s.bodyH),
    haunchR: s.haunchR * k,
    chestR: s.chestR * k,
    headR: s.headR * k,
    headX: r(s.headX),
    headY: r(s.headY),
    snout: r(s.snout),
    earSize: r(s.earSize),
    legLen: r(s.legLen),
    legW: r(s.legW),
    frontW: r(s.frontW),
  }
}

export function makeBeastSheet(spec: BeastSpec, pal?: BeastPalette, scale = 1): Sheet {
  const base: BeastSpec = pal ? { ...spec, pal } : spec
  const s = scale === 1 ? base : scaleSpec(base, scale)
  return buildSheet(s.fw, s.fh, 8, 6, s.ground, (c, row, col) => {
    c.ctx.save()
    if (MIRRORED_ROWS.has(row)) {
      c.ctx.translate(s.fw, 0)
      c.ctx.scale(-1, 1)
    }
    if (row === 0) drawBeastFacing(c, s, col, false)
    else if (row === 3) drawBeastFacing(c, s, col, true)
    else if (row === 1 || row === 2) drawBeastSide(c, s, col)
    else if (row === 4 || row === 5) drawBeastDiag(c, s, col, false)
    else drawBeastDiag(c, s, col, true)
    c.ctx.restore()
  })
}

/* ------------------------------------------------------------------ *
 * Scenery props — anchored bottom-centre
 * ------------------------------------------------------------------ */

export type Prop = HTMLCanvasElement

function prop(w: number, h: number, draw: (c: PixelCanvas) => void, outline = true): Prop {
  const c = new PixelCanvas(w, h)
  draw(c)
  if (outline) c.outline('#0b0d12')
  return c.cv
}

function pine(snow: boolean): Prop {
  return prop(30, 52, (c) => {
    const dark = snow ? '#1f3b39' : '#1e3a24'
    const mid = snow ? '#2c5450' : '#2c5c33'
    const lit = snow ? '#3d6f68' : '#3e7b42'
    c.px(13, 38, 5, 12, '#4a3220')
    c.px(13, 38, 2, 12, '#63432a')
    // Four skirts of needles, each wider than the one above it.
    for (let i = 0; i < 4; i++) {
      const y = 4 + i * 9
      const halfW = 6 + i * 3
      c.cone(15, y, halfW * 2, 14, dark)
      c.cone(15, y + 2, halfW * 2 - 4, 11, mid)
      c.px(15 - halfW + 2, y + 11, 4, 2, lit)
      if (snow) {
        c.px(15 - halfW + 3, y + 12, halfW, 2, '#dfe9f2')
        c.px(15 + 2, y + 9, 4, 2, '#dfe9f2')
      }
    }
  })
}

function oak(): Prop {
  return prop(38, 46, (c) => {
    c.px(16, 32, 6, 13, '#503620')
    c.px(16, 32, 2, 13, '#6b4a2c')
    c.px(13, 42, 12, 3, '#3d2917')
    c.oval(19, 18, 15, 12, '#25502b')
    c.oval(13, 14, 9, 7, '#357040')
    c.oval(25, 16, 8, 6, '#2e6136')
    c.oval(19, 9, 7, 4, '#428a4c')
    c.oval(11, 24, 5, 4, '#1c3f21')
  })
}

function deadTree(): Prop {
  return prop(30, 46, (c) => {
    c.px(13, 20, 5, 25, '#4b423a')
    c.px(13, 20, 2, 25, '#6a5f53')
    c.line(15, 24, 6, 14, '#574c42', 2)
    c.line(15, 20, 24, 9, '#574c42', 2)
    c.line(24, 9, 27, 5, '#6a5f53', 1)
    c.line(6, 14, 3, 9, '#6a5f53', 1)
    c.line(15, 28, 22, 21, '#4b423a', 2)
  })
}

function bushProp(berries: boolean): Prop {
  return prop(24, 18, (c) => {
    c.oval(12, 12, 11, 6, '#24512c')
    c.oval(8, 9, 6, 4, '#31693a')
    c.oval(16, 10, 5, 4, '#2c5f34')
    c.oval(12, 7, 4, 3, '#3d7f47')
    if (berries) {
      c.dot(7, 9, '#c8404a')
      c.dot(15, 8, '#c8404a')
      c.dot(18, 12, '#c8404a')
    }
  })
}

function rockProp(big: boolean): Prop {
  const w = big ? 34 : 22
  const h = big ? 26 : 16
  return prop(w, h, (c) => {
    c.oval(w / 2, h - 4, w / 2 - 1, h / 2 - 1, '#5a6070')
    c.oval(w / 2 - 2, h - 7, w / 2 - 5, h / 2 - 4, '#767d8f')
    c.px(w / 2 - 4, h - 12, 5, 2, '#8e96a8')
    c.oval(w / 2, h - 2, w / 2 - 2, 2, '#454b58')
  })
}

function stump(): Prop {
  return prop(20, 16, (c) => {
    c.oval(10, 12, 8, 4, '#4a3220')
    c.px(3, 6, 14, 7, '#593d26')
    c.oval(10, 6, 7, 3, '#7a5433')
    c.oval(10, 6, 4, 1.5, '#8f6741')
  })
}

function tent(): Prop {
  return prop(46, 36, (c) => {
    // A-frame: a point at the ridge widening to the ground line.
    c.cone(23, 4, 42, 29, '#7d5f3e')
    c.cone(20, 6, 30, 27, '#9b7850')
    c.cone(16, 9, 16, 24, '#b08a5c')
    // Guy ropes and pegged hem.
    c.px(2, 31, 42, 3, '#5f4830')
    c.line(23, 6, 43, 33, '#3f3020', 1)
    c.line(23, 6, 3, 33, '#3f3020', 1)
    // Dark doorway, wide at the bottom like the tent itself.
    c.cone(23, 15, 15, 18, '#241c14')
    c.px(24, 22, 5, 11, '#33281c')
    // Ridge pole with a pennant.
    c.px(22, 0, 2, 7, '#4a3220')
    c.px(24, 0, 7, 4, '#ab332c')
    c.px(24, 4, 5, 1, '#8a251f')
  })
}

function campfire(frame: number): Prop {
  return prop(24, 22, (c) => {
    c.oval(12, 19, 10, 3, '#3c3229')
    c.px(4, 15, 16, 4, '#5a4028')
    c.line(5, 18, 19, 14, '#6d4d31', 2)
    c.line(5, 14, 19, 18, '#4a3320', 2)
    const lift = [0, -2, -1][frame]!
    const wob = [0, 1, -1][frame]!
    // Flames: pointed at the tip, broad at the embers.
    c.cone(12 + wob, 2 + lift, 12, 14, '#e0631f')
    c.cone(12 + wob, 5 + lift, 9, 11, '#f0993a')
    c.cone(12 + wob, 9 + lift, 5, 7, '#ffe08a')
    c.dot(6 + wob, 11 + lift, '#f0993a')
    c.dot(18 - wob, 9 + lift, '#e0631f')
  }, false)
}

function banner(): Prop {
  return prop(16, 40, (c) => {
    c.px(7, 2, 3, 37, '#4a3220')
    c.px(7, 2, 1, 37, '#6b4a2c')
    c.px(5, 0, 7, 3, '#d8a63c')
    c.px(2, 6, 12, 18, '#ab332c')
    c.px(2, 6, 12, 2, '#d8a63c')
    c.px(2, 22, 4, 4, '#ab332c')
    c.px(10, 22, 4, 4, '#ab332c')
    c.px(6, 12, 4, 7, '#e8d9a8')
  })
}

function bones(): Prop {
  return prop(24, 14, (c) => {
    c.oval(8, 9, 5, 4, '#ddd6c2')
    c.px(11, 8, 4, 3, '#ddd6c2')
    c.dot(6, 8, '#3a3630')
    c.dot(9, 8, '#3a3630')
    c.line(14, 12, 22, 10, '#c9c1ad', 2)
    c.px(21, 8, 3, 2, '#ddd6c2')
    c.px(13, 11, 3, 2, '#ddd6c2')
  })
}

function chestProp(): Prop {
  return prop(24, 20, (c) => {
    c.px(2, 8, 20, 11, '#6b4526')
    c.px(2, 8, 20, 2, '#8a5b33')
    c.oval(12, 8, 10, 5, '#7a5130')
    c.px(2, 8, 20, 1, '#3f2916')
    c.px(2, 12, 20, 2, '#c9a24a')
    c.px(10, 10, 4, 6, '#d8b45a')
    c.dot(12, 13, '#3f2916')
    c.px(1, 17, 22, 2, '#3f2916')
  })
}

function flower(color: string): Prop {
  return prop(9, 10, (c) => {
    c.px(4, 5, 1, 5, '#3a6b34')
    c.px(2, 6, 2, 1, '#3a6b34')
    c.px(3, 2, 3, 3, color)
    c.dot(2, 3, color)
    c.dot(6, 3, color)
    c.dot(4, 1, color)
    c.dot(4, 3, '#f2e28a')
  }, false)
}

function tuft(color: string): Prop {
  return prop(14, 10, (c) => {
    c.line(3, 9, 1, 3, color, 1)
    c.line(6, 9, 6, 1, color, 1)
    c.line(9, 9, 12, 3, color, 1)
    c.line(11, 9, 13, 5, color, 1)
  }, false)
}

function mushroom(): Prop {
  return prop(10, 11, (c) => {
    c.px(4, 6, 3, 5, '#d8cdb4')
    c.oval(5, 5, 5, 3.5, '#c0413c')
    c.dot(3, 4, '#f0e6cc')
    c.dot(7, 5, '#f0e6cc')
    c.dot(5, 3, '#f0e6cc')
  })
}

function crate(): Prop {
  return prop(20, 18, (c) => {
    c.px(2, 3, 16, 14, '#7a5533')
    c.px(2, 3, 16, 2, '#96693f')
    c.px(2, 9, 16, 2, '#5d3f24')
    c.px(9, 3, 2, 14, '#5d3f24')
    c.px(2, 15, 16, 2, '#4a3220')
  })
}

/** Sharpened post — marks the edge of a camp's protected ground. */
function stake(): Prop {
  return prop(12, 24, (c) => {
    c.spike(6, 1, 6, 5, '#8a6134')
    c.px(3, 5, 6, 18, '#6b4a2c')
    c.px(3, 5, 2, 18, '#8a6134')
    c.px(7, 5, 2, 18, '#4a3220')
    c.px(2, 12, 8, 2, '#3f3a33')
  })
}

function signpost(): Prop {
  return prop(22, 26, (c) => {
    c.px(10, 8, 3, 17, '#5d3f24')
    c.px(2, 5, 18, 8, '#8a6134')
    c.px(2, 5, 18, 2, '#a3763f')
    c.px(4, 8, 12, 1, '#4a3220')
    c.px(4, 10, 8, 1, '#4a3220')
  })
}

export function makeProps(): Record<string, Prop[]> {
  return {
    pine: [pine(false)],
    pineSnow: [pine(true)],
    oak: [oak()],
    deadTree: [deadTree()],
    bush: [bushProp(false), bushProp(true)],
    rock: [rockProp(false)],
    boulder: [rockProp(true)],
    stump: [stump()],
    tent: [tent()],
    campfire: [campfire(0), campfire(1), campfire(2)],
    banner: [banner()],
    bones: [bones()],
    chest: [chestProp()],
    flower: [flower('#e0d05a'), flower('#d86a9c'), flower('#7fa8e8')],
    tuft: [tuft('#4f8a45'), tuft('#6b8f3f')],
    mushroom: [mushroom()],
    crate: [crate()],
    signpost: [signpost()],
    stake: [stake()],
  }
}

/* ------------------------------------------------------------------ *
 * Item + ability icons (rendered into the DOM as data URLs)
 * ------------------------------------------------------------------ */

const RARITY_TRIM = ['#9aa3b2', '#62c46a', '#4e9df5', '#b064e8', '#f0913a']

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

function drawIcon(c: PixelCanvas, kind: IconKind, trim: string) {
  const S = '#a8b2c4'
  const SL = '#dde4f0'
  const SD = '#5f6879'
  const L = '#7c5230'
  const LD = '#4c3119'
  switch (kind) {
    case 'axe':
      c.px(10, 6, 3, 15, L)
      c.px(10, 6, 1, 15, LD)
      c.px(4, 3, 9, 7, S)
      c.px(4, 3, 9, 3, SL)
      c.px(3, 4, 2, 5, SL)
      c.px(12, 4, 2, 5, SD)
      c.px(9, 19, 5, 3, trim)
      break
    case 'sword':
      c.px(9, 2, 4, 14, S)
      c.px(9, 2, 2, 14, SL)
      c.cone(11, 0, 4, 3, SL)
      c.px(5, 15, 12, 3, trim)
      c.px(10, 18, 3, 5, L)
      c.px(9, 22, 5, 2, trim)
      break
    case 'mace':
      c.px(10, 10, 3, 13, L)
      c.oval(11, 7, 6, 6, S)
      c.oval(10, 5, 4, 3, SL)
      c.px(4, 6, 2, 2, SD)
      c.px(16, 6, 2, 2, SD)
      c.px(10, 1, 3, 3, trim)
      break
    case 'helm':
      c.oval(11, 10, 8, 8, S)
      c.oval(10, 8, 6, 5, SL)
      c.px(3, 11, 16, 8, S)
      c.px(3, 16, 16, 3, SD)
      c.px(9, 9, 4, 10, SD)
      c.px(3, 11, 3, 6, SD)
      c.px(16, 11, 3, 6, SD)
      c.px(9, 1, 4, 4, trim)
      break
    case 'chest':
      c.px(4, 5, 15, 15, S)
      c.px(4, 5, 15, 3, SL)
      c.px(1, 4, 5, 7, SL)
      c.px(17, 4, 5, 7, SD)
      c.px(10, 6, 3, 13, SD)
      c.px(4, 17, 15, 3, L)
      c.px(9, 17, 5, 3, trim)
      break
    case 'gloves':
      c.px(4, 8, 8, 11, L)
      c.px(4, 8, 8, 3, S)
      c.px(12, 10, 4, 7, LD)
      c.px(3, 6, 10, 3, trim)
      c.px(14, 4, 4, 8, S)
      break
    case 'boots':
      c.px(6, 3, 7, 12, L)
      c.px(6, 3, 3, 12, '#96683f')
      c.px(4, 14, 15, 5, LD)
      c.px(4, 18, 16, 2, '#2c1d10')
      c.px(5, 2, 9, 3, trim)
      break
    case 'ring':
      c.oval(11, 14, 7, 7, trim)
      c.ctx.clearRect(7, 10, 8, 8) // punch the band's hole
      c.oval(11, 6, 4, 4, '#63d6e8')
      c.dot(10, 5, '#eafcff')
      break
    case 'coin':
      c.oval(11, 12, 8, 8, '#d8a63c')
      c.oval(11, 11, 6, 6, '#f2c14e')
      c.oval(10, 10, 3, 3, '#fbe6a8')
      c.px(10, 9, 3, 7, '#b5842a')
      break
    case 'pelt':
      c.oval(11, 12, 8, 9, '#7c6a55')
      c.oval(11, 11, 5, 6, '#9c8a72')
      c.px(3, 4, 4, 5, '#7c6a55')
      c.px(15, 4, 4, 5, '#7c6a55')
      c.dot(8, 10, '#3a3128')
      c.dot(14, 10, '#3a3128')
      break
  }
}

const iconCache = new Map<string, string>()

export function itemIcon(kind: IconKind, rarity: number): string {
  const key = `${kind}:${rarity}`
  const hit = iconCache.get(key)
  if (hit) return hit
  const c = new PixelCanvas(23, 25)
  drawIcon(c, kind, RARITY_TRIM[rarity] ?? RARITY_TRIM[0]!)
  c.outline('#0a0b11')
  const url = c.toURL()
  iconCache.set(key, url)
  return url
}

export function abilityIcon(name: 'whirlwind' | 'secondwind'): string {
  const key = `ab:${name}`
  const hit = iconCache.get(key)
  if (hit) return hit
  const c = new PixelCanvas(32, 32)
  if (name === 'whirlwind') {
    // Two blades swirling around a hub.
    c.oval(16, 16, 11, 11, '#2c3446')
    c.oval(16, 16, 8, 8, '#39445c')
    for (const [dx, dy] of [
      [1, 1],
      [-1, -1],
    ] as const) {
      c.line(16, 16, 16 + dx * 11, 16 + dy * 11, '#cdd6e6', 3)
      c.line(16 + dx * 5, 16 + dy * 5, 16 + dx * 12, 16 + dy * 12, '#eef3fb', 2)
    }
    c.line(6, 20, 12, 26, '#98a4bb', 2)
    c.line(26, 12, 20, 6, '#98a4bb', 2)
    c.oval(16, 16, 3, 3, '#d8a63c')
  } else {
    // A heart wrapped in a shield.
    c.px(5, 4, 22, 14, '#2f4a35')
    c.spike(16, 17, 22, 11, '#2f4a35')
    c.px(5, 4, 22, 3, '#4d7a56')
    c.oval(11, 13, 5, 5, '#d8483f')
    c.oval(20, 13, 5, 5, '#d8483f')
    c.spike(16, 15, 14, 9, '#d8483f')
    c.oval(11, 12, 3, 2, '#f28279')
    c.dot(9, 11, '#ffc9c3')
  }
  c.outline('#0a0b11')
  const url = c.toURL()
  iconCache.set(key, url)
  return url
}

/* ------------------------------------------------------------------ *
 * Assembled art bundle
 * ------------------------------------------------------------------ */

/**
 * A downed beast: the side view squashed onto the ground and drained of
 * colour. Baking it once beats transforming the live sprite every frame, and
 * rotating the sprite instead just reads as debris.
 */
function makeCorpse(sheet: Sheet): HTMLCanvasElement {
  const squash = 0.6
  const c = new PixelCanvas(sheet.fw, Math.round(sheet.fh * squash) + 2)
  c.ctx.save()
  c.ctx.scale(1, squash)
  c.ctx.drawImage(sheet.cv, 0, 2 * sheet.fh, sheet.fw, sheet.fh, 0, 2, sheet.fw, sheet.fh)
  c.ctx.restore()
  c.tint('#2c2119', 0.5)
  return c.cv
}

export interface Art {
  warrior: Sheet
  wolf: Sheet
  alphaWolf: Sheet
  bear: Sheet
  elderBear: Sheet
  props: Record<string, Prop[]>
  corpses: Record<string, HTMLCanvasElement>
}

export function buildArt(): Art {
  const wolf = makeBeastSheet(WOLF_SPEC)
  const alphaWolf = makeBeastSheet(WOLF_SPEC, ALPHA_WOLF_PAL, 1.25)
  const bear = makeBeastSheet(BEAR_SPEC)
  const elderBear = makeBeastSheet(BEAR_SPEC, ELDER_BEAR_PAL, 1.2)
  return {
    warrior: makeWarriorSheet(),
    wolf,
    alphaWolf,
    bear,
    elderBear,
    props: makeProps(),
    corpses: {
      wolf: makeCorpse(wolf),
      alphaWolf: makeCorpse(alphaWolf),
      bear: makeCorpse(bear),
      elderBear: makeCorpse(elderBear),
    },
  }
}
