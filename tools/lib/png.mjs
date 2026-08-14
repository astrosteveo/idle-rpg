/**
 * The small part of PNG this project needs: 8-bit RGBA, no interlace.
 *
 * The atlases are the only images the tools read or write, and they are all in
 * that one format, so a dependency would buy nothing.
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** @returns {{width: number, height: number, data: Buffer}} RGBA, 4 bytes a pixel. */
export function readPng(file) {
  const buf = readFileSync(file)
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${file} is not a PNG.`)
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const depth = buf[24]
  const colour = buf[25]
  const interlace = buf[28]
  if (depth !== 8 || colour !== 6 || interlace !== 0) {
    throw new Error(`${file}: expected 8-bit RGBA without interlace, got depth ${depth} colour ${colour}.`)
  }

  const parts = []
  for (let at = 8; at + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(at)
    const type = buf.toString('ascii', at + 4, at + 8)
    if (type === 'IDAT') parts.push(buf.subarray(at + 8, at + 8 + length))
    at += length + 12
    if (type === 'IEND') break
  }
  const raw = inflateSync(Buffer.concat(parts))

  // Undo the per-scanline filter. Each byte is predicted from its left (a),
  // upper (b) and upper-left (c) neighbour, four bytes to a pixel.
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]
      const a = i >= bpp ? out[dst + i - bpp] : 0
      const b = y > 0 ? out[up + i] : 0
      const c = y > 0 && i >= bpp ? out[up + i - bpp] : 0
      let value
      switch (filter) {
        case 0: value = x; break
        case 1: value = x + a; break
        case 2: value = x + b; break
        case 3: value = x + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`${file}: unknown scanline filter ${filter}.`)
      }
      out[dst + i] = value & 0xff
    }
  }
  return { width, height, data: out }
}

export function writePng(file, { width, height, data }) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // no filter; these images compress well enough
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  writeFileSync(
    file,
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

export const blank = (width, height) => ({ width, height, data: Buffer.alloc(width * height * 4) })
