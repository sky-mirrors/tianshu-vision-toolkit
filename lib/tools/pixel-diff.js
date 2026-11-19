/**
 * vision_pixel_diff：逐像素比对两张图，按网格排出最差的区域，产出热力图 + JSON 报告。
 *
 * 语义对齐上游 `pixel_diff.py`：rebuilt 先缩放到 original 尺寸；差值图按
 * ITU-R 601-2 亮度权重降为灰度后取均值；网格坐标始终是原图坐标系。
 */
import { writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { loadRgb, peekImageInfo } from '../image.js'
import { resizeRgb } from '../raster.js'
import { encodePng } from '../png.js'
import { artifactName, resolveOutput } from '../artifacts.js'

/** Python round() 是「四舍六入五取偶」，网格边界必须跟上游同一种取整。 */
function pyRound(value) {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** 两张同尺寸 RGB 光栅的差异：返回灰度差图（0-255）与逐像素 L 值。 */
function difference(a, b) {
  const width = a.width
  const height = a.height
  const grey = new Float64Array(width * height)
  const rgb = new Uint8ClampedArray(width * height * 3)
  for (let i = 0, n = width * height; i < n; i += 1) {
    const dr = Math.abs(a.data[i * 3] - b.data[i * 3])
    const dg = Math.abs(a.data[i * 3 + 1] - b.data[i * 3 + 1])
    const db = Math.abs(a.data[i * 3 + 2] - b.data[i * 3 + 2])
    rgb[i * 3] = dr
    rgb[i * 3 + 1] = dg
    rgb[i * 3 + 2] = db
    grey[i] = 0.299 * dr + 0.587 * dg + 0.114 * db
  }
  return { width, height, grey, rgb }
}

function cellScores(diff, grid, top) {
  const width = diff.width
  const height = diff.height
  const scores = []
  for (let row = 0; row < grid; row += 1) {
    for (let column = 0; column < grid; column += 1) {
      const box = {
        x1: pyRound(column * width / grid),
        y1: pyRound(row * height / grid),
        x2: pyRound((column + 1) * width / grid),
        y2: pyRound((row + 1) * height / grid),
      }
      if (box.x2 <= box.x1 || box.y2 <= box.y1) continue
      let sum = 0
      for (let y = box.y1; y < box.y2; y += 1) {
        for (let x = box.x1; x < box.x2; x += 1) sum += diff.grey[y * width + x]
      }
      const count = (box.x2 - box.x1) * (box.y2 - box.y1)
      scores.push({ differencePct: (sum / count) / 255 * 100, box })
    }
  }
  scores.sort((l, r) => r.differencePct - l.differencePct)
  return scores.slice(0, top).map((cell, index) => ({ index: index + 1, ...cell }))
}

function meanPct(diff) {
  let sum = 0
  for (let i = 0; i < diff.grey.length; i += 1) sum += diff.grey[i]
  return (sum / diff.grey.length) / 255 * 100
}

function artifact(path, cwd) {
  return { path, filename: basename(path), ...(isAbsolute(path) ? {} : { relativeTo: cwd }) }
}

export const pixelDiffTool = {
  name: 'vision_pixel_diff',
  description:
    'Compare two images with real pixels, rank the worst grid regions, and deliver a diff heatmap PNG plus a JSON report. '
    + 'The rebuilt image is scaled to the reference size when dimensions differ.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      original: { type: 'string', description: 'Reference image path (PNG).' },
      rebuilt: { type: 'string', description: 'Rendered/rebuilt image path (PNG).' },
      grid: { type: 'integer', description: 'Grid side count 1-32; default 6.' },
      top: { type: 'integer', description: 'Worst region count; default 5.' },
      output: { type: 'string', description: 'Heatmap PNG path; defaults to <cwd>/.rivet/artifacts/vision/<original-stem>.diff.png.' },
    },
    required: ['original', 'rebuilt'],
  },
  pathParams: { original: 'read', rebuilt: 'read', output: 'write' },
  concurrencySafe: true,
  timeoutMs: 120000,
  async execute(call) {
    const args = call.args
    const grid = args.grid === undefined ? 6 : args.grid
    const top = args.top === undefined ? 5 : args.top
    if (!Number.isInteger(grid) || grid < 1 || grid > 32) {
      return { content: 'vision_pixel_diff: grid must be an integer 1-32', isError: true }
    }
    if (!Number.isInteger(top) || top < 1) {
      return { content: 'vision_pixel_diff: top must be a positive integer', isError: true }
    }

    const originalInfo = peekImageInfo(args.original)
    const rebuiltInfo = peekImageInfo(args.rebuilt)
    const reference = loadRgb(args.original)
    const candidate = loadRgb(args.rebuilt)
    const scaled = candidate.width !== reference.width || candidate.height !== reference.height
    const rebuilt = scaled ? resizeRgb(candidate, reference.width, reference.height) : candidate

    const diff = difference(reference, rebuilt)
    const overall = meanPct(diff)

    const heatmapPath = resolveOutput(args.output, call.cwd, artifactName(args.original, '.diff.png'))
    writeFileSync(heatmapPath, encodePng({
      width: diff.width,
      height: diff.height,
      data: rgbaFromRgb(diff.rgb, diff.width, diff.height),
    }))

    const report = {
      original: { path: args.original, bytes: originalInfo.bytes, width: reference.width, height: reference.height, format: reference.format, originalPath: args.original },
      rebuilt: { path: args.rebuilt, bytes: rebuiltInfo.bytes, width: rebuilt.width, height: rebuilt.height, format: rebuilt.format, originalPath: args.rebuilt },
      scaled,
      ...(scaled ? { rebuiltOriginalSize: { width: candidate.width, height: candidate.height } } : {}),
      overallDifferencePct: overall,
      worstRegions: cellScores(diff, grid, top),
      heatmap: artifact(heatmapPath, call.cwd),
    }
    return { content: JSON.stringify(report, null, 2), rawPath: heatmapPath }
  },
}

function rgbaFromRgb(rgb, width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0, n = width * height; i < n; i += 1) {
    data[i * 4] = rgb[i * 3]
    data[i * 4 + 1] = rgb[i * 3 + 1]
    data[i * 4 + 2] = rgb[i * 3 + 2]
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}
