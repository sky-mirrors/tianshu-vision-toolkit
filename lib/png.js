/**
 * 最小 PNG 编解码。
 *
 * 只支持视觉工具真正需要的那一档：8 位、非隔行，colorType 0（灰度）、2（RGB）、
 * 4（灰度+alpha）、6（RGBA）。其余组合（16 位、索引色、Adam7）明确报错，不静默降级。
 */
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** 读取 PNG 的 IHDR，返回尺寸与色彩类型（供工具层报告，不重复校验）。 */
export function readPngHeader(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG file (signature mismatch)')
  }
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') throw new Error('PNG missing IHDR chunk')
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const bitDepth = buffer[24]
  const colorType = buffer[25]
  const interlace = buffer[28]
  return { width, height, bitDepth, colorType, interlace }
}

/** 解码 PNG 为 RGBA 光栅。返回 { width, height, data }，data 为 Uint8ClampedArray。 */
export function decodePng(buffer) {
  const header = readPngHeader(buffer)
  const { width, height, bitDepth, colorType, interlace } = header
  const channels = CHANNELS[colorType]
  if (bitDepth !== 8 || channels === undefined) {
    throw new Error(`unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType}`)
  }
  if (interlace !== 0) throw new Error('unsupported PNG format: Adam7 interlacing')

  let offset = 8
  let idat = Buffer.alloc(0)
  let sawEnd = false
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length)
    const actualCrc = crc32(buffer.subarray(offset + 4, offset + 8 + length))
    if (expectedCrc !== actualCrc) throw new Error(`PNG chunk ${type} failed CRC check`)
    if (type === 'IDAT') idat = Buffer.concat([idat, body])
    if (type === 'IEND') { sawEnd = true; break }
    offset += 12 + length
  }
  if (!sawEnd) throw new Error('PNG missing IEND chunk')

  const raw = inflateSync(idat)
  const bytesPerPixel = channels
  const stride = width * bytesPerPixel
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`PNG image data size mismatch: got ${raw.length}, expected ${height * (stride + 1)}`)
  }

  const unfiltered = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? unfiltered[dst + x - bytesPerPixel] : 0
      const up = y > 0 ? unfiltered[dst - stride + x] : 0
      const upLeft = x >= bytesPerPixel && y > 0 ? unfiltered[dst - stride + x - bytesPerPixel] : 0
      const value = raw[src + x]
      switch (filter) {
        case 0: unfiltered[dst + x] = value; break
        case 1: unfiltered[dst + x] = value + left; break
        case 2: unfiltered[dst + x] = value + up; break
        case 3: unfiltered[dst + x] = value + ((left + up) >> 1); break
        case 4: unfiltered[dst + x] = value + paeth(left, up, upLeft); break
        default: throw new Error(`unsupported PNG row filter ${filter} at row ${y}`)
      }
    }
  }

  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0, n = width * height; i < n; i += 1) {
    const s = i * bytesPerPixel
    const d = i * 4
    if (channels === 4) {
      data[d] = unfiltered[s]; data[d + 1] = unfiltered[s + 1]; data[d + 2] = unfiltered[s + 2]; data[d + 3] = unfiltered[s + 3]
    } else if (channels === 3) {
      data[d] = unfiltered[s]; data[d + 1] = unfiltered[s + 1]; data[d + 2] = unfiltered[s + 2]; data[d + 3] = 255
    } else if (channels === 2) {
      data[d] = unfiltered[s]; data[d + 1] = unfiltered[s]; data[d + 2] = unfiltered[s]; data[d + 3] = unfiltered[s + 1]
    } else {
      data[d] = unfiltered[s]; data[d + 1] = unfiltered[s]; data[d + 2] = unfiltered[s]; data[d + 3] = 255
    }
  }
  return { width, height, data }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function chunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** 把 RGBA 光栅写成 PNG（filter 0，无隔行）。 */
export function encodePng(raster) {
  const { width, height, data } = raster
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    for (let x = 0; x < stride; x += 1) raw[y * (stride + 1) + 1 + x] = data[y * stride + x]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
