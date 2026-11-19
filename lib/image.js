/**
 * 图像载入：读文件 → 判格式 → 解码为 RGBA → 白底合成 RGB。
 *
 * 格式判定只看文件头魔数，不看扩展名——`.png` 里放 JPEG 的情况在真实截图里出现过。
 */
import { readFileSync } from 'node:fs'
import { decodePng, readPngHeader } from './png.js'
import { compositeOnWhite } from './raster.js'
import { assertReadableImagePath } from './path-guard.js'

/** 读取并解码图像，返回 { width, height, data(RGBA), format }。 */
export function loadImage(path) {
  assertReadableImagePath(path)
  const bytes = readFileSync(path)
  if (bytes.length >= 8 && bytes.toString('latin1', 1, 4) === 'PNG') {
    const header = readPngHeader(bytes)
    return { ...decodePng(bytes), format: 'png', bitDepth: header.bitDepth, colorType: header.colorType }
  }
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  throw new Error(
    `unsupported image format${isJpeg ? ' (JPEG)' : ''} at ${path}; this build decodes PNG only — `
    + 'convert the file to PNG first (e.g. with a screenshot or image tool)',
  )
}

/** 读取图像并直接返回白底合成后的 RGB 光栅。 */
export function loadRgb(path) {
  const image = loadImage(path)
  return { ...compositeOnWhite(image), format: image.format }
}

/** 文件头信息，不整幅解码（用于报告 imageWidth/imageHeight）。 */
export function peekImageInfo(path) {
  assertReadableImagePath(path)
  const bytes = readFileSync(path)
  if (bytes.length >= 8 && bytes.toString('latin1', 1, 4) === 'PNG') {
    const { width, height } = readPngHeader(bytes)
    return { width, height, format: 'png', bytes: bytes.length }
  }
  throw new Error(`unsupported image format at ${path}; this build decodes PNG only`)
}
