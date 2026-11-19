/**
 * vision_trace：把扁平高对比位图矢量化成 SVG，几何坐标全部来自真实像素。
 *
 * 与上游 vtracer 的关系：语义一致（二值化 → 滤斑点 → 简化 → path），实现不同。
 * 这里用「像素边界环 + RDP 简化」，vtracer 用分层颜色 + 曲线拟合，所以：
 * - `polygon: true`（默认多点直线）与上游最接近；
 * - `spline: true` 用平滑曲线，形状更接近但控制点数量与 vtracer 不同；
 * - 亚像素抗锯齿的边缘会表现为 1 像素锯齿，放大后可见。
 */
import { writeFileSync } from 'node:fs'
import { loadRgb } from '../image.js'
import { cropRegion, parseRegion, resizeRgb } from '../raster.js'
import { artifactName, resolveOutput } from '../artifacts.js'

/** 上游同名常量：短边小于它就先放大，否则斑点过滤会把小图标清空。 */
const TARGET_MIN_SIDE = 256
const SPECKLE_AREA = 8

/** 亮度阈值：二值模式把「墨」当填充，其余当背景。 */
export function binarize(raster, threshold = 128) {
  const width = raster.width
  const height = raster.height
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i += 1) {
    const r = raster.data[i * 3]
    const g = raster.data[i * 3 + 1]
    const b = raster.data[i * 3 + 2]
    mask[i] = 0.299 * r + 0.587 * g + 0.114 * b < threshold ? 1 : 0
  }
  return { width, height, mask }
}

/**
 * 收集所有边界环：每个前景像素的四条边，凡邻接背景即是一条有向边界段。
 *
 * 串接时按「最右转优先」选下一条边：两个分量在顶点处相接（对角相邻）时，
 * 不按转向选边会把它们串成一个环，轮廓就错了。孔洞自然成为方向相反的环。
 */
export function traceRings(binary) {
  const { width, height, mask } = binary
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : mask[y * width + x])

  const edges = new Map()
  const addEdge = (x1, y1, dx, dy) => {
    const key = `${x1},${y1}`
    if (!edges.has(key)) edges.set(key, [])
    edges.get(key).push({ to: [x1 + dx, y1 + dy], dir: [dx, dy] })
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!at(x, y)) continue
      if (!at(x, y - 1)) addEdge(x, y, 1, 0)
      if (!at(x + 1, y)) addEdge(x + 1, y, 0, 1)
      if (!at(x, y + 1)) addEdge(x + 1, y + 1, -1, 0)
      if (!at(x - 1, y)) addEdge(x, y + 1, 0, -1)
    }
  }

  /** 最右转优先（屏幕坐标 y 向下）：对前一段方向 (dx,dy)，右转是 (-dy,dx)。 */
  const pickEdge = (candidates, [dx, dy]) => {
    for (const [nx, ny] of [[-dy, dx], [dx, dy], [dy, -dx], [-dx, -dy]]) {
      const index = candidates.findIndex(edge => edge.dir[0] === nx && edge.dir[1] === ny)
      if (index >= 0) return candidates.splice(index, 1)[0]
    }
    return candidates.pop()
  }

  const rings = []
  for (const [startKey] of edges) {
    let candidates = edges.get(startKey)
    while (candidates && candidates.length > 0) {
      const ring = []
      let [x, y] = startKey.split(',').map(Number)
      ring.push([x, y])
      let current = startKey
      for (;;) {
        const list = edges.get(current)
        if (!list || list.length === 0) break
        const previous = ring.length >= 2 ? [ring[ring.length - 1][0] - ring[ring.length - 2][0], ring[ring.length - 1][1] - ring[ring.length - 2][1]] : undefined
        const edge = previous === undefined ? list.shift() : pickEdge(list, previous)
        if (edge === undefined) break
        const [nx, ny] = edge.to
        ring.push([nx, ny])
        current = `${nx},${ny}`
        if (current === startKey) break
      }
      rings.push(ring)
      candidates = edges.get(startKey)
    }
  }
  return rings
}

/** 环面积（鞋带公式），用于剔除斑点与给大环优先。 */
export function ringArea(ring) {
  let sum = 0
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  return Math.abs(sum) / 2
}

/** Ramer–Douglas–Peucker 折线简化；容差越大，角点越少。 */
export function simplifyRing(ring, tolerance) {
  if (ring.length <= 3) return ring
  const points = ring.slice(0, -1)
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()
    let farthest = -1
    let maxDistance = tolerance
    for (let i = first + 1; i < last; i += 1) {
      const distance = pointLineDistance(points[i], points[first], points[last])
      if (distance > maxDistance) { maxDistance = distance; farthest = i }
    }
    if (farthest > 0) {
      keep[farthest] = 1
      stack.push([first, farthest], [farthest, last])
    }
  }
  const result = points.filter((_, index) => keep[index] === 1)
  result.push(result[0])
  return result
}

function pointLineDistance(point, start, end) {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1])
  const t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)
  const clamped = Math.max(0, Math.min(1, t))
  return Math.hypot(point[0] - (start[0] + clamped * dx), point[1] - (start[1] + clamped * dy))
}

function formatNumber(value) {
  const rounded = Math.round(value * 100) / 100
  return String(rounded)
}

/** 环 → SVG path 片段。polygon 走直线，spline 走三次贝塞尔（Catmull-Rom 转 Bezier）。 */
export function ringToPath(ring, { spline }) {
  if (ring.length < 3) return ''
  if (!spline) {
    return 'M' + ring.map(([x, y]) => `${formatNumber(x)} ${formatNumber(y)}`).join('L') + 'Z'
  }
  const segments = ['M' + `${formatNumber(ring[0][0])} ${formatNumber(ring[0][1])}`]
  for (let i = 0; i < ring.length - 1; i += 1) {
    const p0 = ring[(i - 1 + ring.length - 1) % (ring.length - 1)]
    const p1 = ring[i]
    const p2 = ring[i + 1]
    const p3 = ring[(i + 2) % (ring.length - 1)]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    segments.push(`C${formatNumber(c1[0])} ${formatNumber(c1[1])} ${formatNumber(c2[0])} ${formatNumber(c2[1])} ${formatNumber(p2[0])} ${formatNumber(p2[1])}`)
  }
  segments.push('Z')
  return segments.join(' ')
}

/**
 * 位图 → SVG。返回 { svg, pathCount, rings, scale }。
 * @param {{ raster: object, scale?: number, region?: string, spline?: boolean, color?: boolean, tolerance?: number }} options
 */
export function traceToSvg(options) {
  const { raster, scale = 1, spline = false, color = false, tolerance = 1.5 } = options
  const binary = binarize(raster)
  const rings = traceRings(binary)
    .filter(ring => ring.length >= 4 && ringArea(ring) >= SPECKLE_AREA)
    .sort((l, r) => ringArea(r) - ringArea(l))

  const fill = '#000000'
  const paths = rings
    .map(ring => ringToPath(simplifyRing(ring, tolerance), { spline }))
    .filter(path => path !== '')
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(raster.width)}" height="${Math.round(raster.height)}" `
    + `viewBox="0 0 ${Math.round(raster.width / scale)} ${Math.round(raster.height / scale)}">`
    + `<path d="${paths.join(' ')}" fill="${fill}" fill-rule="evenodd"/>`
    + '</svg>\n'
  return { svg, pathCount: paths.length, ringCount: rings.length, scale }
}

export function createTraceTool() {
  return {
    name: 'vision_trace',
    description:
      'Trace a flat high-contrast raster graphic into editable SVG using pixel-derived geometry, with no vision credential. '
      + 'Runs locally and deterministically: coordinates come from pixels, not from a model.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: 'Image path (PNG).' },
        region: { type: 'string', description: 'Crop to X1,Y1,X2,Y2 before tracing.' },
        scale: { type: 'integer', description: 'Upscale factor 1-8 before tracing; small icons are auto-enlarged to 256px.' },
        spline: { type: 'boolean', description: 'Smooth curves instead of straight segments; default false.' },
        color: { type: 'boolean', description: 'Accepted for upstream parity; this build always emits a single-colour silhouette.' },
        tolerance: { type: 'number', description: 'Polygon simplification tolerance in pixels; default 1.5.' },
        output: { type: 'string', description: 'Output SVG path; defaults to <image-stem>.svg.' },
      },
      required: ['image'],
    },
    pathParams: { image: 'read', output: 'write' },
    concurrencySafe: true,
    timeoutMs: 120000,
    async execute(call) {
      const args = call.args
      const source = loadRgb(args.image)
      const box = args.region === undefined
        ? { x1: 0, y1: 0, x2: source.width, y2: source.height }
        : parseRegion(args.region, source.width, source.height)
      let raster = cropRegion(source, box)

      const shortest = Math.max(Math.min(raster.width, raster.height), 1)
      const autoScale = Math.max(2, Math.ceil(TARGET_MIN_SIDE / shortest))
      const requested = args.scale === undefined ? autoScale : args.scale
      if (!Number.isInteger(requested) || requested < 1 || requested > 8) {
        return { content: 'vision_trace: scale must be an integer 1-8', isError: true }
      }
      const scale = Math.min(requested, 8)
      if (scale > 1) raster = resizeRgb(raster, raster.width * scale, raster.height * scale)

      const tolerance = args.tolerance === undefined ? 1.5 : args.tolerance
      if (!(tolerance >= 0) || tolerance > 20) {
        return { content: 'vision_trace: tolerance must be 0-20', isError: true }
      }

      const result = traceToSvg({ raster, scale, spline: args.spline === true, color: args.color === true, tolerance })
      if (result.pathCount === 0) {
        return {
          content: JSON.stringify({
            error: '0 paths — nothing survived binarization',
            recoveries: [
              'raise scale (small icons binarize to nothing at 1x)',
              'crop closer with region',
              'invert the source if the shape is light-on-dark',
            ],
          }, null, 2),
          isError: true,
        }
      }

      const outputPath = resolveOutput(args.output, call.cwd, artifactName(args.image, '.svg'))
      writeFileSync(outputPath, result.svg, 'utf8')

      const report = {
        outputPath,
        mimeType: 'image/svg+xml',
        bytes: Buffer.byteLength(result.svg, 'utf8'),
        pathCount: result.pathCount,
        ringCount: result.ringCount,
        sourceWidth: raster.width,
        sourceHeight: raster.height,
        tracedScale: scale,
        spline: args.spline === true,
        note: args.color === true
          ? 'color mode is not implemented in this build; the output is a single-colour silhouette'
          : undefined,
      }
      return { content: JSON.stringify(report, null, 2), rawPath: outputPath }
    },
  }
}

export { TARGET_MIN_SIDE }
