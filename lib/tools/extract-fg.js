/**
 * vision_extract_foreground：从截图里抠出图标/logo 前景，输出透明 PNG。
 *
 * 语义对齐上游 `extract_fg.py`：按饱和/暗度判定「墨迹」，做 8 邻域连通分量，
 * 保留足够大的分量（以及所有与主框重叠的子形状），再从边缘 flood fill 把外部背景
 * 变透明、被前景包围的近白镂空保留为纯白。
 */
import { writeFileSync } from 'node:fs'
import { loadRgb } from '../image.js'
import { encodePng } from '../png.js'
import { artifactName, resolveOutput } from '../artifacts.js'

/** 8 邻域连通分量，按像素数降序。 */
export function connectedComponents(ink, width, height) {
  const inkSet = new Set(ink.map(point => point.y * width + point.x))
  const visited = new Uint8Array(width * height)
  const components = []
  for (const start of ink) {
    const startIndex = start.y * width + start.x
    if (visited[startIndex]) continue
    visited[startIndex] = 1
    const stack = [start]
    const pixels = []
    while (stack.length > 0) {
      const point = stack.pop()
      pixels.push(point)
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const nx = point.x + dx
          const ny = point.y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const index = ny * width + nx
          if (visited[index] || !inkSet.has(index)) continue
          visited[index] = 1
          stack.push({ x: nx, y: ny })
        }
      }
    }
    components.push({ pixels, size: pixels.length })
  }
  components.sort((l, r) => r.size - l.size)
  return components
}

function colorAt(raster, x, y) {
  const index = (y * raster.width + x) * 3
  return [raster.data[index], raster.data[index + 1], raster.data[index + 2]]
}

function parseHexColor(text) {
  const value = String(text).trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(value)) throw new Error(`excludeColor must be #RRGGBB, got ${JSON.stringify(text)}`)
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)]
}

/** 判定墨迹：颜色模式看饱和度，暗色模式看亮度；exclude 颜色再排除一层。 */
function buildInk(raster, box, options) {
  const ink = []
  for (let y = box.y1; y < box.y2; y += 1) {
    for (let x = box.x1; x < box.x2; x += 1) {
      const [r, g, b] = colorAt(raster, x, y)
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      if (options.mode === 'color') {
        if (max - min <= options.sat) continue
      } else if (max >= options.dark) {
        continue
      }
      if (options.exclude !== undefined) {
        const distance = Math.hypot(r - options.exclude[0], g - options.exclude[1], b - options.exclude[2])
        if (distance <= options.excludeTolerance) continue
      }
      ink.push({ x: x - box.x1, y: y - box.y1 })
    }
  }
  return ink
}

/** 自动模式：用中心圆环的均值作为要排除的底色。 */
function inferDiscExclude(raster, radiusHint) {
  const cx = raster.width / 2
  const cy = raster.height / 2
  const radius = radiusHint ?? Math.min(raster.width, raster.height) / 2 * 0.6
  const samples = []
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const distance = Math.hypot(x - cx, y - cy)
      if (distance > radius * 0.75 && distance < radius * 0.95) samples.push(colorAt(raster, x, y))
    }
  }
  if (samples.length === 0) throw new Error('disc ring empty (discRadius too small?)')
  return [0, 1, 2].map(channel => Math.round(samples.reduce((sum, pixel) => sum + pixel[channel], 0) / samples.length))
}

export function createExtractForegroundTool() {
  return {
    name: 'vision_extract_foreground',
    description:
      'Extract a connected icon/logo foreground with the upstream algorithm and deliver a transparent PNG. '
      + 'Ink is saturation (color mode) or darkness (dark mode); noise specks drop, sub-shapes stay.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: 'Screenshot path (PNG).' },
        region: { type: 'string', description: 'Foreground region X1,Y1,X2,Y2; omit for automatic disc mode.' },
        mode: { type: 'string', enum: ['color', 'dark'], description: 'color = saturated pixels (default), dark = dark lines for grey logos.' },
        sat: { type: 'integer', description: 'Color mode: minimum max-minus-min channel spread; default 12.' },
        dark: { type: 'integer', description: 'Dark mode: maximum channel value counted as ink; default 215.' },
        excludeColor: { type: 'string', description: 'Background colour to exclude, #RRGGBB.' },
        excludeTolerance: { type: 'number', description: 'Distance under which the exclude colour is dropped; default 24.' },
        pad: { type: 'integer', description: 'Pixels added around the output bbox; default 3.' },
        keepWhites: { type: 'boolean', description: 'Keep white holes enclosed by foreground; default true.' },
        output: { type: 'string', description: 'Output PNG path; defaults to <image-stem>.fg.png.' },
      },
      required: ['image'],
    },
    pathParams: { image: 'read', output: 'write' },
    concurrencySafe: true,
    timeoutMs: 120000,
    async execute(call) {
      const args = call.args
      const raster = loadRgb(args.image)
      const autoMode = args.region === undefined

      const box = autoMode
        ? { x1: 0, y1: 0, x2: raster.width, y2: raster.height }
        : parseBox(args.region, raster.width, raster.height)

      const exclude = autoMode
        ? inferDiscExclude(raster, args.discRadius)
        : (args.excludeColor === undefined ? undefined : parseHexColor(args.excludeColor))
      const excludeTolerance = autoMode ? 35 : (args.excludeTolerance ?? 24)

      const options = {
        mode: args.mode ?? 'color',
        sat: args.sat ?? 12,
        dark: args.dark ?? 215,
        exclude,
        excludeTolerance,
      }
      const ink = buildInk(raster, box, options)
      if (ink.length === 0) {
        return {
          content: 'vision_extract_foreground: no foreground pixels found (raise sat or lower dark?)',
          isError: true,
        }
      }

      const components = connectedComponents(ink, box.x2 - box.x1, box.y2 - box.y1)
      const mainBox = boundsOf(components[0].pixels)
      const minimum = Math.max(components[0].size * 0.02, 8)
      const kept = components.filter(component => component.size >= minimum || overlaps(component.pixels, mainBox))

      let chosen
      if (autoMode) {
        const colored = kept
          .map(component => {
            const n = component.size
            const sums = component.pixels.reduce((acc, p) => {
              const [r, g, b] = colorAt(raster, box.x1 + p.x, box.y1 + p.y)
              return [acc[0] + r, acc[1] + g, acc[2] + b]
            }, [0, 0, 0])
            const means = sums.map(sum => sum / n)
            return { component, size: n, sat: Math.max(...means) - Math.min(...means) }
          })
          .filter(entry => entry.sat > 25)
          .sort((l, r) => r.size - l.size)
        chosen = (colored.length > 0
          ? colored.slice(0, 3).reduce((best, entry) => (entry.sat > best.sat ? entry : best)).component
          : components[0])
      } else {
        chosen = { pixels: kept.flatMap(component => component.pixels), size: kept.reduce((sum, c) => sum + c.size, 0) }
      }

      const pixels = chosen.pixels
      const pad = autoMode ? 0 : (args.pad ?? 3)
      const minX = Math.min(...pixels.map(p => p.x))
      const minY = Math.min(...pixels.map(p => p.y))
      const maxX = Math.max(...pixels.map(p => p.x))
      const maxY = Math.max(...pixels.map(p => p.y))
      const originX = box.x1 + minX - pad
      const originY = box.y1 + minY - pad
      const outWidth = Math.min(raster.width, maxX + 1 + pad) - Math.max(0, originX)
      const outHeight = Math.min(raster.height, maxY + 1 + pad) - Math.max(0, originY)
      const clampedX = Math.max(0, originX)
      const clampedY = Math.max(0, originY)

      const output = new Uint8ClampedArray(outWidth * outHeight * 4)
      for (const point of pixels) {
        const sx = box.x1 + point.x
        const sy = box.y1 + point.y
        const dx = sx - clampedX
        const dy = sy - clampedY
        if (dx < 0 || dy < 0 || dx >= outWidth || dy >= outHeight) continue
        const [r, g, b] = colorAt(raster, sx, sy)
        const di = (dy * outWidth + dx) * 4
        output[di] = r
        output[di + 1] = g
        output[di + 2] = b
        output[di + 3] = 255
      }

      if (args.keepWhites !== false) fillBackgroundWhites(output, outWidth, outHeight)

      const outputPath = resolveOutput(args.output, call.cwd, artifactName(args.image, '.fg.png'))
      writeFileSync(outputPath, encodePng({ width: outWidth, height: outHeight, data: output }))

      const report = {
        outputPath,
        mimeType: 'image/png',
        width: outWidth,
        height: outHeight,
        bbox: { x1: clampedX, y1: clampedY, x2: clampedX + outWidth, y2: clampedY + outHeight },
        inkPixels: pixels.length,
        components: kept.length,
        mode: autoMode ? 'auto' : (args.mode ?? 'color'),
        ...(exclude === undefined ? {} : { excludeColor: `#${exclude.map(v => v.toString(16).padStart(2, '0').toUpperCase()).join('')}` }),
      }
      return { content: JSON.stringify(report, null, 2), rawPath: outputPath }
    },
  }
}

function parseBox(region, width, height) {
  const parts = String(region).split(',').map(v => Number(v.trim()))
  if (parts.length !== 4 || parts.some(v => !Number.isInteger(v))) {
    throw new Error(`region expects four integers X1,Y1,X2,Y2 (pixels); got ${JSON.stringify(region)}`)
  }
  const [x1raw, y1raw, x2raw, y2raw] = parts
  const x1 = Math.max(0, Math.min(x1raw, x2raw))
  const y1 = Math.max(0, Math.min(y1raw, y2raw))
  const x2 = Math.min(width, Math.max(x1raw, x2raw))
  const y2 = Math.min(height, Math.max(y1raw, y2raw))
  if (x2 <= x1 || y2 <= y1) throw new Error(`region ${region} is empty after clamping to ${width}x${height}`)
  return { x1, y1, x2, y2 }
}

function boundsOf(pixels) {
  return {
    x1: Math.min(...pixels.map(p => p.x)),
    y1: Math.min(...pixels.map(p => p.y)),
    x2: Math.max(...pixels.map(p => p.x)),
    y2: Math.max(...pixels.map(p => p.y)),
  }
}

function overlaps(pixels, box) {
  const own = boundsOf(pixels)
  return !(own.x2 < box.x1 || own.x1 > box.x2 || own.y2 < box.y1 || own.y1 > box.y2)
}

/** 从图像边缘 flood fill：连到边缘的近白像素变透明，内部镂空留白。 */
function fillBackgroundWhites(data, width, height) {
  const nearWhite = index => data[index] > 235 && data[index + 1] > 235 && data[index + 2] > 235 && data[index + 3] === 255
  const visited = new Uint8Array(width * height)
  const queue = []
  for (let x = 0; x < width; x += 1) {
    queue.push({ x, y: 0 }, { x, y: height - 1 })
  }
  for (let y = 0; y < height; y += 1) {
    queue.push({ x: 0, y }, { x: width - 1, y })
  }
  while (queue.length > 0) {
    const point = queue.pop()
    if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) continue
    const index = point.y * width + point.x
    if (visited[index]) continue
    visited[index] = 1
    if (!nearWhite(index * 4)) continue
    data[index * 4 + 3] = 0
    queue.push({ x: point.x + 1, y: point.y }, { x: point.x - 1, y: point.y })
    queue.push({ x: point.x, y: point.y + 1 }, { x: point.x, y: point.y - 1 })
  }
}
