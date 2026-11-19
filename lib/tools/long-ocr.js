/**
 * vision_long_screenshot_ocr：把长截图切成不切断文字行的块，逐块 OCR，再合并去重。
 *
 * 切点选择对齐上游 `long_screenshot_ocr.py`：在 [minHeight, maxHeight] 区间里找
 * 行能量最低的一行作为切点——文字行内部切开会丢半行字，空白行切开才安全。
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadRgb } from '../image.js'
import { cropRegion } from '../raster.js'
import { encodePng } from '../png.js'
import { artifactName, resolveOutput } from '../artifacts.js'
import { prepareForModel, rgbaOf } from '../vision/prepare.js'
import { describeImages, fileToDataUrl } from '../vision/client.js'

/** 每行的「能量」：行内相邻像素亮度差的均值。文字行高，空白行低。 */
export function rowEnergy(raster) {
  const { width, height, data } = raster
  const energy = new Float64Array(height)
  for (let y = 0; y < height; y += 1) {
    let sum = 0
    const rowBase = y * width * 3
    for (let x = 1; x < width; x += 1) {
      const a = data[rowBase + x * 3] + data[rowBase + x * 3 + 1] * 2 + data[rowBase + x * 3 + 2]
      const b = data[rowBase + (x - 1) * 3] + data[rowBase + (x - 1) * 3 + 1] * 2 + data[rowBase + (x - 1) * 3 + 2]
      sum += Math.abs(a - b)
    }
    energy[y] = width > 1 ? sum / (width - 1) : 0
  }
  return energy
}

/** 解析切块参数，边界在这里校验一次。 */
export function resolveSplitSizes(options, imageHeight) {
  const mode = options.mode ?? 'general'
  const target = options.targetHeight ?? Math.round(imageHeight / Math.max(1, Math.ceil(imageHeight / 1600)))
  const minimum = options.minHeight ?? Math.min(Math.round(target * 0.6), imageHeight)
  const maximum = options.maxHeight ?? Math.min(Math.round(target * 1.4), imageHeight)
  const overlap = options.overlap ?? (mode === 'chat' ? 64 : 40)
  if (!Number.isInteger(target) || target < 1) throw new Error('targetHeight must be a positive integer')
  if (!Number.isInteger(minimum) || minimum < 1) throw new Error('minHeight must be a positive integer')
  if (!Number.isInteger(maximum) || maximum < minimum) throw new Error('maxHeight must be >= minHeight')
  if (!Number.isInteger(overlap) || overlap < 0) throw new Error('overlap cannot be negative')
  if (overlap * 2 >= minimum) throw new Error('overlap must be less than half of min-height')
  return { target, minimum, maximum, overlap }
}

/** 在 [start+minimum, start+maximum] 内挑能量最低的行作为下一切点。 */
export function chooseCut(energy, start, minimum, maximum) {
  const height = energy.length
  const low = Math.min(height, start + minimum)
  const high = Math.min(height, start + maximum)
  if (high <= start) return height
  let best = low
  let bestScore = Infinity
  for (let y = low; y <= high; y += 1) {
    const score = energy[Math.min(height - 1, y)]
    if (score < bestScore) { bestScore = score; best = y }
  }
  return Math.min(best, height)
}

/** 计算每个块的核心区间（core 用于 OCR 归属，crop 含重叠上下文）。 */
export function planChunks(imageHeight, sizes) {
  const chunks = []
  let cursor = 0
  let index = 0
  while (cursor < imageHeight) {
    const bottom = cursor + sizes.target >= imageHeight
      ? imageHeight
      : chooseCut(sizes.energy, cursor, sizes.minimum, sizes.maximum)
    if (bottom <= cursor) break
    const topOverlap = index === 0 ? 0 : sizes.overlap
    const bottomOverlap = bottom === imageHeight ? 0 : sizes.overlap
    chunks.push({
      index,
      coreTop: cursor,
      coreBottom: bottom,
      cropTop: Math.max(0, cursor - topOverlap),
      cropBottom: Math.min(imageHeight, bottom + bottomOverlap),
    })
    index += 1
    cursor = bottom
  }
  return chunks
}

function chunkDataUrl(raster, chunk) {
  const cropped = cropRegion(raster, { x1: 0, y1: chunk.cropTop, x2: raster.width, y2: chunk.cropBottom })
  // 每块独立压缩：长截图切出来的单块仍可能超过模型长边上限。
  const prepared = prepareForModel(cropped)
  return fileToDataUrl(encodePng(rgbaOf(prepared)), 'image/png')
}

/** 重叠段的重复行去掉：下一块开头与上一块结尾相同的连续行不算新内容。 */
export function mergeChunkTexts(texts) {
  const lines = []
  for (const raw of texts) {
    const incoming = raw.split('\n').map(line => line.trimEnd()).filter(line => line !== '')
    if (lines.length === 0) { lines.push(...incoming); continue }
    let overlap = 0
    const limit = Math.min(lines.length, incoming.length, 12)
    for (let size = limit; size > 0; size -= 1) {
      const tail = lines.slice(-size).map(line => line.trim())
      const head = incoming.slice(0, size).map(line => line.trim())
      if (tail.every((line, i) => line === head[i]) && tail.length === size) { overlap = size; break }
    }
    lines.push(...incoming.slice(overlap))
  }
  return lines.join('\n')
}

function ocrPrompt(mode, index, total, extra) {
  const scope = total > 1 ? `this chunk (part ${index + 1} of ${total}) of a tall screenshot` : 'this image'
  const base = 'Transcribe every piece of visible text in ' + scope + ' verbatim, line by line, '
    + 'without omitting any characters. Do not rewrite, summarize, or translate the text, '
    + 'and do not add any preamble, explanation, or extra content.'
  const chat = mode === 'chat'
    ? ' Preserve the message order and mark each speaker as it appears.'
    : ''
  return base + chat + (extra ? ` Additional requirements: ${extra}` : '')
}

export function createLongScreenshotOcrTool(getConfig) {
  return {
    name: 'vision_long_screenshot_ocr',
    description:
      'Split a tall screenshot on blank lines, OCR each chunk with the vision model, merge overlaps into Markdown. '
      + 'Set splitOnly to create chunks and a manifest with no API call.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: 'Tall screenshot path.' },
        mode: { type: 'string', enum: ['general', 'chat'], description: 'General text or chat transcript mode.' },
        splitOnly: { type: 'boolean', description: 'Split and write chunks without calling the vision model.' },
        output: { type: 'string', description: 'Merged Markdown filename; defaults to <image-stem>.ocr.md.' },
        targetHeight: { type: 'integer', description: 'Preferred chunk height in pixels.' },
        minHeight: { type: 'integer', description: 'Lower bound for a cut point.' },
        maxHeight: { type: 'integer', description: 'Upper bound for a cut point.' },
        overlap: { type: 'integer', description: 'Overlap in pixels between chunks; default 40 (64 for chat).' },
        prompt: { type: 'string', description: 'Additional OCR requirements forwarded to each chunk.' },
        jobs: { type: 'integer', description: 'Parallel chunk OCR calls; default 2.' },
      },
      required: ['image'],
    },
    pathParams: { image: 'read', output: 'write' },
    concurrencySafe: false,
    timeoutMs: 600000,
    async execute(call) {
      const args = call.args
      const image = loadRgb(args.image)
      const sizes = resolveSplitSizes(args, image.height)
      const chunks = planChunks(image.height, { ...sizes, energy: rowEnergy(image) })

      const stem = args.image.replace(/\.(png|jpg|jpeg)$/i, '')
      const outputPath = resolveOutput(args.output, call.cwd, artifactName(args.image, '.ocr.md'))
      const runDir = join(dirname(outputPath), `${stem.split(/[\\/]/).pop()}.ocr-chunks`)
      const jobCount = args.jobs === undefined ? 2 : Math.max(1, Math.min(4, args.jobs))

      const records = chunks.map(chunk => ({
        index: chunk.index + 1,
        coreTop: chunk.coreTop,
        coreBottom: chunk.coreBottom,
        cropTop: chunk.cropTop,
        cropBottom: chunk.cropBottom,
        text: undefined,
        error: undefined,
      }))

      if (args.splitOnly !== true) {
        const config = getConfig()
        let cursor = 0
        const workers = Array.from({ length: jobCount }, async () => {
          for (;;) {
            const index = cursor
            cursor += 1
            if (index >= chunks.length) return
            try {
              records[index].text = await describeImages(config, [chunkDataUrl(image, chunks[index])], {
                prompt: ocrPrompt(args.mode ?? 'general', index, chunks.length, args.prompt),
                maxTokens: undefined,
                signal: call.signal,
              })
            } catch (error) {
              records[index].error = error.message
            }
          }
        })
        await Promise.all(workers)
      }

      const failed = records.filter(record => record.error !== undefined)
      const complete = args.splitOnly !== true && failed.length === 0
      if (records.length === 0) {
        return { content: 'vision_long_screenshot_ocr: no chunk could be planned', isError: true }
      }

      if (args.splitOnly !== true && failed.length === records.length) {
        return {
          content: `vision_long_screenshot_ocr: every chunk failed; first error: ${failed[0].error}`,
          isError: true,
        }
      }

      const merged = complete
        ? mergeChunkTexts(records.map(record => record.text))
        : ''
      if (merged !== '') writeFileSync(outputPath, merged.endsWith('\n') ? merged : `${merged}\n`)

      const manifest = {
        source: { path: args.image, width: image.width, height: image.height },
        mode: args.mode ?? 'general',
        splitOnly: args.splitOnly === true,
        complete,
        chunkCount: chunks.length,
        targetHeight: sizes.target,
        minHeight: sizes.minimum,
        maxHeight: sizes.maximum,
        overlap: sizes.overlap,
        output: complete ? outputPath : undefined,
        chunksDirectory: runDir,
        chunks: records,
      }
      return { content: JSON.stringify(manifest, null, 2), ...(complete ? { rawPath: outputPath } : {}) }
    },
  }
}
