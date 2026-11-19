/**
 * 光栅运算：区域解析、白底合成、Lanczos 重采样、裁切。
 *
 * 所有颜色统计与差异计算都建立在「白底合成后的 RGB」上——上游脚本对透明像素
 * 先合成白底，未合成的 alpha 会被当成黑色，产生幽灵差异。
 */

/** 解析 "X1,Y1,X2,Y2" 并 clamp 到图像边界；越界后为空则报错。返回窄类型（含 clamped 标记）。 */
export function parseRegion(region, width, height) {
  const parts = String(region).split(',').map(v => Number(v.trim()))
  if (parts.length !== 4 || parts.some(v => !Number.isInteger(v))) {
    throw new Error(`region expects four integers X1,Y1,X2,Y2 (pixels); got ${JSON.stringify(region)}`)
  }
  const [x1raw, y1raw, x2raw, y2raw] = parts
  const x1 = Math.max(0, Math.min(x1raw, x2raw))
  const y1 = Math.max(0, Math.min(y1raw, y2raw))
  const x2 = Math.min(width, Math.max(x1raw, x2raw))
  const y2 = Math.min(height, Math.max(y1raw, y2raw))
  if (x2 <= x1 || y2 <= y1) {
    throw new Error(`region ${region} is empty after clamping to ${width}x${height}`)
  }
  const clamped = x1 !== Math.min(x1raw, x2raw) || y1 !== Math.min(y1raw, y2raw)
    || x2 !== Math.max(x1raw, x2raw) || y2 !== Math.max(y1raw, y2raw)
  return { x1, y1, x2, y2, clamped }
}

/** RGBA → RGB，透明像素合成到白底。 */
export function compositeOnWhite(raster) {
  const { width, height, data } = raster
  const rgb = new Uint8ClampedArray(width * height * 3)
  for (let i = 0, n = width * height; i < n; i += 1) {
    const s = i * 4
    const alpha = data[s + 3] / 255
    rgb[i * 3] = data[s] * alpha + 255 * (1 - alpha)
    rgb[i * 3 + 1] = data[s + 1] * alpha + 255 * (1 - alpha)
    rgb[i * 3 + 2] = data[s + 2] * alpha + 255 * (1 - alpha)
  }
  return { width, height, data: rgb }
}

/** 从 RGB 光栅裁出区域。返回 RGB 光栅。 */
export function cropRegion(raster, box) {
  const width = box.x2 - box.x1
  const height = box.y2 - box.y1
  const rgb = new Uint8ClampedArray(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = ((box.y1 + y) * raster.width + (box.x1 + x)) * 3
      const d = (y * width + x) * 3
      rgb[d] = raster.data[s]
      rgb[d + 1] = raster.data[s + 1]
      rgb[d + 2] = raster.data[s + 2]
    }
  }
  return { width, height, data: rgb }
}

function lanczos(x) {
  if (x === 0) return 1
  const a = Math.abs(x)
  if (a >= 3) return 0
  const pix = Math.PI * a
  return (3 * Math.sin(pix) * Math.sin(pix / 3)) / (pix * pix)
}

/** 一维重采样；下采样时按 scale 展宽核，与 Pillow LANCZOS 的抗锯齿行为一致。 */
function resample1D(src, dstLen) {
  const srcLen = src.length
  if (srcLen === dstLen) return Float64Array.from(src)
  const scale = dstLen / srcLen
  const kernelScale = scale < 1 ? scale : 1
  const support = 3 / kernelScale
  const out = new Float64Array(dstLen)
  for (let i = 0; i < dstLen; i += 1) {
    const center = (i + 0.5) / scale - 0.5
    const start = Math.max(0, Math.floor(center - support))
    const end = Math.min(srcLen - 1, Math.ceil(center + support))
    let weightSum = 0
    let acc = 0
    for (let j = start; j <= end; j += 1) {
      const weight = lanczos((j - center) * kernelScale)
      weightSum += weight
      acc += weight * src[j]
    }
    const fallbackIndex = Math.min(srcLen - 1, Math.max(0, Math.round(center)))
    out[i] = weightSum === 0 ? src[fallbackIndex] : acc / weightSum
  }
  return out
}

/** 把 RGB 光栅缩放到目标尺寸（分离式 Lanczos3）。 */
export function resizeRgb(raster, targetWidth, targetHeight) {
  const { width, height, data } = raster
  if (width === targetWidth && height === targetHeight) return raster

  const horizontal = new Float64Array(targetWidth * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let c = 0; c < 3; c += 1) {
      const row = new Float64Array(width)
      for (let x = 0; x < width; x += 1) row[x] = data[(y * width + x) * 3 + c]
      const out = resample1D(row, targetWidth)
      for (let x = 0; x < targetWidth; x += 1) horizontal[(y * targetWidth + x) * 3 + c] = out[x]
    }
  }

  const result = new Uint8ClampedArray(targetWidth * targetHeight * 3)
  for (let x = 0; x < targetWidth; x += 1) {
    for (let c = 0; c < 3; c += 1) {
      const column = new Float64Array(height)
      for (let y = 0; y < height; y += 1) column[y] = horizontal[(y * targetWidth + x) * 3 + c]
      const out = resample1D(column, targetHeight)
      for (let y = 0; y < targetHeight; y += 1) result[(y * targetWidth + x) * 3 + c] = out[y]
    }
  }
  return { width: targetWidth, height: targetHeight, data: result }
}
