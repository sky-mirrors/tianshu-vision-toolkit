/**
 * 定位：把「找到这个东西」翻译成一次视觉调用，再把模型给的回包解析成像素框。
 *
 * 语义对齐上游 `ground.py`：模型返回 0-1000 网格上的 box_2d，按 box 顺序换回像素；
 * 支持 ```json 围栏、被截断的 JSON、以及正则兜底；框越界或反向一律拒绝。
 */
import { loadRgb } from '../image.js'
import { assertReadableImagePath } from '../path-guard.js'
import { cropRegion, parseRegion } from '../raster.js'
import { encodePng } from '../png.js'
import { fileToDataUrl } from '../vision/client.js'
import { prepareForModel } from '../vision/prepare.js'
import { describeImages } from '../vision/client.js'

export const DEFAULT_CATEGORY = 'UI element (buttons, links, inputs, icons, labels, headings, images, badges)'

/** box 顺序：显式配置优先；否则 Qwen 系是 xyxy，其余按 yxyx。 */
export function coordinateOrder(env = process.env, model = '') {
  const configured = (env.VISION_BOX_ORDER ?? '').trim().toLowerCase()
  if (configured) {
    if (configured !== 'xyxy' && configured !== 'yxyx') {
      throw new Error('VISION_BOX_ORDER must be either xyxy or yxyx')
    }
    return configured
  }
  return model.toLowerCase().includes('qwen') ? 'xyxy' : 'yxyx'
}

export function buildLocatePrompt(target, boxOrder = 'yxyx') {
  const coordinates = boxOrder === 'xyxy' ? '[x0, y0, x1, y1]' : '[y0, x0, y1, x1]'
  return 'Locate every visible object or region matching this target:\n'
    + `${target}\n\n`
    + 'Return only a JSON array. Each item must contain "box_2d" as '
    + `${coordinates} on a 0-1000 grid and "label" as a short description. `
    + 'Use tight boxes in the original image. Return [] when nothing matches.'
}

/** detect 的 target 归一：补「every distinct」，并要求标签里带准确文字。 */
export function buildCategoryTarget(category) {
  let target = (category ?? DEFAULT_CATEGORY).trim()
  if (!target.toLowerCase().startsWith('every distinct ')) target = `every distinct ${target}`
  if (!target.toLowerCase().includes('exact visible text')) target += ' — include the exact visible text in each label'
  return target
}

function jsonText(text) {
  const cleaned = String(text ?? '').trim()
  const fenced = [...cleaned.matchAll(/```(?:json)?\s*(.*?)\s*```/gis)]
  return (fenced.length > 0 ? fenced[fenced.length - 1][1] : cleaned).trim()
}

function hasUnclosedJson(text) {
  const start = Math.min(...[text.indexOf('['), text.indexOf('{')].filter(p => p >= 0), Infinity)
  if (!Number.isFinite(start)) return false
  const stack = []
  let inString = false
  let escaped = false
  const pairs = { ']': '[', '}': '{' }
  for (const character of text.slice(start)) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '[' || character === '{') stack.push(character)
    else if (character === ']' || character === '}') {
      if (stack.length === 0 || stack[stack.length - 1] !== pairs[character]) return false
      stack.pop()
    }
  }
  return stack.length > 0
}

function fallbackItems(text) {
  const items = []
  const objectPattern = /{[^{}]*['"](?:box_2d|bbox_2d|box2d|bbox|box)['"]\s*:\s*\[[^\]]+\][^{}]*}/gs
  const boxPattern = /['"](?:box_2d|bbox_2d|box2d|bbox|box)['"]\s*:\s*\[([^\]]+)\]/s
  const labelPattern = /['"](?:label|caption|description)['"]\s*:\s*['"]([^'"]+)['"]/s
  for (const match of text.matchAll(objectPattern)) {
    const block = match[0]
    const boxMatch = boxPattern.exec(block)
    if (!boxMatch) continue
    const numbers = [...boxMatch[1].matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]))
    if (numbers.length < 4) continue
    const item = { box_2d: numbers.slice(0, 4) }
    const labelMatch = labelPattern.exec(block)
    if (labelMatch) item.label = labelMatch[1].trim()
    items.push(item)
  }
  return items
}

/** 模型回包 → 数组；先按 JSON 解析，失败时只有在明确未截断时才走正则兜底。 */
export function extractLocateItems(text) {
  const cleaned = jsonText(text)
  try {
    const payload = JSON.parse(cleaned)
    if (Array.isArray(payload)) return payload
    if (payload && typeof payload === 'object') {
      for (const key of ['boxes', 'bounding_boxes', 'bboxes', 'objects', 'items', 'results']) {
        if (Array.isArray(payload[key])) return payload[key]
      }
    }
    throw new Error('vision API returned an incompatible bounding-box JSON structure')
  } catch (error) {
    if (error instanceof SyntaxError) {
      if (cleaned.split('```').length % 2 === 0 || hasUnclosedJson(cleaned)) {
        throw new Error('vision API bounding-box JSON was truncated or incomplete')
      }
      const fallback = fallbackItems(cleaned)
      if (fallback.length > 0) return fallback
      throw new Error('vision API did not return parseable bounding-box JSON')
    }
    throw error
  }
}

/** 单个 item 的 0-1000 网格框 → 像素框；非法返回 null（上游同样是跳过而非报错）。 */
export function normalizeBox(item, width, height, boxOrder = 'yxyx') {
  let raw = item?.box_2d
  if (!Array.isArray(raw)) {
    for (const key of ['bbox_2d', 'box2d', 'bbox', 'box']) {
      if (Array.isArray(item?.[key])) { raw = item[key]; break }
    }
  }
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const values = raw.map(Number)
  if (values.some(v => !Number.isFinite(v))) return null
  let [x0, y0, x1, y1] = boxOrder === 'xyxy' ? values : [values[1], values[0], values[3], values[2]]
  if (x0 > x1) [x0, x1] = [x1, x0]
  if (y0 > y1) [y0, y1] = [y1, y0]
  const box = {
    x1: Math.max(0, Math.min(width, Math.round(x0 / 1000 * width))),
    y1: Math.max(0, Math.min(height, Math.round(y0 / 1000 * height))),
    x2: Math.max(0, Math.min(width, Math.round(x1 / 1000 * width))),
    y2: Math.max(0, Math.min(height, Math.round(y1 / 1000 * height))),
  }
  return box.x2 > box.x1 && box.y2 > box.y1 ? box : null
}

export function parseMatches(text, width, height, target, boxOrder = 'yxyx') {
  const matches = []
  for (const item of extractLocateItems(text)) {
    if (!item || typeof item !== 'object') continue
    const box = normalizeBox(item, width, height, boxOrder)
    if (box === null) continue
    const label = String(item.label ?? item.caption ?? item.description ?? target).trim()
    matches.push({ label: label || target, box })
  }
  return matches
}

/** 粗粒度方位（三分之一网格），便于人读。 */
export function positionOf(box, width, height) {
  const x = (box.x1 + box.x2) / 2
  const y = (box.y1 + box.y2) / 2
  const horizontal = x < width / 3 ? 'left' : (x > width * 2 / 3 ? 'right' : 'center')
  const vertical = y < height / 3 ? 'top' : (y > height * 2 / 3 ? 'bottom' : 'center')
  const positions = {
    'left-top': 'top-left', 'center-top': 'top', 'right-top': 'top-right',
    'left-center': 'left', 'center-center': 'center', 'right-center': 'right',
    'left-bottom': 'bottom-left', 'center-bottom': 'bottom', 'right-bottom': 'bottom-right',
  }
  return positions[`${horizontal}-${vertical}`]
}

/**
 * 单图 → 送模型的 data URL。超大图先压到长边 1568，并把「被分析尺寸」如实带回去。
 * 带 region 时先裁再送：用户已经限制范围，不再二次缩放，坐标关系简单。
 */
function locateImagePayload(path, region) {
  const source = loadRgb(path)
  if (region !== undefined) {
    const box = parseRegion(region, source.width, source.height)
    const cropped = cropRegion(source, box)
    return {
      url: fileToDataUrl(encodePng(rgbaOf(cropped)), 'image/png'),
      widthUsed: cropped.width,
      heightUsed: cropped.height,
      offset: box,
      originalWidth: source.width,
      originalHeight: source.height,
      scale: 1,
      compressed: false,
    }
  }
  const prepared = prepareForModel(source)
  return {
    url: fileToDataUrl(encodePng(rgbaOf(prepared)), 'image/png'),
    widthUsed: prepared.width,
    heightUsed: prepared.height,
    offset: undefined,
    originalWidth: prepared.originalWidth,
    originalHeight: prepared.originalHeight,
    scale: prepared.originalWidth / prepared.width,
    compressed: prepared.compressed,
  }
}

function rgbaOf(rgb) {
  const data = new Uint8ClampedArray(rgb.width * rgb.height * 4)
  for (let i = 0, n = rgb.width * rgb.height; i < n; i += 1) {
    data[i * 4] = rgb.data[i * 3]
    data[i * 4 + 1] = rgb.data[i * 3 + 1]
    data[i * 4 + 2] = rgb.data[i * 3 + 2]
    data[i * 4 + 3] = 255
  }
  return { width: rgb.width, height: rgb.height, data }
}

/**
 * 执行一次定位。框先在被分析尺寸上解析，再按 scale 换算回原图坐标。
 */
export async function locateImage(deps, imagePath, target, region) {
  assertReadableImagePath(imagePath)
  const payload = locateImagePayload(imagePath, region)
  const boxOrder = coordinateOrder(deps.env ?? process.env, deps.config.model)

  const answer = await describeImages(deps.config, [payload.url], {
    prompt: buildLocatePrompt(target, boxOrder),
    maxTokens: 8192,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    signal: deps.signal,
  })
  const matches = parseMatches(answer, payload.widthUsed, payload.heightUsed, target, boxOrder)
  const dx = payload.offset?.x1 ?? 0
  const dy = payload.offset?.y1 ?? 0
  const adapted = matches.map(match => ({
    label: match.label,
    box: {
      x1: Math.round(match.box.x1 * payload.scale) + dx,
      y1: Math.round(match.box.y1 * payload.scale) + dy,
      x2: Math.round(match.box.x2 * payload.scale) + dx,
      y2: Math.round(match.box.y2 * payload.scale) + dy,
    },
  }))

  return {
    matches: adapted,
    imageWidth: payload.originalWidth,
    imageHeight: payload.originalHeight,
    analyzedWidth: payload.widthUsed,
    analyzedHeight: payload.heightUsed,
    compressed: payload.compressed,
  }
}
