/**
 * vision_dominant_colors：测出区域里的显著颜色；或给一组候选 #RRGGBB，用像素选出真实值。
 *
 * 语义对齐上游 `dominant_colors.py`：区域先下采样再量化，近邻色按 Chebyshev 距离合并；
 * 候选模式按「每个候选到区域内像素的逐通道最大差」评分，hard = 距离 ≤ tol 的像素占比，
 * 胜者取 (weighted, hard) 最大者，而不是占比最高者。
 */
import { loadRgb } from '../image.js'
import { cropRegion, parseRegion, resizeRgb } from '../raster.js'

function hexOf([r, g, b]) {
  return `#${r.toString(16).padStart(2, '0').toUpperCase()}${g.toString(16).padStart(2, '0').toUpperCase()}${b.toString(16).padStart(2, '0').toUpperCase()}`
}

/** 解析 #RRGGBB；格式不对就报错（边界只此一次）。 */
function parseHex(text) {
  const value = String(text).trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`invalid colour ${JSON.stringify(text)}: expected #RRGGBB`)
  }
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)]
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}

/** 中位切分量化：返回 [{rgb, count}]，按 count 降序。 */
function quantize(raster, k) {
  const pixels = []
  for (let i = 0, n = raster.width * raster.height; i < n; i += 1) {
    pixels.push([raster.data[i * 3], raster.data[i * 3 + 1], raster.data[i * 3 + 2]])
  }
  let boxes = [pixels]
  while (boxes.length < k) {
    let target = -1
    let widest = 0
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i]
      if (box.length < 2) continue
      const spread = widestChannel(box)
      if (spread.range > widest) { widest = spread.range; target = i }
    }
    if (target < 0 || widest === 0) break
    const box = boxes[target]
    const channel = widestChannel(box).channel
    box.sort((l, r) => l[channel] - r[channel])
    const middle = Math.floor(box.length / 2)
    boxes = boxes.slice(0, target).concat([box.slice(0, middle), box.slice(middle)], boxes.slice(target + 1))
  }
  return boxes.filter(box => box.length > 0).map(box => ({
    rgb: [0, 1, 2].map(c => Math.round(box.reduce((sum, p) => sum + p[c], 0) / box.length)),
    count: box.length,
  })).sort((l, r) => r.count - l.count)
}

function widestChannel(pixels) {
  let best = { channel: 0, range: -1 }
  for (let c = 0; c < 3; c += 1) {
    let min = 255
    let max = 0
    for (const p of pixels) {
      if (p[c] < min) min = p[c]
      if (p[c] > max) max = p[c]
    }
    if (max - min > best.range) best = { channel: c, range: max - min }
  }
  return best
}

/** 合并 Chebyshev 距离 ≤ tol 的聚类，合并时按像素数加权平均中心。 */
function mergeClusters(clusters, tol) {
  const merged = []
  for (const cluster of clusters) {
    const existing = merged.find(c => chebyshev(c.rgb, cluster.rgb) <= tol)
    if (existing) {
      const total = existing.count + cluster.count
      existing.rgb = [0, 1, 2].map(c => Math.round((existing.rgb[c] * existing.count + cluster.rgb[c] * cluster.count) / total))
      existing.count = total
    } else {
      merged.push({ rgb: cluster.rgb.slice(), count: cluster.count })
    }
  }
  return merged.sort((l, r) => r.count - l.count)
}

function extractPalette(raster, options) {
  const crop = cropRegion(raster, options.box)
  const scale = Math.min(1, options.maxPixels / Math.max(crop.width, crop.height))
  const sampled = scale < 1
    ? resizeRgb(crop, Math.max(1, Math.round(crop.width * scale)), Math.max(1, Math.round(crop.height * scale)))
    : crop
  const merged = mergeClusters(quantize(sampled, options.quantize), options.mergeTolerance)
  const total = merged.reduce((sum, c) => sum + c.count, 0)
  return {
    clusterCount: merged.length,
    sampledPixels: sampled.width * sampled.height,
    colors: merged.slice(0, options.top).map(c => ({
      color: hexOf(c.rgb),
      sharePct: total === 0 ? 0 : c.count / total * 100,
    })),
  }
}

function scoreCandidates(raster, options) {
  const crop = cropRegion(raster, options.box)
  const total = crop.width * crop.height
  const rows = options.candidates.map(text => {
    const rgb = parseHex(text)
    const histogram = new Uint32Array(256)
    for (let i = 0; i < total; i += 1) {
      const distance = Math.max(
        Math.abs(crop.data[i * 3] - rgb[0]),
        Math.abs(crop.data[i * 3 + 1] - rgb[1]),
        Math.abs(crop.data[i * 3 + 2] - rgb[2]),
      )
      histogram[distance] += 1
    }
    let weighted = 0
    let hard = 0
    let distanceSum = 0
    for (let d = 0; d < 256; d += 1) {
      const count = histogram[d]
      distanceSum += d * count
      if (d <= options.tolerance) hard += count
      if (options.tolerance - d > 0) weighted += (options.tolerance - d) * count
    }
    return {
      color: text,
      rgb,
      sharePct: hard / total * 100,
      meanDistance: distanceSum / total,
      weighted,
      hard,
    }
  })

  const winner = rows.reduce((best, row) => (
    row.weighted > best.weighted || (row.weighted === best.weighted && row.hard > best.hard) ? row : best
  ))
  const closest = rows.reduce((best, row) => (row.meanDistance < best.meanDistance ? row : best))
  const maxWeighted = Math.max(...rows.map(r => r.weighted))
  return {
    sampledPixels: total,
    candidates: rows.map(row => ({
      color: row.color,
      sharePct: row.sharePct,
      meanDistance: row.meanDistance,
      weightedScorePct: maxWeighted === 0 ? 0 : row.weighted / maxWeighted * 100,
      winner: row === winner,
    })),
    winner: winner.color,
    matchedWithinTolerance: winner.hard > 0,
    closestCandidate: closest.color,
    ...(winner.hard > 0
      ? {}
      : { note: `no candidate is within distance <= ${options.tolerance} of the region; closest by mean distance is ${closest.color}` }),
  }
}

export const dominantColorsTool = {
  name: 'vision_dominant_colors',
  description:
    'Measure significant colors in an image region, or score an explicit #RRGGBB candidate palette and select the pixel-backed winner. '
    + 'Returns structured rows, not prose.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      image: { type: 'string', description: 'Image path (PNG).' },
      region: { type: 'string', description: 'Pixel box to analyse as X1,Y1,X2,Y2; default the whole image.' },
      candidates: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional 1-32 candidate #RRGGBB colors; omission extracts a palette.',
      },
      top: { type: 'integer', description: 'How many significant clusters to report; default 5.' },
      quantize: { type: 'integer', description: 'Palette size before merging near-duplicates; default 16.' },
      maxPixels: { type: 'integer', description: 'Downsample the region to at most this on the long side; default 96.' },
      mergeTolerance: { type: 'integer', description: 'Merge clusters within this per-channel distance; default 8.' },
      candidateTolerance: { type: 'integer', description: 'Candidate mode: per-channel distance counted as a match; default 16.' },
    },
    required: ['image'],
  },
  pathParams: { image: 'read' },
  concurrencySafe: true,
  timeoutMs: 60000,
  async execute(call) {
    const args = call.args
    const image = loadRgb(args.image)
    const box = args.region === undefined
      ? { x1: 0, y1: 0, x2: image.width, y2: image.height }
      : parseRegion(args.region, image.width, image.height)

    const candidates = args.candidates
    if (candidates !== undefined && (candidates.length < 1 || candidates.length > 32)) {
      return { content: 'vision_dominant_colors: candidates must hold 1-32 #RRGGBB colors', isError: true }
    }

    const top = args.top === undefined ? 5 : args.top
    const mergeTolerance = args.mergeTolerance === undefined ? 8 : args.mergeTolerance

    const analysis = candidates === undefined
      ? {
        mode: 'palette',
        region: { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 },
        width: box.x2 - box.x1,
        height: box.y2 - box.y1,
        requestedTop: top,
        mergeTolerance,
        ...extractPalette(image, {
          box,
          top,
          quantize: args.quantize === undefined ? 16 : args.quantize,
          maxPixels: args.maxPixels === undefined ? 96 : args.maxPixels,
          mergeTolerance,
        }),
      }
      : {
        mode: 'candidates',
        region: { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 },
        width: box.x2 - box.x1,
        height: box.y2 - box.y1,
        ...scoreCandidates(image, {
          box,
          candidates,
          tolerance: args.candidateTolerance === undefined ? 16 : args.candidateTolerance,
        }),
      }

    return {
      content: JSON.stringify({
        image: { path: args.image, width: image.width, height: image.height, format: image.format, originalPath: args.image },
        analysis,
      }, null, 2),
    }
  },
}
