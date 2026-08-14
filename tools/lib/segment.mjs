/** Finding sprites in an image by their own pixels, shared by the atlas tools. */

export const ALPHA = 16

/** A scanline this wide, as a part of the frame width, is a foot, not a blade. */
export const SOLE_WIDTH = 0.08

export function alphaMask({ width, height, data }) {
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > ALPHA ? 1 : 0
  return mask
}

/** Grows the mask by `radius`, so the parts of one sprite become one blob. */
function dilate(mask, width, height, radius) {
  let src = mask
  for (let pass = 0; pass < radius; pass++) {
    const dst = new Uint8Array(src.length)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (
          src[i] ||
          (x > 0 && src[i - 1]) ||
          (x < width - 1 && src[i + 1]) ||
          (y > 0 && src[i - width]) ||
          (y < height - 1 && src[i + width])
        ) {
          dst[i] = 1
        }
      }
    }
    src = dst
  }
  return src
}

/** One box per blob, tight around the blob's *original* pixels. */
export function components(mask, width, height, radius, minArea) {
  const blob = dilate(mask, width, height, radius)
  const seen = new Uint8Array(blob.length)
  const queue = new Int32Array(blob.length)
  const boxes = []
  for (let start = 0; start < blob.length; start++) {
    if (!blob[start] || seen[start]) continue
    let head = 0
    let tail = 0
    queue[tail++] = start
    seen[start] = 1
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    let area = 0
    while (head < tail) {
      const i = queue[head++]
      const x = i % width
      const y = (i - x) / width
      if (mask[i]) {
        area++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      if (x > 0 && blob[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; queue[tail++] = i - 1 }
      if (x < width - 1 && blob[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; queue[tail++] = i + 1 }
      if (y > 0 && blob[i - width] && !seen[i - width]) { seen[i - width] = 1; queue[tail++] = i - width }
      if (y < height - 1 && blob[i + width] && !seen[i + width]) { seen[i + width] = 1; queue[tail++] = i + width }
    }
    if (area >= minArea) boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 })
  }
  return boxes
}

export function intoRows(boxes, tolerance) {
  const sorted = [...boxes].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))
  const rows = []
  let current = []
  for (const box of sorted) {
    const centre = box.y + box.h / 2
    if (current.length && centre - (current[0].y + current[0].h / 2) > tolerance) {
      rows.push(current.sort((a, b) => a.x - b.x))
      current = []
    }
    current.push(box)
  }
  if (current.length) rows.push(current.sort((a, b) => a.x - b.x))
  return rows
}

/**
 * Where the figure in a frame stands, as an absolute y in the image.
 *
 * The lowest pixel is not reliable. A sword can hang below a boot, and then the
 * frame would sit on the point of its blade.
 */
export function soleOf(mask, width, box) {
  const need = Math.max(3, Math.round(box.w * SOLE_WIDTH))
  for (let y = box.y + box.h - 1; y >= box.y; y--) {
    let n = 0
    for (let x = box.x; x < box.x + box.w; x++) if (mask[y * width + x]) n++
    if (n >= need) return y
  }
  return box.y + box.h - 1
}

/** Least-squares line through (index, value) pairs. */
export function fitLine(values) {
  const n = values.length
  if (n < 2) return { a: values[0] ?? 0, b: 0 }
  const mx = (n - 1) / 2
  const my = values.reduce((s, v) => s + v, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (values[i] - my)
    den += (i - mx) ** 2
  }
  return { a: my - (den ? num / den : 0) * mx, b: den ? num / den : 0 }
}
